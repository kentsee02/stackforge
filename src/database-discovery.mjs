import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { isIP } from 'node:net';
import { localText } from './project-detection.mjs';
import { scanProjectServices } from './project-services.mjs';
import { resolveStartup } from './project-startup.mjs';

export const databaseKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const sqlName = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;
export const engineNames = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', sqlserver: 'SQL Server', mongodb: 'MongoDB', redis: 'Redis' };
const engines = Object.assign(Object.create(null), { postgres: 'postgres', postgresql: 'postgres', mysql: 'mysql', mariadb: 'mysql', sqlite: 'sqlite', sqlite3: 'sqlite',
  sqlserver: 'sqlserver', mssql: 'sqlserver', mongodb: 'mongodb', 'mongodb+srv': 'mongodb', redis: 'redis', rediss: 'redis' });
const ports = { postgres: 5432, mysql: 3306, sqlserver: 1433, mongodb: 27017, redis: 6379 };
const composeFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const envFiles = ['.env', '.env.local', '.env.example'];
const connectionKey = /^(?:[A-Z0-9]+_)*(?:DATABASE_URL|DIRECT_URL|DB_URL|REDIS_URL)$/i;
const placeholder = /(?:\$\{|\{\{|<[^>]+>|\b(?:changeme|placeholder|replace[_-]?(?:me|with)|your[_-](?:host|database|db|password)|example\.com)\b)/i;
const clean = value => String(value ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
const validHost = host => host && (isIP(host) || /^(?=.{1,253}$)[a-z\d]+(?:[a-z\d.-]*[a-z\d])?$/i.test(host)) && !placeholder.test(host);
const boundedPort = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : undefined;
const pathLabel = (folder, file) => folder === '.' ? file : `${folder}/${file}`;

function connection(value, fallback, template) {
  const text = clean(value).replace(/^jdbc:/i, '');
  const protocol = /^([a-z\d+]+):/i.exec(text)?.[1]?.toLowerCase();
  const engine = engines[protocol === 'file' ? 'sqlite' : protocol] ?? fallback;
  if (!engine) return {};
  if (!text) return { engine, status: 'missing' };
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* Leave malformed escapes ambiguous below. */ }
  if (template || placeholder.test(decoded)) return { engine, status: 'placeholder' };
  if (protocol && protocol !== 'file' && !engines[protocol]) return { engine, status: 'ambiguous' };
  if (engine === 'sqlite') {
    const path = text.replace(/^(?:sqlite(?:3)?|file):(?:\/\/\/)?/i, '');
    return { engine, path, status: 'configured' };
  }
  try {
    const url = new URL(text);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = url.port ? boundedPort(url.port) : ports[engine];
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (validHost(host) && port && (!name || sqlName.test(name))) return { engine, host, port, ...(name && { name }), status: 'configured' };
  } catch { /* A declaration can be incomplete or use a dynamic connection string. */ }
  return { engine, status: 'ambiguous' };
}

function sqlitePath(value, directory) {
  if (!value || value === ':memory:' || isAbsolute(value) || /[?:#<>\u0000-\u001f]/u.test(value)) return;
  const parts = pathLabel(directory, value.replaceAll('\\', '/')).split('/');
  const path = [];
  for (const part of parts) {
    if (part === '..') { if (!path.length) return; path.pop(); }
    else if (part && part !== '.') path.push(part);
  }
  if (/\.(?:db|sqlite3?)$/i.test(path.at(-1) ?? '')) return path.join('/');
}

async function projectText(folder, file) {
  const path = join(folder, file);
  return await realpath(path).catch(() => '') === path ? localText(folder, file) : '';
}

async function boundedFiles(folder) {
  const files = [];
  const listing = await opendir(folder).catch(() => null);
  if (!listing) return { files, limited: true };
  let entries = 0;
  for await (const entry of listing) {
    if (++entries > 512) break;
    if (entry.isFile()) files.push(entry.name);
  }
  return { files: files.sort(), limited: entries > 512 };
}

export async function discoverDatabases(project) {
  const { root, identity, services, limited } = await scanProjectServices(project);
  const findings = new Map();
  let truncated = limited;
  function add(directory, file, key, metadata) {
    if (!metadata.engine || findings.size >= 128) { truncated ||= findings.size >= 128; return; }
    const { path, ...details } = metadata;
    const source = pathLabel(directory, file);
    const record = { ...details, directory, source, ...(key && { key }) };
    if (path) {
      const normalized = sqlitePath(path, directory);
      if (normalized) record.path = normalized;
      else record.status = 'ambiguous';
    }
    record.id = databaseKey(project.id, source, key, record.engine);
    findings.set(record.id, record);
  }

  const rootEnv = new Map(await Promise.all(envFiles.map(async file => [file, parseEnv(await projectText(root, file))])));
  for (const { folder, directory, manifest, pom } of services) {
    const { files, limited: filesLimited } = await boundedFiles(folder);
    truncated ||= filesLimited;
    const env = directory === '.' ? rootEnv : new Map(await Promise.all(envFiles.map(async file => [file, parseEnv(await projectText(folder, file))])));
    const runtimeEnv = { ...rootEnv.get('.env'), ...rootEnv.get('.env.local'), ...env.get('.env'), ...env.get('.env.local') };
    const dependencies = { ...manifest?.devDependencies, ...manifest?.dependencies };
    const declared = [
      ['postgres', ['pg', 'postgres']], ['mysql', ['mysql', 'mysql2', 'mariadb']],
      ['sqlite', ['sqlite3', 'better-sqlite3', '@libsql/client']], ['mongodb', ['mongodb', 'mongoose']], ['redis', ['redis', 'ioredis']]
    ];
    for (const [engine, packages] of declared) if (packages.some(name => Object.hasOwn(dependencies, name))) add(directory, 'package.json', engine, { engine, status: 'declared' });
    for (const [engine, artifact] of [['postgres', 'postgresql'], ['mysql', 'mysql-connector-j']]) {
      if (pom?.includes(`<artifactId>${artifact}</artifactId>`)) add(directory, 'pom.xml', artifact, { engine, status: 'declared' });
    }
    for (const [file, envValues] of env) {
      const template = file === '.env.example';
      for (const [key, value] of Object.entries(envValues)) {
        if (!connectionKey.test(key)) continue;
        const provider = clean(envValues.DB_CONNECTION ?? envValues.DB_DRIVER ?? envValues.DATABASE_ENGINE).toLowerCase();
        add(directory, file, key, connection(value, key === 'REDIS_URL' ? 'redis' : engines[provider], template));
      }
      const engine = engines[clean(envValues.DB_CONNECTION ?? envValues.DB_DRIVER ?? envValues.DATABASE_ENGINE).toLowerCase()];
      if (engine) {
        const name = clean(envValues.DB_DATABASE ?? envValues.DB_NAME);
        const host = clean(envValues.DB_HOST).toLowerCase();
        const port = envValues.DB_PORT ? boundedPort(envValues.DB_PORT) : ports[engine];
        const target = engine === 'sqlite' ? { path: name } : validHost(host) && port && sqlName.test(name) ? { host, port, name } : {};
        const status = template || placeholder.test(host + name) ? 'placeholder' : !name || engine !== 'sqlite' && !host ? 'missing'
          : Object.keys(target).length ? 'configured' : 'ambiguous';
        add(directory, file, 'DB_CONNECTION', { engine, status, ...(status === 'configured' && target) });
      }
    }
    const prisma = ['prisma/schema.prisma', 'schema.prisma'];
    const configs = [...files.filter(file => /^(?:application(?:-[\w-]+)?\.(?:properties|ya?ml)|appsettings(?:\.[\w-]+)?\.json|settings\.py|database\.ya?ml|requirements\.txt|pyproject\.toml|Gemfile)$/i.test(file)).slice(0, 20),
      'src/main/resources/application.properties', 'src/main/resources/application.yml', 'src/main/resources/application.yaml', 'config/database.yml'];
    await Promise.all([...prisma, ...new Set(configs)].map(async file => {
      const text = await projectText(folder, file);
      if (!text) return;
      if (file.endsWith('.prisma')) {
        for (const [, key, block] of text.matchAll(/\bdatasource\s+(\w+)\s*\{([^}]+)\}/g)) {
          const engine = engines[/\bprovider\s*=\s*["']([\w+]+)["']/.exec(block)?.[1]];
          const variable = /\burl\s*=\s*env\(\s*["'](\w+)["']\s*\)/.exec(block)?.[1];
          const value = variable ? runtimeEnv[variable] : /\burl\s*=\s*["']([^"']+)["']/.exec(block)?.[1];
          const result = value || variable ? connection(value, engine) : { engine, status: 'declared' };
          if (result.path && !isAbsolute(result.path)) result.path = file.slice(0, -'schema.prisma'.length) + result.path;
          add(directory, file, key, { ...result, orm: 'Prisma' });
        }
      } else {
        if (/^appsettings(?:\.[\w-]+)?\.json$/i.test(file)) {
          let config;
          try { config = JSON.parse(text); } catch { /* A malformed appsettings file provides no connection evidence. */ }
          for (const [key, value] of Object.entries(config?.ConnectionStrings ?? {})) {
            if (typeof value !== 'string' || !/^[\w.-]{1,64}$/.test(key) || !/^(?:server|host|data source)\s*=/i.test(value)) continue;
            const fields = Object.fromEntries(value.split(';').filter(field => field.includes('=')).map(field => {
              const split = field.indexOf('=');
              return [field.slice(0, split).trim().toLowerCase(), clean(field.slice(split + 1))];
            }));
            const engine = fields.host ? 'postgres' : fields.server || fields['data source'] ? 'sqlserver' : undefined;
            const [host, explicitPort] = (fields.host ?? fields.server ?? fields['data source'] ?? '').toLowerCase().split(',');
            const name = fields.database ?? fields['initial catalog'];
            const port = boundedPort(fields.port ?? explicitPort ?? ports[engine]);
            const status = placeholder.test(value) ? 'placeholder' : !host || !name ? 'missing' : validHost(host) && sqlName.test(name) && port ? 'configured' : 'ambiguous';
            add(directory, file, key, { engine, status, ...(status === 'configured' && { host, name, port }) });
          }
        }
        const urls = [...text.matchAll(/(?:jdbc:)?(?:postgres(?:ql)?|mysql|mariadb|sqlite|sqlserver|mongodb(?:\+srv)?|rediss?):\/\/[^\s"'<>]+/gi)].slice(0, 16);
        for (const [index, match] of urls.entries()) add(directory, file, `url-${index + 1}`, connection(match[0]));
        const references = [...text.matchAll(/\$\{((?:[A-Z_]+_)?(?:DATABASE_URL|DB_URL))\}/g)];
        for (const [index, match] of references.entries()) add(directory, file, `reference-${index + 1}`, connection(runtimeEnv[match[1]]));
        for (const [engine, pattern] of [['postgres', /django\.db\.backends\.postgresql|\b(?:psycopg2?|asyncpg|Npgsql)\b/i],
          ['mysql', /django\.db\.backends\.mysql|\b(?:pymysql|mysqlclient)\b/i], ['sqlite', /django\.db\.backends\.sqlite3|\baiosqlite\b/i]]) {
          if (pattern.test(text)) add(directory, file, engine, { engine, status: 'declared' });
        }
      }
    }));
    const sqliteFiles = files.filter(file => /\.(?:db|sqlite3?)$/i.test(file));
    truncated ||= sqliteFiles.length > 24;
    for (const file of sqliteFiles.slice(0, 24)) {
      add(directory, file, '', { engine: 'sqlite', path: file, status: 'configured' });
    }
    for (const file of composeFiles) {
      const text = await projectText(folder, file);
      if (!text) continue;
      let model;
      try { model = JSON.parse(text); } catch { /* Static YAML scan for straightforward service declarations. */ }
      if (model) {
        for (const [service, spec] of Object.entries(model.services ?? {})) {
          const engine = engines[/^(?:(?:docker\.io\/)?library\/)?([\w-]+)(?=[:@]|$)/.exec(spec?.image)?.[1]];
          if (engine && /^[\w.-]{1,64}$/.test(service)) add(directory, file, service, { engine, kind: 'compose', status: 'unverified' });
        }
      } else {
        const section = /^services:\s*\r?\n((?:[ \t]+.*(?:\r?\n|$)|\s*\r?\n)*)/m.exec(text)?.[1] ?? '';
        let service, indentation = Infinity;
        for (const line of section.split(/\r?\n/)) {
          const heading = /^( +)([\w.-]{1,64}):\s*(?:#.*)?$/.exec(line);
          if (heading && heading[1].length <= indentation) { service = heading[2]; indentation = heading[1].length; }
          const image = /^( +)image:\s*['"]?(?:(?:docker\.io\/)?library\/)?([\w-]+)(?=[:@'"\s]|$)/.exec(line);
          const engine = engines[image?.[2]];
          if (service && engine && image[1].length > indentation) add(directory, file, service, { engine, kind: 'compose', status: 'unverified' });
        }
      }
    }
  }
  if (['mysql', 'postgres'].includes(project.database) && ![...findings.values()].some(item => item.kind === 'compose' && item.directory === '.')) {
    add('.', 'stackforge.json', 'database', { engine: project.database, kind: 'compose', status: 'unverified' });
  }
  const requirements = [...findings.values()].sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  for (const item of requirements.filter(entry => entry.path)) {
    const candidate = resolve(root, item.path);
    const stat = await lstat(candidate).catch(() => null);
    if (!stat) { item.status = 'missing'; continue; }
    if (!stat.isFile() || await realpath(candidate).catch(() => '') !== candidate) {
      delete item.path;
      item.status = 'ambiguous';
    }
  }
  const managed = requirements.filter(item => item.kind === 'compose' && item.directory === '.' &&
    ['postgres', 'mysql'].includes(item.engine));
  if (managed.length === 1) {
    const match = managed[0];
    const config = { ...rootEnv.get('.env'), ...rootEnv.get('.env.local') };
    const name = clean(config.DB_NAME ?? config.DB_DATABASE);
    if (sqlName.test(name) && !placeholder.test(name)) match.name = name;
  }
  await resolveStartup(project, [], identity);
  return { root, identity, limited: truncated, requirements };
}
