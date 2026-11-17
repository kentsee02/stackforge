import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { databaseConnectionValue, databaseKey, databaseName, discoverDatabases } from './discovery.mjs';
import { saveDatabaseEnvironment } from './environment.mjs';
import { localInstallation, localhostEndpoint, localSession, validateLocalTarget } from './adapters/local.mjs';
import { executeInitialization, initializationPlan } from './initialization.mjs';
import { resolveStartup } from '../projects/project-startup.mjs';
import { run, throwIfCancelled } from '../platform/process.mjs';

const changed = 'The PostgreSQL setup plan changed. Check the database again.';
const localHosts = ['localhost', '127.0.0.1', '::1'];
const salt = randomUUID();
const within = (root, file) => {
  const part = relative(root, file);
  return part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
};

const sha256 = contents => createHash('sha256').update(contents).digest('hex');

async function inspectPrismaFiles({ root, folder, connection }) {
  if (!connection.schema || !connection.migrations) return;
  const schema = resolve(folder, connection.schema);
  const migrations = resolve(folder, connection.migrations);
  if (![schema, migrations].every(file => within(root, file)) ||
      await realpath(schema).catch(() => '') !== schema || await realpath(migrations).catch(() => '') !== migrations) return;
  const files = await readdir(migrations, { withFileTypes: true });
  const names = files.filter(file => file.isDirectory() && /^[a-z0-9_-]{1,100}$/i.test(file.name)).map(file => file.name).sort();
  if (!names.length || names.length > 200 || files.some(file => file.isSymbolicLink() || file.isDirectory() && !names.includes(file.name))) return;
  const paths = [schema, ...names.map(name => join(migrations, name, 'migration.sql'))];
  const contents = [];
  let size = 0;
  for (const file of paths) {
    const stat = await lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > 1024 * 1024 || await realpath(file) !== file) return;
    const data = await readFile(file);
    size += data.length;
    if (data.length !== stat.size || size > 16 * 1024 * 1024) return;
    contents.push(data);
  }
  const lock = join(migrations, 'migration_lock.toml');
  const lockStat = await lstat(lock).catch(() => null);
  if (lockStat && (!lockStat.isFile() || lockStat.size > 16384 || await realpath(lock) !== lock)) return;
  const lockText = lockStat ? await readFile(lock, 'utf8') : '';
  if (lockText && !/^provider\s*=\s*["']postgresql["']/m.test(lockText)) return;
  const hashes = contents.map(sha256);
  const digest = databaseKey(names, hashes, lockText);
  const checksums = new Map(names.map((name, index) => {
    const text = contents[index + 1].toString('utf8').replace(/\r\n/g, '\n');
    return [name, new Set([hashes[index + 1], sha256(text), sha256(text.replace(/\n/g, '\r\n'))])];
  }));
  return { names, digest, contents, checksums, lockText };
}

async function snapshotMigrations(folder, files) {
  const schema = join(folder, 'schema.prisma');
  const migrations = join(folder, 'migrations');
  await mkdir(migrations, { mode: 0o700 });
  await writeFile(schema, files.contents[0], { flag: 'wx', mode: 0o600 });
  for (const [index, name] of files.names.entries()) {
    await mkdir(join(migrations, name), { mode: 0o700 });
    await writeFile(join(migrations, name, 'migration.sql'), files.contents[index + 1], { flag: 'wx', mode: 0o600 });
  }
  if (files.lockText) await writeFile(join(migrations, 'migration_lock.toml'), files.lockText, { flag: 'wx', mode: 0o600 });
  return { schema, migrations };
}

async function installedPrisma(root, folder) {
  for (let directory = folder; ; directory = dirname(directory)) {
    const manifest = await realpath(join(directory, 'node_modules', 'prisma', 'package.json')).catch(() => null);
    if (manifest && within(root, manifest)) {
      const { version, bin } = JSON.parse(await readFile(manifest, 'utf8'));
      if (!/^7\./.test(version) || typeof bin?.prisma !== 'string') return;
      const entry = await realpath(resolve(dirname(manifest), bin.prisma)).catch(() => null);
      if (entry && within(dirname(manifest), entry)) return entry;
    }
    if (directory === root) return;
  }
}

function setupTarget(project, requirement, connection, payload) {
  if (requirement.status === 'configured') {
    if (!localHosts.includes(requirement.host)) return;
    const value = databaseConnectionValue(connection.value, 'postgres');
    if (!value) throw new Error('Use a direct PostgreSQL URL for guided setup.');
    const url = new URL(value);
    const schema = url.searchParams.get('schema') ?? 'public';
    const sslmode = url.searchParams.get('sslmode') ?? 'prefer';
    if (!databaseName.test(schema) || !['disable', 'prefer', 'require'].includes(sslmode) ||
        [...url.searchParams.keys()].some(key => !['schema', 'sslmode', 'connection_limit', 'connect_timeout', 'pool_timeout'].includes(key))) {
      throw new Error('Use a direct PostgreSQL URL for guided setup.');
    }
    const target = validateLocalTarget({ host: requirement.host, port: requirement.port }, requirement);
    return { target: { ...target, sslmode }, credentials: { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }, schema, value };
  }
  const name = payload.name ?? project.name.replace(/[^\w-]/g, '_').slice(0, 63);
  const host = payload.host ?? '127.0.0.1';
  const port = Number(payload.port ?? 5432);
  const target = validateLocalTarget({ host, port }, { engine: 'postgres', name });
  const credentials = { user: payload.user ?? 'postgres', password: payload.password ?? '' };
  const value = `postgresql://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@${target.host === '::1' ? '[::1]' : target.host}:${port}/${name}`;
  return { target, credentials, schema: 'public', value };
}

async function schemaStatus(session, target, schema) {
  const [header] = (await session.query(`SELECT current_database(), inet_server_addr()::text, inet_server_port(),
    extract(epoch FROM pg_postmaster_start_time())::text,
    (SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()),
    (SELECT count(*) FROM information_schema.tables WHERE table_schema='${schema}' AND table_type='BASE TABLE' AND table_name<>'_prisma_migrations'),
    to_regclass('"${schema}"."_prisma_migrations"') IS NOT NULL;`, target.name)).split(/\r?\n/);
  const [database, address, port, started, oid, count, history] = header.split('\t');
  if (database !== target.name || !address || !/^\d+$/.test(port) || !/^\d+(?:\.\d+)?$/.test(started) || !/^\d+$/.test(oid) ||
      !/^\d+$/.test(count) || !/^[tf]$/.test(history)) throw new Error(changed);
  const rows = history === 't' ? (await session.query(`SELECT migration_name, finished_at IS NOT NULL, rolled_back_at IS NOT NULL, checksum
    FROM "${schema}"."_prisma_migrations" ORDER BY started_at;`, target.name)).split(/\r?\n/).filter(Boolean).map(line => line.split('\t')) : [];
  return { identity: databaseKey(database, address, port, started, oid), tables: Number(count),
    applied: rows.filter(([, finished, rolledBack]) => finished === 't' && rolledBack === 'f').map(([name, , , checksum]) => [name, checksum]),
    failed: rows.some(([, finished, rolledBack]) => finished === 'f' && rolledBack === 'f') };
}

function placeholderEdit(requirement, connection) {
  if (requirement?.status === 'placeholder' && !connection?.environmentConflict && connection?.environmentSources?.length === 1) {
    return requirement.environmentEdit;
  }
}

export async function postgresSetup({ project, payload, command = run, installation = {}, prismaCommand = run, verifyTarget, resolveClient, signal }) {
  if (!['probe', 'inspect', 'create', 'save', 'migrate'].includes(payload.mode)) throw new Error(changed);
  const { root, identity, requirements, connections } = await discoverDatabases(project, { includeConnections: true });
  const requirement = requirements.find(item => item.id === payload.requirementId && item.guidedSetup);
  if (!requirement || !['missing', 'configured', 'placeholder'].includes(requirement.status)) throw new Error('Choose a detected Prisma PostgreSQL configuration.');
  const connection = connections.get(requirement.id);
  const edit = placeholderEdit(requirement, connection);
  if (payload.revision !== undefined && payload.revision !== edit?.revision) throw new Error(changed);
  if (connection.environmentConflict || (requirement.status === 'placeholder' && !edit)) {
    return { status: 'environment-conflict', sources: connection.environmentSources };
  }
  async function verifyEdit() {
    if (!edit) return;
    const latest = await discoverDatabases(project, { includeConnections: true });
    const current = placeholderEdit(latest.requirements.find(item => item.id === requirement.id), latest.connections.get(requirement.id));
    if (payload.revision !== edit.revision || current?.revision !== edit.revision ||
        databaseKey(latest.identity) !== databaseKey(identity)) throw new Error(changed);
  }
  const configured = requirement.status === 'configured';
  const selected = setupTarget(project, requirement, connection, payload);
  if (!selected) return { status: 'remote' };
  const { target, credentials, schema, value } = selected;
  if (configured && requirement.host === 'localhost') {
    const address = await localhostEndpoint(target.port, installation.probe);
    if (!address) return { status: 'loopback-ambiguous' };
    target.host = address;
  }
  const envFile = edit?.file ?? '.env';
  const envPath = requirement.directory === '.' ? envFile : `${requirement.directory}/${envFile}`;
  const summary = { host: target.host, port: target.port, name: target.name, schema, variable: requirement.environmentVariable, envPath };
  const respond = (status, fields) => ({ status, target: summary, ...fields });
  const client = await resolveClient?.(target);
  const container = client && await client.installation(installation.probe);
  if (container && !container.portOpen) return respond(container.serviceStatus === 'stopped' ? 'docker-stopped' : 'docker-unreachable');
  if (payload.mode === 'probe' || !configured && !payload.user) {
    const result = container ?? await localInstallation(target, installation);
    if (!result.portOpen) return respond(result.serviceStatus === 'stopped' ? 'stopped' : 'server');
    return respond(!result.clientVersion ? 'client' : configured ? 'check' : 'credentials');
  }
  const queryCommand = client?.command ?? command;
  const session = localSession(target, credentials, queryCommand, signal);
  let state;
  try { state = await schemaStatus(session, target, schema); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error.issue !== 'database') return respond(error.issue ?? 'connection');
    const binding = { instanceId: requirement.id };
    const options = { project, binding, target, credentials, command: queryCommand, signal };
    let plan;
    try { plan = await initializationPlan(options); }
    catch (failure) { if (failure.name === 'AbortError') throw failure; return respond(failure.issue ?? 'connection'); }
    if (plan.state.exists) return respond('connection');
    const planId = plan.steps.includes('create') && plan.state.fingerprint ? plan.id : undefined;
    if (payload.mode === 'create') {
      if (!planId) throw new Error(changed);
      await executeInitialization({ ...options, id: payload.planId, confirmName: payload.confirmName,
        revalidate: async () => { await verifyTarget(target); await verifyEdit(); }, recordMigration: async () => {} });
      return respond(configured ? 'check' : 'configure');
    }
    return respond('database', { planId });
  }
  if (!configured) {
    if (payload.mode !== 'save') return respond('configure');
    await verifyEdit();
    await saveDatabaseEnvironment(project, { requirementId: requirement.id, value, revision: edit?.revision }, signal);
    return respond('check');
  }

  const folder = resolve(root, requirement.directory);
  const files = await inspectPrismaFiles({ root, folder, connection });
  if (!files) return respond('migrations-unavailable', { tables: state.tables });
  const matchesHistory = candidate => !candidate.failed && candidate.applied.every(([name, checksum]) => files.checksums.get(name)?.has(checksum));
  const applied = new Set(state.applied.map(([name]) => name));
  const pending = files.names.filter(name => !applied.has(name));
  if (!matchesHistory(state) || (state.tables && !state.applied.length)) return respond('migration-conflict', { tables: state.tables });
  if (!pending.length && state.tables > 0) return respond('ready', { tables: state.tables });
  if (!pending.length) return respond('empty');
  const cli = await installedPrisma(root, folder);
  if (!cli) return respond('prisma-client', { pending });
  const planId = databaseKey(salt, project.id, requirement.id, identity, state.identity, files.digest, value, pending, cli);
  if (payload.mode !== 'migrate') return respond('migration', { pending, planId, tables: state.tables });
  if (payload.planId !== planId || payload.confirmName !== target.name) throw new Error(changed);
  await verifyTarget(target);
  const latest = await discoverDatabases(project, { includeConnections: true });
  const latestConnection = latest.connections.get(requirement.id);
  if (latestConnection?.value !== value || latestConnection.environmentConflict || databaseKey(latest.identity) !== databaseKey(identity)) throw new Error(changed);
  const current = await schemaStatus(session, target, schema);
  if (databaseKey(current) !== databaseKey(state) || (await inspectPrismaFiles({ root, folder, connection }))?.digest !== files.digest) throw new Error(changed);
  const tempRoot = optionsDirectory(installation.directory, root);
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(tempRoot, 'prisma-'));
  try {
    const snapshot = await snapshotMigrations(temp, files);
    const config = join(temp, 'prisma.config.mjs');
    await writeFile(config, `export default { schema: ${JSON.stringify(snapshot.schema)}, migrations: { path: ${JSON.stringify(snapshot.migrations)} }, datasource: { url: process.env.STACKFORGE_PRISMA_DATABASE_URL } };`, { flag: 'wx', mode: 0o600 });
    await resolveStartup(project, [], identity);
    throwIfCancelled(signal);
    const migrationUrl = new URL(value);
    migrationUrl.hostname = target.host === '::1' ? '[::1]' : target.host;
    try {
      await prismaCommand(process.execPath, [cli, 'migrate', 'deploy', '--config', config], {
        cwd: folder, env: { ...process.env, STACKFORGE_PRISMA_DATABASE_URL: migrationUrl.href, PRISMA_HIDE_UPDATE_MESSAGE: '1' }, signal, timeout: 120000
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      const code = /^Error: (P\d{4})\b/m.exec(error.message)?.[1];
      return respond('migration-failed', code ? { code } : {});
    }
    const after = await schemaStatus(session, target, schema);
    const complete = matchesHistory(after) && files.names.every(name => after.applied.some(([applied]) => applied === name));
    return respond(after.identity === state.identity && complete && after.tables > 0 ? 'ready' : 'migration-conflict', { tables: after.tables });
  } finally { await rm(temp, { recursive: true, force: true }); }
}

function optionsDirectory(directory, root) {
  if (!directory || !isAbsolute(directory) || directory === root) throw new Error('StackForge could not prepare a local Prisma verification directory.');
  return directory;
}
