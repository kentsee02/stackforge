import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { throwIfCancelled } from '../../platform/process.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { discoverDatabases } from '../discovery.mjs';
import { readMigrationFile } from './migration-files.mjs';

const maxEntries = 200;
const revisionName = '[A-Za-z0-9_]{1,64}';
const names = ['revision', 'down_revision', 'depends_on'];
const quotedRevision = new RegExp(`^(['"])(${revisionName})\\1$`);
const syntax = /"""(?:[^"\\]|\\[\s\S]|"(?!""))*(?:"""|$)|'''(?:[^'\\]|\\[\s\S]|'(?!''))*(?:'''|$)|"(?:[^"\\\r\n]|\\[\s\S])*"|'(?:[^'\\\r\n]|\\[\s\S])*'|#[^\r\n]*|[()[\]{}"']|\\?\r?\n/g;
const closing = { '(': ')', '[': ']', '{': '}' };

function logicalLines(source) {
  const brackets = [];
  const parts = [];
  let offset = 0;
  for (const { 0: token, index } of source.matchAll(syntax)) {
    parts.push(source.slice(offset, index));
    offset = index + token.length;
    if (token.startsWith('#')) continue;
    if (token.endsWith('\n')) {
      parts.push(brackets.length || token.startsWith('\\') ? ' ' : '\n');
      continue;
    }
    if (Object.hasOwn(closing, token)) brackets.push(closing[token]);
    if (/^[)\]}]$/.test(token) && brackets.pop() !== token) return;
    if (/^["']/.test(token)) {
      if (token.length < 2) return;
      const triple = /^(?:"""|''')/.exec(token)?.[0];
      if (triple && (token.length < 6 || !token.endsWith(triple))) return;
      // Formatted strings can contain nested Python expressions and quotes.
      if (/\b(?:f|rf|fr)$/i.test(source.slice(Math.max(0, index - 3), index))) return;
      parts.push(triple || /[\r\n]/.test(token) ? '~' : token);
    } else parts.push(token);
  }
  if (!brackets.length) return parts.join('') + source.slice(offset);
}

function declaredRevision(source) {
  const cleaned = logicalLines(source.replace(/^\uFEFF/, ''));
  if (cleaned === undefined) return;
  const declared = new Map();
  for (const match of cleaned.matchAll(/^([ \t]*)(revision|down_revision|depends_on)\b[ \t]*(?::[ \t]*[\w.\[\], |]+)?[ \t]*=(?!=)[ \t]*(\([^)]*\)|[^\r\n]*?)[ \t]*$/gm)) {
    const [, indent, key, value] = match;
    if (indent || declared.has(key)) return;
    const text = value.trim();
    const single = quotedRevision.exec(text)?.[2];
    if (single) declared.set(key, [single]);
    else if (key === 'revision') return;
    else if (text === 'None') declared.set(key, []);
    else if (text.startsWith('(') && text.endsWith(')')) {
      const values = text.slice(1, -1).trim().replace(/,$/, '');
      const references = values ? values.split(',').map(item => quotedRevision.exec(item.trim())?.[2]) : [];
      if (references.includes(undefined) || new Set(references).size !== references.length) return;
      declared.set(key, references);
    } else return;
  }
  // An assignment we did not parse makes the file unverified, including a second assignment.
  const assignments = [...cleaned.matchAll(/^[ \t]*(revision|down_revision|depends_on)\b[ \t]*(?:[:+\-*/%&|^]|=(?!=))/gm)];
  if (assignments.length !== declared.size || !declared.has('revision') || !declared.has('down_revision')) return;
  const [[revision], parents, dependencies = []] = names.map(name => declared.get(name));
  return { revision, parents, dependencies };
}

function orderedGraph(files) {
  const nodes = new Map(files.map(file => [file.revision, file]));
  if (nodes.has(undefined) || nodes.size !== files.length) return;
  const parents = new Set(files.flatMap(file => file.parents));
  const ordered = new Set();
  const visiting = new Set();
  function visit(id) {
    if (ordered.has(id)) return true;
    const node = nodes.get(id);
    if (!node || visiting.has(id)) return false;
    visiting.add(id);
    if (![...node.parents, ...node.dependencies].every(visit)) return false;
    visiting.delete(id);
    ordered.add(id);
    return true;
  }
  if (![...nodes.keys()].every(visit)) return;
  return { revisions: [...ordered].map(id => nodes.get(id)), heads: [...nodes.keys()].filter(id => !parents.has(id)).sort() };
}

async function revisionFiles(folder, versions, prefix, signal) {
  const path = join(folder, versions);
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || await realpath(path) !== path) throw new Error();
  const files = [];
  let entries = 0;
  for await (const entry of await opendir(path)) {
    throwIfCancelled(signal);
    if (++entries > 512) throw new Error();
    if (!entry.name.endsWith('.py') || /^(?:__init__|\.\#)/.test(entry.name)) continue;
    if (!entry.isFile() || files.length >= maxEntries || /[\u0000-\u001f\u007f]/.test(entry.name)) throw new Error();
    files.push(entry.name);
  }
  const revisions = [];
  let remaining = 8 * 1024 * 1024;
  for (const name of files.sort()) {
    throwIfCancelled(signal);
    const text = await readMigrationFile(join(path, name), Math.min(256 * 1024, remaining));
    remaining -= Buffer.byteLength(text);
    revisions.push({ file: prefix + versions + '/' + name, ...declaredRevision(text) });
  }
  const after = await lstat(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs) throw new Error();
  return revisions;
}

export async function previewAlembic(project, sourceId, signal, discovery) {
  throwIfCancelled(signal);
  const invalid = 'Choose a detected Alembic configuration.';
  if (typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(sourceId)) throw new Error(invalid);
  const { root, identity, migrationSources } = discovery ?? await discoverDatabases(project, { includeMigrations: true });
  throwIfCancelled(signal);
  const config = migrationSources.find(item => item.id === sourceId && item.adapter === 'alembic');
  if (!config) throw new Error(invalid);
  const { source, directory, versions } = config;
  const result = { source, revisions: [] };
  if (!versions) return { ...result, status: 'unsupported-config' };
  const prefix = directory === '.' ? '' : directory + '/';
  result.directory = prefix + versions;
  try { result.revisions = await revisionFiles(join(root, directory), versions, prefix, signal); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    return { ...result, status: 'files-unavailable' };
  }
  await resolveStartup(project, [], identity);
  if (!result.revisions.length) return { ...result, status: 'empty' };
  const graph = orderedGraph(result.revisions);
  if (!graph) return { ...result, status: 'unverified' };
  return { ...result, ...graph, status: 'ready' };
}
