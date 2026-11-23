import { lstat, opendir, realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { throwIfCancelled } from '../../platform/process.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { discoverDatabases } from '../discovery.mjs';
import { readMigrationFile } from './migration-files.mjs';
import { parseLiquibaseChangelog } from './liquibase-changelog.mjs';
import { changelogExtension, localResource } from './liquibase-config.mjs';

const literal = value => {
  const text = Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text === 'string' && text.trim() && text.length <= 240 && !/[\x00-\x1f\x7f]|\$\{/.test(text)) return text;
};

function flag(attributes, key, fallback) {
  if (!Object.hasOwn(attributes, key)) return fallback;
  const raw = attributes[key];
  if (typeof raw === 'boolean') return raw;
  const value = typeof raw === 'string' && raw.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
}

function includeDepth(attributes, key, fallback) {
  if (!Object.hasOwn(attributes, key)) return fallback;
  const raw = attributes[key];
  const value = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : '';
  if (/^\d{1,5}$/.test(value) && Number(value) >= 1) return Number(value);
}

async function includedFiles(root, directory, attributes, budget, signal) {
  const files = [];
  const min = includeDepth(attributes, 'minDepth', 1);
  const max = includeDepth(attributes, 'maxDepth', Infinity);
  const suffix = Object.hasOwn(attributes, 'endsWithFilter') ? literal(attributes.endsWithFilter) : '';
  const mandatory = flag(attributes, 'errorIfMissingOrEmpty', true);
  if (!min || !max || min > max || suffix === undefined || mandatory === undefined ||
      Object.hasOwn(attributes, 'filter') || Object.hasOwn(attributes, 'resourceComparator')) return { files, partial: true };
  const pending = [{ directory, depth: 1 }];
  let partial = false;
  for (const entry of pending) {
    throwIfCancelled(signal);
    const path = join(root, entry.directory);
    let before;
    try { before = await lstat(path, { bigint: true }); }
    catch (error) { partial ||= mandatory || error.code !== 'ENOENT'; continue; }
    if (!before?.isDirectory() || await realpath(path).catch(() => '') !== path) {
      partial = true;
      continue;
    }
    const listing = await opendir(path).catch(() => null);
    if (!listing) { partial = true; continue; }
    try {
      for await (const item of listing) {
        throwIfCancelled(signal);
        if (++budget.entries > 1536) return { files: files.sort(), partial: true };
        if (item.name.startsWith('.') || /[\x00-\x1f\x7f]/.test(item.name)) continue;
        const file = entry.directory + '/' + item.name;
        if (item.isSymbolicLink()) partial = true;
        else if (item.isDirectory() && entry.depth < max) {
          if (entry.depth < 10) pending.push({ directory: file, depth: entry.depth + 1 });
          else partial = true;
        } else if (item.isFile() && entry.depth >= min && changelogExtension.test(item.name) && item.name.endsWith(suffix)) files.push(file);
      }
      const after = await lstat(path, { bigint: true });
      partial ||= before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      partial = true;
    }
  }
  return { files: files.sort(), partial: partial || !files.length && mandatory };
}

async function scanChangelog(root, start, resourceRoot, signal) {
  const files = new Set(), active = new Set(), visited = new Set(), changes = [], issues = new Set();
  const budget = { entries: 0, bytes: 6 * 1024 ** 2 };

  async function visit(file, inherited, depth = 0, mandatory = true) {
    throwIfCancelled(signal);
    if (active.has(file) || depth > 12 || visited.size >= 160 || changes.length >= 400) { issues.add(file); return; }
    const key = JSON.stringify([file, inherited]);
    if (visited.has(key)) return;
    visited.add(key);
    const path = join(root, file);
    if (!mandatory) {
      try { await lstat(path); }
      catch (error) { if (error.code !== 'ENOENT') issues.add(file); return; }
    }
    let document;
    try {
      const text = await readMigrationFile(path, Math.min(512 * 1024, budget.bytes));
      budget.bytes -= Buffer.byteLength(text);
      document = parseLiquibaseChangelog(file, text);
    } catch { /* Missing, replaced and non-text files remain unverified. */ }
    if (!document) { issues.add(file); return; }
    files.add(file);
    active.add(file);
    if (document.partial) issues.add(file);
    const logical = document.logicalFilePath === undefined ? inherited : literal(document.logicalFilePath);
    if (document.logicalFilePath !== undefined && !logical) issues.add(file);

    for (const { name, attributes } of document.entries) {
      if (visited.size >= 160 || changes.length >= 400) { issues.add(file); break; }
      const ignored = flag(attributes, 'ignore', false);
      const override = Object.hasOwn(attributes, 'logicalFilePath') ? literal(attributes.logicalFilePath) : logical;
      if (ignored === undefined || Object.hasOwn(attributes, 'logicalFilePath') && !override) { issues.add(file); continue; }
      if (ignored) continue;
      if (name === 'changeSet') {
        const id = literal(attributes.id), author = literal(attributes.author);
        if (!id || !author || changes.length >= 400) { issues.add(file); continue; }
        changes.push({ file, id, author, ...(override && { logicalFilePath: override }), verified: true });
      } else {
        const relative = flag(attributes, 'relativeToChangelogFile', false);
        const directory = relative ? posix.dirname(file) : resourceRoot;
        const target = localResource(attributes[name === 'include' ? 'file' : 'path'], directory);
        if (relative === undefined || !target) { issues.add(file); continue; }
        if (name === 'include') {
          const required = flag(attributes, 'errorIfMissing', true);
          if (required === undefined || !changelogExtension.test(target)) { issues.add(file); continue; }
          await visit(target, override, depth + 1, required);
        } else {
          const included = await includedFiles(root, target, attributes, budget, signal);
          if (included.partial) issues.add(file);
          for (const child of included.files) await visit(child, override, depth + 1);
        }
      }
    }
    active.delete(file);
  }

  await visit(start);
  const identities = new Map();
  for (const item of changes) {
    const key = JSON.stringify([item.logicalFilePath ?? item.file, item.author, item.id]);
    const previous = identities.get(key);
    if (previous) {
      item.verified = previous.verified = false;
      issues.add(item.file);
      issues.add(previous.file);
    } else identities.set(key, item);
  }
  return { files: [...files], changes, issues: [...issues].slice(0, 30) };
}

export async function previewLiquibase(project, sourceId, signal, { scanned } = {}) {
  const invalid = 'Choose a detected Liquibase changelog.';
  if (typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(sourceId)) throw new Error(invalid);
  throwIfCancelled(signal);
  const { root, identity, migrationSources } = scanned ?? await discoverDatabases(project, { includeMigrations: true });
  const config = migrationSources.find(item => item.adapter === 'liquibase' && item.id === sourceId);
  if (!config) throw new Error(invalid);
  throwIfCancelled(signal);
  const { source, directory, changelog, resourceRoot, disabled } = config;
  const base = { source, files: [], issues: [], changes: [] };
  if (disabled) return { ...base, status: 'disabled' };
  if (!changelog) return { ...base, status: 'unsupported-config' };
  const prefix = directory === '.' ? '' : directory + '/';
  const start = prefix + changelog;
  const result = await scanChangelog(join(root, directory === '.' ? '' : directory), changelog, resourceRoot, signal);
  await resolveStartup(project, [], identity);
  return { ...base, changelog: start, status: result.issues.length ? 'partial' : result.changes.length ? 'ready' : 'empty',
    files: result.files.map(file => prefix + file), issues: result.issues.map(file => prefix + file),
    changes: result.changes.map(item => ({ ...item, file: prefix + item.file })) };
}
