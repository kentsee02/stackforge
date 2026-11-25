import { join } from 'node:path';
import { databaseKey } from '../discovery.mjs';
import { readMigrationFile } from './migration-files.mjs';

const invalid = 'Choose a project-relative Alembic lock file with exact package versions and SHA-256 wheel hashes.';
const corePackages = new Set(['alembic', 'pip', 'psycopg', 'psycopg-binary', 'setuptools', 'sqlalchemy', 'sqlmodel']);
const requirement = /^([a-z\d](?:[a-z\d._-]{0,98}[a-z\d])?)\s*==\s*([\d][a-z\d.!+_-]{0,95})\s+((?:--hash=sha256:[a-f\d]{64}(?:\s+|$))+)$/i;

export async function readAlembicDependencyLock(root, path) {
  if (path === undefined) return;
  if (typeof path !== 'string' || path.length > 240 || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(path) ||
      path.split('/').some(part => part === '.' || part === '..' || part.toLowerCase() === '.git') ||
      !/\.(?:txt|lock)$/i.test(path)) throw new Error(invalid);
  let text;
  try { text = await readMigrationFile(join(root, path), 64 * 1024); }
  catch { throw new Error(invalid); }
  const lines = text.replace(/^\uFEFF/, '').replace(/\\[ \t]*\r?\n/g, ' ').split(/\r?\n/);
  const names = new Set();
  const packages = [];
  const entries = [];
  for (const line of lines) {
    const value = line.replace(/(?:^|[ \t]+)#.*$/, '').trim();
    if (!value) continue;
    const match = requirement.exec(value);
    if (!match || packages.length >= 64) throw new Error(invalid);
    const [, name, version, hashes] = match;
    const canonical = name.toLowerCase().replace(/[-_.]+/g, '-');
    if (corePackages.has(canonical) || names.has(canonical)) throw new Error(invalid);
    names.add(canonical);
    const pinned = canonical + '==' + version;
    packages.push({ name: canonical, version });
    entries.push(pinned + ' ' + hashes.toLowerCase().trim().replace(/\s+/g, ' '));
  }
  if (!packages.length) throw new Error(invalid);
  return { path, packages, requirements: entries.join('\n') + '\n', fingerprint: databaseKey(path, text) };
}
