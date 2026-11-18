import { dirname, join, resolve } from 'node:path';
import { dotnetManifest } from '../projects/detection/repository-layout.mjs';

const packageEngines = new Map([
  ['microsoft.entityframeworkcore.sqlserver', 'sqlserver'],
  ['microsoft.entityframeworkcore.sqlite', 'sqlite'],
  ['microsoft.entityframeworkcore.sqlite.core', 'sqlite'],
  ['npgsql.entityframeworkcore.postgresql', 'postgres'],
  ['pomelo.entityframeworkcore.mysql', 'mysql'],
  ['mysql.entityframeworkcore', 'mysql'],
  ['mongodb.entityframeworkcore', 'mongodb']
]);

const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path;

export async function dotnetDatabaseProviders(services, readText) {
  const manifests = services.flatMap(({ folder, files }) => files.filter(file => dotnetManifest.test(file))
    .map(file => ({ folder, file, path: join(folder, file) })));
  const projects = new Map(), byFolder = new Map();
  let limited = manifests.length > 256;
  for (const entry of manifests.slice(0, 256)) {
    const xml = (await readText(entry.folder, entry.file)).replace(/<!--[\s\S]*?-->/g, '');
    const providers = new Set(), references = new Set();
    const items = xml.matchAll(/<(PackageReference|ProjectReference)\b[^<>]*?\bInclude\s*=\s*(['"])([^"'<>]+)\2/gi);
    let isTest = /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(xml);
    for (const [, tag, , value] of items) {
      if (tag.toLowerCase() === 'packagereference') {
        const name = value.toLowerCase();
        if (name === 'microsoft.net.test.sdk') isTest = true;
        const engine = packageEngines.get(name);
        if (engine) providers.add(engine);
      } else if (/^[\w. /\\-]+$/.test(value) && dotnetManifest.test(value)) {
        if (references.size === 32) limited = true;
        else references.add(pathKey(resolve(dirname(entry.path), value.replaceAll('\\', '/'))));
      }
    }
    const record = { ...entry, references, providers: isTest ? new Set() : providers };
    projects.set(pathKey(entry.path), record);
    if (!byFolder.has(entry.folder)) byFolder.set(entry.folder, []);
    byFolder.get(entry.folder).push(record);
  }
  function forFolder(folder) {
    const own = byFolder.get(folder) ?? [];
    const pending = new Set(own);
    const engines = new Set();
    for (const project of pending) {
      for (const engine of project.providers) engines.add(engine);
      for (const path of project.references) if (projects.has(path)) pending.add(projects.get(path));
    }
    return { engines, declarations: own.flatMap(({ file, providers }) => [...providers].map(engine => ({ file, engine }))) };
  }
  return { forFolder, limited };
}

export function dotnetConnectionEntries(config) {
  const connections = [];
  function visit(node, path) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || path.length > 4) return;
    const section = path.at(-1)?.toLowerCase() === 'connectionstrings';
    for (const [key, value] of Object.entries(node)) {
      if (!/^[\w.-]{1,64}$/.test(key)) continue;
      const namedConnection = /connectionstring$/i.test(key);
      if (section || namedConnection) {
        if (typeof value === 'string' || section && value === null) {
          connections.push({ key: [...path.filter(part => part.toLowerCase() !== 'connectionstrings'), key].join('.'), value, section });
        }
      } else visit(value, [...path, key]);
    }
  }
  visit(config, []);
  return connections;
}

export function adoFields(value) {
  if (typeof value !== 'string') return;
  const text = value.trim().replace(/;+$/, '');
  const expression = /[\s;]*([a-z][\w -]{0,63}?)\s*=\s*(?:"((?:[^"\r\n]|"")*)"|'((?:[^'\r\n]|'')*)'|([^;"'\r\n]*))\s*(?:;|$)/gyi;
  const fields = Object.create(null);
  while (expression.lastIndex < text.length) {
    const match = expression.exec(text);
    if (!match) return;
    const [, key, double, single, plain] = match;
    const normalized = key.trim().toLowerCase();
    if (Object.hasOwn(fields, normalized)) return;
    fields[normalized] = double?.replaceAll('""', '"') ?? single?.replaceAll("''", "'") ?? plain.trim();
  }
  return fields;
}
