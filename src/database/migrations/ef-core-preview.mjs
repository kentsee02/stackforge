import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { throwIfCancelled } from '../../platform/process.mjs';
import { scanDotnetLayout } from '../../projects/detection/dotnet-layout.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { readMigrationFile } from './migration-files.mjs';

const identifier = '[A-Za-z_][A-Za-z0-9_]*';
const qualified = `(?:global::)?${identifier}(?:\\.${identifier})*`;
const migrationId = /^\d{14}_[\p{L}\p{N}_.-]{1,128}$/u;
const migrationNamespace = 'Microsoft.EntityFrameworkCore.Migrations';
const contextNamespace = 'Microsoft.EntityFrameworkCore.Infrastructure';
const marker = name => name.replaceAll('.', '\\.');
const classPattern = /((?:\[[^\[\]]{0,1024}\]\s*)*)((?:(?:public|internal|protected|private|partial|sealed|abstract|file|new)\s+)*)\bclass\s+([A-Za-z_]\w*)(?:\s*:\s*([\w:.,\s]+?))?\s*\{/g;
const namespacePattern = new RegExp(`\\bnamespace\\s+(${qualified})\\s*[;{]`, 'g');
const usingsPattern = /^\s*(?:global\s+)?using\s+(?:global::)?(Microsoft\.EntityFrameworkCore\.(?:Migrations|Infrastructure))\s*;/gm;

function codeOnly(text) {
  return text.replace(/("{3,})[\s\S]*?\1|@"(?:""|[^"])*"|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    token => token.startsWith('"') && migrationId.test(token.slice(1, -1)) ? token : token.replace(/[^\r\n]+/g, ' '));
}

function migrationClasses(text, file, globalUsings) {
  const code = codeOnly(text);
  const namespaces = [...code.matchAll(namespacePattern)].map(match => match[1]);
  const namespace = namespaces[0] ?? '';
  const usings = new Set([...globalUsings, ...[...code.matchAll(usingsPattern)].map(match => match[1])]);
  const attribute = (owner, name) => usings.has(owner) ? `(?:(?:global::)?${marker(owner)}\\.)?${name}` : `(?:global::)?${marker(owner)}\\.${name}`;
  const migration = new RegExp(`(?:\\[|,)\\s*${attribute(migrationNamespace, 'Migration(?:Attribute)?')}\\s*\\(\\s*"([^"\\r\\n]+)"\\s*\\)`, 'g');
  const context = new RegExp(`(?:\\[|,)\\s*${attribute(contextNamespace, 'DbContext(?:Attribute)?')}\\s*\\(\\s*typeof\\s*\\(\\s*(${qualified})\\s*\\)\\s*\\)`, 'g');
  const migrationBase = new RegExp(`^${attribute(migrationNamespace, 'Migration')}$`);
  return [...code.matchAll(classPattern)].flatMap(([, attrs, modifiers, name, bases]) => {
    const ids = [...attrs.matchAll(migration)].map(match => match[1]);
    const contexts = [...attrs.matchAll(context)].map(match => match[1]);
    const base = migrationBase.test(bases?.split(',')[0].trim() ?? '');
    if (!ids.length && !base) return [];
    return [{ key: namespace + '.' + name, file, namespace, id: ids.length === 1 ? ids[0] : undefined,
      context: contexts.length === 1 ? contexts[0].replace(/^global::/, '') : undefined, base,
      partial: /\bpartial\b/.test(modifiers), uncertain: namespaces.length > 1 || /\b(?:abstract|file)\b/.test(modifiers) || /^\s*#\s*if\b/m.test(code) }];
  });
}

function decodeCSharp(bytes) {
  const marker = bytes.subarray(0, 2).toString('hex');
  let text;
  if (marker === 'fffe' || marker === 'feff') {
    text = new TextDecoder(marker === 'fffe' ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(bytes);
  } else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('windows-1252').decode(bytes); }
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error();
  return { text, bytes: bytes.length };
}

async function compileFiles(root, source, files) {
  let manifest;
  try { manifest = (await readMigrationFile(join(root, source), 128 * 1024)).replace(/<!--[\s\S]*?-->/g, ''); }
  catch { return { files, limited: true }; }
  const defaultItems = /<EnableDefault(?:Compile)?Items\b[^>]*>\s*false\s*<\/EnableDefault(?:Compile)?Items>/i.test(manifest);
  const operations = [...manifest.matchAll(/<Compile\b[^>]*\b(Include|Remove)\s*=\s*(['"])(.*?)\2[^>]*>/gi)];
  const conditional = /\bCondition\s*=/i.test(manifest);
  const selected = new Set(defaultItems && !conditional ? [] : files);
  let limited = conditional && (defaultItems || operations.length > 0) || /<DefaultItemExcludes\b/i.test(manifest);
  for (const [declaration, action, , expression] of operations) {
    if (conditional) continue;
    for (const entry of expression.split(';')) {
      const configured = entry.trim().replaceAll('\\', '/');
      const path = relative(root, resolve(root, dirname(source), configured));
      if (!/\.cs$/i.test(configured) || /[\x00-\x1f\x7f:*?%$&]/.test(configured) || isAbsolute(configured) ||
          isAbsolute(path) || path.split(sep)[0] === '..' || /\bExclude\s*=/i.test(declaration)) { limited = true; continue; }
      const file = path.split(sep).join('/');
      if (action.toLowerCase() === 'include') selected.add(file);
      else selected.delete(file);
    }
  }
  return { files: [...selected].sort(), limited };
}

async function inspectAssembly(root, { source, files }, budget, signal) {
  const compile = await compileFiles(root, source, files);
  const contents = [];
  let limited = compile.limited;
  for (const file of compile.files) {
    throwIfCancelled(signal);
    if (!budget.files || !budget.bytes) { limited = true; break; }
    budget.files--;
    try {
      const { text: content, bytes } = await readMigrationFile(join(root, file), Math.min(512 * 1024, budget.bytes), decodeCSharp);
      budget.bytes -= bytes;
      if (/\bEntityFrameworkCore\b/.test(content) || /\b(?:Migration|DbContext)(?:Attribute)?\b/.test(content)) contents.push({ file, content });
    } catch { limited = true; }
  }
  const globalUsings = contents.flatMap(({ content }) => [...codeOnly(content).matchAll(/^\s*global\s+using\s+(?:global::)?(Microsoft\.EntityFrameworkCore\.(?:Migrations|Infrastructure))\s*;/gm)]
    .map(match => match[1]));
  const classes = contents.flatMap(({ content, file }) => migrationClasses(content, file, globalUsings));
  const bodies = new Map();
  for (const item of classes.filter(item => item.base)) {
    if (!bodies.has(item.key)) bodies.set(item.key, []);
    bodies.get(item.key).push(item);
  }
  const groups = new Map();
  for (const item of classes.filter(item => item.id && migrationId.test(item.id))) {
    const implementations = bodies.get(item.key) ?? [];
    const body = implementations.length === 1 ? implementations[0] : undefined;
    const verified = Boolean(item.context && body && !item.uncertain && !body.uncertain &&
      (item === body || item.partial && body.partial));
    const key = JSON.stringify([item.context, item.namespace]);
    if (!groups.has(key)) groups.set(key, { context: item.context, namespace: item.namespace, migrations: [] });
    groups.get(key).migrations.push({ id: item.id, file: body?.file ?? item.file, verified });
  }
  const result = [...groups.values()];
  for (const group of result) {
    const counts = new Map();
    for (const item of group.migrations) counts.set(item.id.toLowerCase(), (counts.get(item.id.toLowerCase()) ?? 0) + 1);
    for (const item of group.migrations) if (counts.get(item.id.toLowerCase()) > 1) item.verified = false;
    group.migrations.sort((a, b) => a.id.localeCompare(b.id) || a.file.localeCompare(b.file));
    limited ||= group.migrations.some(item => !item.verified);
  }
  return { groups: result, limited };
}

function sourceRecord(project, source) {
  const id = createHash('sha256').update(JSON.stringify([project.id, 'ef-core', source])).digest('hex');
  return { adapter: 'ef-core', id, source };
}

export async function scanEfCore(project, { sourceId, signal } = {}) {
  const invalid = 'Choose a detected EF Core migration project.';
  if (sourceId !== undefined && (typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(sourceId))) throw new Error(invalid);
  const { root, identity } = await resolveStartup(project, []);
  const { projects, limited } = await scanDotnetLayout(root, { signal });
  let partial = limited;
  const budget = { files: 1024, bytes: 24 * 1024 ** 2 };
  const sources = [];
  for (const assembly of projects.sort((a, b) => a.source.localeCompare(b.source))) {
    const record = sourceRecord(project, assembly.source);
    if (sourceId && sourceId !== record.id) continue;
    const result = await inspectAssembly(root, assembly, budget, signal);
    partial ||= result.limited;
    if (sourceId) {
      await resolveStartup(project, [], identity);
      const groups = result.groups.map(group => ({ ...group, id: createHash('sha256').update(
        JSON.stringify([sourceId, group.context, group.namespace, group.migrations.map(item => item.id)])).digest('hex') }));
      return { source: record.source, groups, status: partial ? 'partial' : groups.length ? 'ready' : 'empty' };
    }
    if (result.groups.length) sources.push(record);
  }
  await resolveStartup(project, [], identity);
  if (sourceId) throw new Error(invalid);
  return { sources, limited: projects.length > 0 && partial };
}
