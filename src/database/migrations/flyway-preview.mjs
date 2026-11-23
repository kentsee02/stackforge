import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { throwIfCancelled } from '../../platform/process.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { discoverDatabases } from '../discovery.mjs';
import { readMigrationFile } from './migration-files.mjs';

const kinds = { V: 'versioned', R: 'repeatable', B: 'baseline', U: 'undo' };
const priority = { versioned: 0, repeatable: 1, baseline: 2, undo: 3 };
export const flywayChecksum = sql => crc32(Buffer.from(sql.replace(/^\uFEFF/, '').replace(/[\r\n]/g, ''))) | 0;
export const versionKey = version => {
  if (typeof version !== 'string' || !/^\d+(?:[._]\d+)*$/.test(version)) return;
  const segments = version.split(/[._]/).map(part => part.replace(/^0+(?=\d)/, ''));
  while (segments.length > 1 && segments.at(-1) === '0') segments.pop();
  return segments.join('.');
};

function migrationFile(filename, file) {
  // Flyway treats dots and underscores alike and compares numeric version segments.
  const versioned = /^([VBU])(\d+(?:[._]\d+)*)__([^/\\\x00-\x1f\x7f]+)\.sql$/u.exec(filename);
  const repeatable = /^R__([^/\\\x00-\x1f\x7f]+)\.sql$/u.exec(filename);
  if (!versioned && !repeatable || filename.length > 240) return;
  const kind = versioned ? kinds[versioned[1]] : kinds.R;
  const version = versioned?.[2];
  const segments = versionKey(version)?.split('.');
  const description = (versioned?.[3] ?? repeatable[1]).replaceAll('_', ' ').trim();
  if (!description) return;
  return { kind, version, file, description, segments, verified: true };
}

function compareVersion(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? '0', right = b[index] ?? '0';
    if (left.length !== right.length) return left.length - right.length;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

async function migrationFiles(root, locations, signal) {
  const pending = locations.map(directory => ({ directory, depth: 0 }));
  const seen = new Set(), files = [];
  let inspected = 0, limited = false, unrecognized = 0;
  for (const { directory, depth } of pending) {
    throwIfCancelled(signal);
    if (seen.has(directory)) continue;
    seen.add(directory);
    const folder = join(root, directory);
    const before = await lstat(folder, { bigint: true }).catch(() => null);
    if (!before?.isDirectory() || await realpath(folder).catch(() => '') !== folder) { limited = true; continue; }
    const listing = await opendir(folder).catch(() => null);
    if (!listing) { limited = true; continue; }
    try {
      for await (const entry of listing) {
        throwIfCancelled(signal);
        if (++inspected > 1536 || files.length >= 250) return { files, limited: true, unrecognized };
        if (entry.name.startsWith('.') || /[\x00-\x1f\x7f]/.test(entry.name)) continue;
        if (entry.isSymbolicLink()) { limited = true; continue; }
        const file = directory + '/' + entry.name;
        if (entry.isDirectory()) {
          if (depth < 8) pending.push({ directory: file, depth: depth + 1 });
          else limited = true;
        } else if (entry.isFile() && /\.sql$/i.test(entry.name)) {
          const migration = migrationFile(entry.name, file);
          if (migration) files.push(migration);
          else unrecognized++;
        }
      }
      const after = await lstat(folder, { bigint: true });
      limited ||= before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      limited = true;
    }
  }
  return { files, limited, unrecognized };
}

export async function previewFlyway(project, sourceId, signal, { history = false, scanned } = {}) {
  const invalid = 'Choose a detected Flyway configuration.';
  if (typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(sourceId)) throw new Error(invalid);
  throwIfCancelled(signal);
  const { root, identity, migrationSources } = scanned ?? await discoverDatabases(project, { includeMigrations: true });
  throwIfCancelled(signal);
  const config = migrationSources.find(item => item.adapter === 'flyway' && item.id === sourceId);
  if (!config) throw new Error(invalid);
  const { source, directory, profile, scope, locations, disabled } = config;
  const base = { source, scope, profile, locations: [], migrations: [] };
  if (disabled) return { ...base, status: 'disabled' };
  if (!locations?.length) return { ...base, status: 'unsupported-config' };
  const paths = locations.map(path => directory === '.' ? path : directory + '/' + path);
  const { files, limited, unrecognized } = await migrationFiles(root, paths, signal);
  await resolveStartup(project, [], identity);
  const grouped = new Map();
  for (const migration of files) {
    const key = migration.kind + ':' + (migration.segments?.join('.') ?? migration.description);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(migration);
  }
  const duplicates = [...grouped.values()].filter(group => group.length > 1);
  for (const group of duplicates) for (const migration of group) migration.verified = false;
  files.sort((a, b) => priority[a.kind] - priority[b.kind] ||
    (a.segments && b.segments ? compareVersion(a.segments, b.segments) : a.description.localeCompare(b.description)) || a.file.localeCompare(b.file));
  const status = limited || unrecognized || duplicates.length ? 'partial' : files.length ? 'ready' : 'empty';
  const migrations = files.map(({ segments, ...file }) => file);
  const result = { ...base, status, locations: paths, limited, unrecognized, migrations };
  if (!history) return result;
  const checksums = new Map();
  let budget = 8 * 1024 * 1024;
  for (const item of migrations) {
    throwIfCancelled(signal);
    if (budget <= 0 || !item.verified) break;
    try {
      const sql = await readMigrationFile(join(root, item.file), Math.min(budget, 512 * 1024));
      budget -= Buffer.byteLength(sql);
      // Repeatable migrations may use environment-specific placeholder replacement.
      if (item.kind === 'repeatable' && /\$\{|#\{/.test(sql)) continue;
      checksums.set(basename(item.file), flywayChecksum(sql));
    } catch { /* Unsupported encodings and replaced files leave the checksum unverified. */ }
  }
  await resolveStartup(project, [], identity);
  return { result, checksums };
}
