import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { isIP } from 'node:net';
import { dotnetJson, localText } from '../projects/detection/project-detection.mjs';
import { scanProjectServices } from '../projects/detection/project-services.mjs';
import { composeConfigFiles as composeFiles, databaseEnvironmentFiles as envFiles, dotnetSettingsFile, jvmSettingsFile } from '../projects/detection/repository-layout.mjs';
import { djangoSettingsFiles, pythonSourceFiles } from '../projects/detection/python-sources.mjs';
import { resolveStartup } from '../projects/project-startup.mjs';
import { drizzleConfig } from './migrations/drizzle-config.mjs';
import { alembicConfig } from './migrations/alembic-config.mjs';
import { flywaySources } from './migrations/flyway-config.mjs';
import { liquibaseSources } from './migrations/liquibase-config.mjs';
import { composeImageName, composeImages } from './discovered-compose.mjs';
import { adoFields, dotnetConnectionEntries, dotnetDatabaseProviders } from './dotnet-discovery.mjs';

export const databaseKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const sqlName = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;
export const databaseName = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/;
export const engineNames = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', sqlserver: 'SQL Server', mongodb: 'MongoDB', redis: 'Redis' };
const engines = Object.assign(Object.create(null), { postgres: 'postgres', postgresql: 'postgres', mysql: 'mysql', mariadb: 'mysql', sqlite: 'sqlite', sqlite3: 'sqlite',
  sqlserver: 'sqlserver', mssql: 'sqlserver', mongodb: 'mongodb', 'mongodb+srv': 'mongodb', redis: 'redis', rediss: 'redis' });
const ports = { postgres: 5432, mysql: 3306, sqlserver: 1433, mongodb: 27017, redis: 6379 };
const sqlalchemyScheme = /^(postgres(?:ql)?|mysql)\+[a-z][a-z0-9_]*$/i;
const prismaConfigs = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].flatMap(ext => [`prisma.config.${ext}`, `.config/prisma.${ext}`]);
const connectionKey = /^(?:[A-Z0-9]+_)*(?:DATABASE_URL|DIRECT_URL|DB_URL|REDIS_URL)$/i;
const placeholder = /(?:\$\{|\{\{|<[^>]+>|\b(?:changeme|placeholder|replace[_-]?(?:me|with)|your[_-](?:host|database|db|password)|example\.com)\b)/i;
const clean = value => String(value ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
const validHost = host => host && (isIP(host) || /^(?=.{1,253}$)[a-z\d]+(?:[a-z\d.-]*[a-z\d])?$/i.test(host)) && !placeholder.test(host);
const boundedPort = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : undefined;
const pathLabel = (folder, file) => folder === '.' ? file : `${folder}/${file}`;
const editSalt = databaseKey(process.pid, process.hrtime.bigint().toString());

export function environmentRevision(stat, variable) {
  return databaseKey(editSalt, variable, ...[stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size].map(String));
}

function connection(value, fallback, template) {
  const text = clean(value).replace(/^jdbc:/i, '');
  const protocol = /^([a-z\d+]+):/i.exec(text)?.[1]?.toLowerCase();
  const dialect = sqlalchemyScheme.exec(/^[\w+]+(?=:)/.exec(text)?.[0] ?? '')?.[1]?.toLowerCase();
  const byProtocol = engines[protocol === 'file' ? 'sqlite' : protocol] ?? engines[dialect];
  const engine = byProtocol ?? fallback;
  if (!engine) return {};
  if (!text) return { engine, status: 'missing' };
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* Leave malformed escapes ambiguous below. */ }
  if (template || placeholder.test(decoded)) return { engine, status: 'placeholder' };
  if (protocol && !byProtocol) return { engine, status: 'ambiguous' };
  if (engine === 'sqlite') {
    const path = text.replace(/^(?:sqlite(?:3)?|file):(?:\/\/\/)?/i, '');
    return { engine, path, status: 'configured' };
  }
  try {
    const url = new URL(dialect ? text.replace(/^[^:]+/, dialect) : text);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = url.port ? boundedPort(url.port) : ports[engine];
    const name = decodeURIComponent(url.pathname.replace(/^\//, '')) || (engine === 'redis' ? '0' : '');
    if (validHost(host) && port && (!name || databaseName.test(name))) return { engine, host, port, ...(name && { name }),
      ...(protocol === 'mariadb' && { variant: 'mariadb' }), status: 'configured' };
  } catch { /* A declaration can be incomplete or use a dynamic connection string. */ }
  return { engine, status: 'ambiguous' };
}

export function databaseConnectionValue(value, engine) {
  if (typeof value !== 'string' || value.length > 4096) return;
  const url = value.trim();
  if (!/^(?:postgres(?:ql)?|mysql):\/\//i.test(url) || /[\s\u0000-\u001f\u007f'"$#]/.test(url)) return;
  const target = connection(url);
  if (target.engine !== engine || target.status !== 'configured' || !target.name) return;
  const options = [...new URL(url).searchParams.keys()].map(key => key.toLowerCase());
  if (!options.some(key => ['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].includes(key))) return url;
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

function sqlAlchemyMysqlFields(text) {
  if (!/^load_dotenv\(\s*\)[ \t]*$/m.test(text)) return;
  const urls = [...text.matchAll(/mysql\+[a-z][a-z0-9_]*:\/\/\{([A-Za-z_]\w*)\}:\{([A-Za-z_]\w*)\}(?:['"]\s*f['"])?@\{([A-Za-z_]\w*)\}:\{([A-Za-z_]\w*)\}\/\{([A-Za-z_]\w*)\}/gi)];
  if (urls.length !== 1) return;
  const names = urls[0].slice(1);
  const usesGetenv = /^from[ \t]+os[ \t]+import[ \t]+(?:[^\r\n]*,\s*)?getenv\b/m.test(text);
  const values = names.map(name => {
    const call = usesGetenv ? '(?:os\\.getenv|os\\.environ\\.get|getenv)' : '(?:os\\.getenv|os\\.environ\\.get)';
    const definitions = [...text.matchAll(new RegExp('^' + name + '[ \\t]*=[ \\t]*' + call + '\\([ \\t]*([\'\"])([A-Z_][A-Z0-9_]{0,127})\\1[ \\t]*\\)[ \\t]*$', 'gm'))];
    return definitions.length === 1 && definitions[0][2];
  });
  if (values.every(Boolean) && new Set(values).size === values.length) {
    const [user, password, host, port, name] = values;
    return { host, port, name, user, password };
  }
}

async function prismaConnection(folder, directory, files, runtimeEnv, dotenvEnv, environmentEntries) {
  if (!files.some(file => /^prisma\.config\./.test(file)) && !await lstat(join(folder, '.config')).then(info => info.isDirectory(), () => false)) return;
  const sources = (await Promise.all(prismaConfigs.map(async file => ({ file, text: await projectText(folder, file) }))))
    .filter(source => source.text.trim());
  if (sources.length !== 1) return;
  const { file, text } = sources[0];
  if (!/\bexport\s+default\s+(?:defineConfig\s*\(\s*)?\{/.test(text)) return;
  const schema = /\bschema\s*:\s*(['"])([\w./-]+)\1\s*[,}]/.exec(text)?.[2];
  if (/\bschema\s*:/.test(text) && !schema) return;
  const datasource = /\bdatasource\s*:\s*\{([^{}]*)\}/.exec(text)?.[1] ?? '';
  const reference = /(?:^|,)\s*url\s*:\s*(?:env(?:<\w+>)?\s*\(\s*(['"])([A-Z_][A-Z0-9_]*)\1\s*\)|process\.env\.([A-Z_][A-Z0-9_]*)!?)\s*(?:,|$)/.exec(datasource);
  const variable = reference?.[2] ?? reference?.[3];
  if (!variable) return;
  const schemaPath = schema ? relative(folder, resolve(folder, dirname(file), schema)).split(sep).join('/') :
    await projectText(folder, 'prisma/schema.prisma') ? 'prisma/schema.prisma' : 'schema.prisma';
  const migrationBlock = /\bmigrations\s*:\s*\{([^{}]*)\}/.exec(text)?.[1];
  const migrationPath = /(?:^|,)\s*path\s*:\s*(['"])([\w./-]+)\1\s*(?:,|$)/.exec(migrationBlock ?? '')?.[2];
  const migrations = migrationPath ? relative(folder, resolve(folder, dirname(file), migrationPath)).split(sep).join('/') :
    /\bmigrations\s*:/.test(text) ? undefined : `${dirname(schemaPath ?? 'prisma/schema.prisma')}/migrations`;
  const loadsDefaultDotenv = /^\s*import\s*['"]dotenv\/config['"]/m.test(text);
  const source = loadsDefaultDotenv ? dotenvEnv : runtimeEnv;
  const inherited = loadsDefaultDotenv && Object.hasOwn(process.env, variable);
  const value = inherited ? process.env[variable] : source[variable];
  const environmentConflict = !loadsDefaultDotenv || Boolean(process.env.DOTENV_CONFIG_PATH) ||
    (runtimeEnv[variable] !== undefined && runtimeEnv[variable] !== value);
  const environmentSources = environmentEntries.filter(([name, values]) => !name.endsWith('.env.example') && Object.hasOwn(values, variable))
    .map(([name]) => name);
  if (inherited) environmentSources.push('Process environment');
  if (process.env.DOTENV_CONFIG_PATH) environmentSources.push('DOTENV_CONFIG_PATH');
  if (!loadsDefaultDotenv) environmentSources.push(directory === '.' ? file : directory + '/' + file);
  return { file, schema: schemaPath, migrations, variable, value, environmentConflict, environmentSources,
    ...(loadsDefaultDotenv && { dotenvFile: '.env' }) };
}

async function boundedFiles(folder) {
  const files = [];
  const listing = await opendir(folder).catch(() => null);
  if (!listing) return { files, limited: true };
  let entries = 0;
  try {
    for await (const entry of listing) {
      if (++entries > 512) break;
      if (entry.isFile()) files.push(entry.name);
    }
  } catch { return { files: files.sort(), limited: true }; }
  return { files: files.sort(), limited: entries > 512 };
}

export async function discoverDatabases(project, { includeConnections = false, includeMigrations = false } = {}) {
  const { root, identity, services, limited } = await scanProjectServices(project);
  const folders = await Promise.all(services.map(async service => {
    const { files, limited: filesLimited } = await boundedFiles(service.folder);
    return { ...service, files, filesLimited };
  }));
  const providers = await dotnetDatabaseProviders(folders, projectText);
  const findings = new Map();
  const connections = new Map();
  const migrationSources = [];
  const sqlalchemySources = new Set();
  let truncated = limited || providers.limited;
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
    if (findings.has(record.id)) return;
    findings.set(record.id, record);
    return record.id;
  }

  const rootEnv = new Map(await Promise.all(envFiles.map(async file => [file, parseEnv(await projectText(root, file))])));
  for (const { folder, directory, manifest, pom, files, filesLimited } of folders) {
    truncated ||= filesLimited;
    const dotnet = providers.forFolder(folder);
    for (const { file, engine } of dotnet.declarations) add(directory, file, engine, { engine, orm: 'EF Core', status: 'declared' });
    const alembic = includeMigrations && await alembicConfig(folder, files);
    if (alembic) {
      const source = pathLabel(directory, alembic.file);
      migrationSources.push({ id: databaseKey(project.id, 'alembic', source), adapter: 'alembic', source, directory, versions: alembic.versions });
    }
    const env = directory === '.' ? rootEnv : new Map(await Promise.all(envFiles.map(async file => [file, parseEnv(await projectText(folder, file))])));
    const runtimeEnv = { ...rootEnv.get('.env'), ...rootEnv.get('.env.local'), ...env.get('.env'), ...env.get('.env.local') };
    const pythonMetadata = await Promise.all(['pyproject.toml', 'requirements.txt'].filter(name => files.includes(name)).map(name => projectText(folder, name)));
    const packages = pythonMetadata.some(text => /\bsqlalchemy\b/i.test(text));
    const pythonFiles = packages ? await pythonSourceFiles(folder, true) : files.filter(name => /^[A-Za-z_]\w*\.py$/.test(name)).slice(0, 64);
    for (const file of new Set(['database.py', 'app/database.py', 'src/database.py', ...(pythonFiles ?? [])])) {
      const source = pathLabel(directory, file);
      if (sqlalchemySources.has(source)) continue;
      const text = await projectText(folder, file);
      if (!/^(?:from\s+sqlalchemy(?:\.ext\.asyncio)?\s+import\b|import\s+sqlalchemy\b)/m.test(text) || !/\bcreate_(?:async_)?engine\s*\(/.test(text)) continue;
      const dialects = new Set([...text.matchAll(/['"]((?:postgres(?:ql)?|mysql)\+[a-z][a-z0-9_]*)\:\/\//gi)].map(match => engines[sqlalchemyScheme.exec(match[1])?.[1]?.toLowerCase()]));
      const connectionFields = dialects.size === 1 && dialects.has('mysql') && sqlAlchemyMysqlFields(text);
      for (const engine of dialects) {
        const settings = env.get('.env');
        const fields = connectionFields && Object.fromEntries(Object.entries(connectionFields).map(([role, key]) => [role, clean(settings[key])]));
        const credentials = fields && Object.values(fields).every(Boolean) && validHost(fields.host) && boundedPort(fields.port) && databaseName.test(fields.name);
        const target = credentials && (fields.host.includes(':') ? '[' + fields.host + ']' : fields.host);
        const value = credentials && `mysql://${encodeURIComponent(fields.user)}:${encodeURIComponent(fields.password)}@${target}:${fields.port}/${encodeURIComponent(fields.name)}`;
        const detected = value && connection(value, engine);
        const id = add(directory, file, engine, { engine, orm: 'SQLAlchemy', status: 'declared', ...detected, ...(connectionFields && { connectionFields }) });
        if (includeConnections && id && detected?.status === 'configured') connections.set(id, { value });
      }
      sqlalchemySources.add(source);
    }
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
        const id = add(directory, file, key, { ...connection(value, key === 'REDIS_URL' ? 'redis' : engines[provider], template),
          ...(!template && { environmentVariable: key, environmentFile: file }) });
        if (includeConnections && id && !template) connections.set(id, { value });
      }
      const engine = engines[clean(envValues.DB_CONNECTION ?? envValues.DB_DRIVER ?? envValues.DATABASE_ENGINE).toLowerCase()];
      if (engine) {
        const name = clean(envValues.DB_DATABASE ?? envValues.DB_NAME);
        const host = clean(envValues.DB_HOST).toLowerCase();
        const port = envValues.DB_PORT ? boundedPort(envValues.DB_PORT) : ports[engine];
        const target = engine === 'sqlite' ? { path: name } : validHost(host) && port && databaseName.test(name) ? { host, port, name } : {};
        const status = template || placeholder.test(host + name) ? 'placeholder' : !name || engine !== 'sqlite' && !host ? 'missing'
          : Object.keys(target).length ? 'configured' : 'ambiguous';
        add(directory, file, 'DB_CONNECTION', { engine, status, ...(status === 'configured' && target) });
      }
    }
    const prisma = ['prisma/schema.prisma', 'schema.prisma'];
    const localEntries = [...env].map(([name, values]) => [directory === '.' ? name : directory + '/' + name, values]);
    const environmentEntries = directory === '.' ? localEntries : [...rootEnv, ...localEntries];
    if (typeof dependencies['drizzle-kit'] === 'string') {
      const drizzle = await drizzleConfig(folder, files, projectText);
      if (drizzle) {
        const { file, variable } = drizzle;
        const defined = environmentEntries.filter(([name, values]) => !name.endsWith('.env.example') && Object.hasOwn(values, variable))
          .map(([name, values]) => [name, values[variable]]);
        if (Object.hasOwn(process.env, variable)) defined.push(['Process environment', process.env[variable]]);
        const environmentConflict = new Set(defined.map(([, value]) => value)).size > 1 ||
          Boolean(process.env.DOTENV_CONFIG_PATH);
        const value = defined[0]?.[1];
        const parsed = connection(value, 'postgres');
        const state = environmentConflict || parsed.engine !== 'postgres' ? { engine: 'postgres', status: 'ambiguous' } : parsed;
        const id = add(directory, file, variable, { ...state, orm: 'Drizzle',
          environmentVariable: variable, migrationAdapter: 'drizzle' });
        if (includeConnections && id) connections.set(id, { ...drizzle, value, environmentConflict,
          environmentSources: [...defined.map(([name]) => name), ...(process.env.DOTENV_CONFIG_PATH ? ['DOTENV_CONFIG_PATH'] : [])] });
      }
    }
    const prismaConfig = await prismaConnection(folder, directory, files, runtimeEnv, env.get('.env'), environmentEntries);
    if (prismaConfig?.schema?.endsWith('.prisma') && !prismaConfig.schema.startsWith('../') && !prisma.includes(prismaConfig.schema)) prisma.push(prismaConfig.schema);
    const resourceDirectory = join(folder, 'src/main/resources');
    const resources = await realpath(resourceDirectory).catch(() => '') === resourceDirectory
      ? await boundedFiles(resourceDirectory) : { files: [], limited: false };
    const jvmConfigs = resources.files.filter(file => jvmSettingsFile.test(file));
    const localConfigs = files.filter(file => jvmSettingsFile.test(file) || dotnetSettingsFile.test(file) ||
      /^(?:settings\.py|database\.ya?ml|requirements\.txt|pyproject\.toml|Gemfile)$/i.test(file));
    const djangoConfigs = files.includes('manage.py') ? djangoSettingsFiles(await projectText(folder, 'manage.py')) : [];
    truncated ||= resources.limited || jvmConfigs.length > 20 || localConfigs.length > 20;
    const configs = [...localConfigs.slice(0, 20), ...jvmConfigs.slice(0, 20).map(file => 'src/main/resources/' + file),
      'src/main/resources/application.properties', 'src/main/resources/application.yml', 'src/main/resources/application.yaml',
      ...djangoConfigs, 'config/database.yml', 'config/database.yaml'];
    if (includeMigrations) {
      const configTexts = new Map();
      const input = { files, pom, configs: [...localConfigs.slice(0, 20), ...jvmConfigs.slice(0, 20).map(file => 'src/main/resources/' + file)],
        read(file) {
          if (!configTexts.has(file)) configTexts.set(file, projectText(folder, file));
          return configTexts.get(file);
        } };
      for (const [adapter, scanned] of [['flyway', await flywaySources(input)], ['liquibase', await liquibaseSources(input)]]) {
        truncated ||= scanned.limited;
        for (const { file, document, ...config } of scanned.sources) {
          const source = pathLabel(directory, file);
          migrationSources.push({ id: databaseKey(project.id, adapter, source, config.scope, config.profile, document),
            adapter, source, directory, ...config });
        }
      }
    }
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
          const schemaId = add(directory, file, key, { ...result, orm: 'Prisma', ...(engine && { declaredEngine: engine }), ...(variable && { environmentVariable: variable }) });
          if (includeConnections && schemaId && value) connections.set(schemaId, { value });
          if (!value && !variable && prismaConfig?.schema === file && ['postgres', 'mysql', 'sqlserver', 'mongodb'].includes(engine)) {
            const id = add(directory, prismaConfig.file, prismaConfig.variable, { ...connection(prismaConfig.value, engine), orm: 'Prisma', declaredEngine: engine,
              environmentVariable: prismaConfig.variable, ...(prismaConfig.dotenvFile && { environmentFile: prismaConfig.dotenvFile }),
              ...(engine === 'postgres' && { guidedSetup: true }) });
            if (includeConnections && id) connections.set(id, { value: prismaConfig.value,
              environmentConflict: prismaConfig.environmentConflict,
              environmentSources: prismaConfig.environmentSources,
              schema: file, migrations: prismaConfig.migrations });
          }
        }
      } else {
        if (dotnetSettingsFile.test(file)) {
          const soleProvider = dotnet.engines.size === 1 ? [...dotnet.engines][0] : undefined;
          for (const { key, value, section } of dotnetConnectionEntries(dotnetJson(text))) {
            if (section && !value?.trim()) {
              add(directory, file, key, { engine: soleProvider, status: 'missing' });
              continue;
            }
            const fields = adoFields(value);
            if (!fields) continue;
            const endpoint = fields.host ?? fields.server ?? fields['data source'] ?? fields.address;
            const name = fields.database ?? fields['initial catalog'];
            if (!endpoint || !section && !name) continue;
            const localdb = /^\(localdb\)\\[\w.-]+$/i.test(endpoint);
            const sqlServer = localdb || !fields.host && (fields['integrated security'] || fields['initial catalog'] || fields.trusted_connection);
            const engine = sqlServer ? 'sqlserver' : ['postgres', 'mysql', 'sqlserver'].includes(soleProvider) ? soleProvider
              : fields.host ? 'postgres' : section ? 'sqlserver' : undefined;
            if (!engine) continue;
            const address = engine === 'sqlserver' ? endpoint.replace(/^tcp:/i, '') : endpoint;
            const [host, explicitPort] = address.toLowerCase().split(',');
            const port = boundedPort(fields.port ?? explicitPort ?? ports[engine]);
            const status = localdb ? 'unverified' : placeholder.test(value) ? 'placeholder' : !name ? 'missing'
              : validHost(host) && databaseName.test(name) && port ? 'configured' : 'ambiguous';
            const id = add(directory, file, key, { engine, status, ...(status === 'configured' && { host, name, port }) });
            if (includeConnections && id && engine === 'sqlserver' && status === 'configured' && !/[{}"'\r\n]/.test(value)) {
              connections.set(id, { sqlServerAuth: { user: fields['user id'] ?? fields.uid ?? fields.user,
                password: fields.password ?? fields.pwd, integrated: /^(?:true|yes|sspi)$/i.test(fields['integrated security'] ?? fields.trusted_connection ?? '') } });
            }
            if (includeConnections && id && engine === 'postgres' && status === 'configured' && fields.host?.toLowerCase() === host &&
                Object.keys(fields).every(field => /^(?:host|port|database|username|password|ssl ?mode)$/.test(field)) &&
                !(fields.sslmode && fields['ssl mode'])) {
              connections.set(id, { postgresHistoryAuth: { user: fields.username, password: fields.password ?? '',
                sslmode: (fields.sslmode ?? fields['ssl mode'] ?? 'prefer').toLowerCase() } });
            }
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
      for (const [service, reference] of composeImages(text)) {
        const image = composeImageName(reference);
        const engine = engines[image];
        if (engine) add(directory, file, service, { engine, kind: 'compose', status: 'unverified',
          ...(image === 'mariadb' && { variant: 'mariadb' }) });
      }
    }
  }
  if (['mysql', 'postgres'].includes(project.database) && ![...findings.values()].some(item => item.kind === 'compose' && item.directory === '.')) {
    add('.', 'stackforge.json', 'database', { engine: project.database, kind: 'compose', status: 'unverified' });
  }
  const requirements = [...findings.values()].sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  for (const item of requirements) {
    const key = item.environmentVariable;
    if (!key || !/^[A-Z_][A-Z0-9_]*$/.test(key) || !['postgres', 'mysql'].includes(item.engine) ||
        !['configured', 'placeholder', 'ambiguous'].includes(item.status) || Object.hasOwn(process.env, key)) continue;
    const folder = resolve(root, item.directory);
    const sources = await Promise.all(['.env', '.env.local'].map(async file => {
      const path = join(folder, file);
      const stat = await lstat(path, { bigint: true }).catch(() => null);
      if (stat?.isFile() && stat.nlink === 1n && stat.size <= 512n * 1024n &&
          Object.hasOwn(parseEnv(await projectText(folder, file)), key)) return { file, revision: environmentRevision(stat, key) };
    }));
    const definitions = sources.filter(Boolean);
    if (definitions.length === 1 && (!item.environmentFile || item.environmentFile === definitions[0].file)) item.environmentEdit = definitions[0];
  }
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
    if (databaseName.test(name) && !placeholder.test(name)) match.name = name;
  }
  await resolveStartup(project, [], identity);
  return { root, identity, limited: truncated, requirements, ...(includeMigrations && { migrationSources }), ...(includeConnections && { connections }) };
}
