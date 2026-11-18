import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../src/http/server.mjs';
import { run } from '../../src/platform/process.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-development-postgres-')));
const path = join(root, 'portal');
const shared = join(root, 'another-project');
const stateDir = join(root, 'state', 'jobs');
const stateFile = join(root, 'state', 'databases.json');
const docker = (args, options = {}) => run('docker', args, { stdoutOnly: true, timeout: 60000, ...options });
let app, origin, token, listener, id, movedContainer;

async function startApp() {
  const missingHostClient = async () => { throw new Error('ENOENT'); };
  app = createApp({ stateDir, localDatabase: { command: missingHostClient }, databaseAdapters: { command: missingHostClient } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  origin = 'http://127.0.0.1:' + app.address().port;
  token = (await fetch(origin + '/api/state').then(result => result.json())).token;
}

async function stopApp() {
  if (!app) return;
  await app.shutdownTasks();
  await new Promise((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  app = undefined;
}

async function api(path, body, expected = 200, authorized = true) {
  const response = await fetch(origin + '/api/projects/' + path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': authorized ? token : '' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.status, expected, data.error);
  return data;
}

const definition = 'import "dotenv/config";\nexport default { datasource: { url: env("DATABASE_URL") } };\n';
const migrationSql = ['CREATE TABLE drizzle_first (id integer);\n', 'CREATE TABLE drizzle_second (id integer);\n'];
const entries = migrationSql.map((_, idx) => ({ idx, version: '7', when: 1726443359662 + idx,
  tag: '000' + idx + '_create', breakpoints: true }));
try {
  await mkdir(join(path, 'prisma'), { recursive: true });
  await writeFile(join(path, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" }');
  await writeFile(join(path, 'prisma.config.ts'), definition);
  await mkdir(join(path, 'backend/migrations/versions'), { recursive: true });
  await writeFile(join(path, 'backend/alembic.ini'), '[alembic]\nscript_location = %(here)s/migrations\n');
  for (const [revision, parent, dependency] of [['base', 'None', 'None'], ['audit', "'base'", 'None'],
    ['views', "'base'", 'None'], ['tip', "'views'", "'audit'"]]) {
    await writeFile(join(path, 'backend/migrations/versions', revision + '.py'),
      `revision = '${revision}'\ndown_revision = ${parent}\ndepends_on = ${dependency}\n`);
  }
  await mkdir(join(path, 'db/migrations/meta'), { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify({ devDependencies: { 'drizzle-kit': '^0.31.1' } }));
  await writeFile(join(path, 'drizzle.config.ts'), `import { defineConfig } from 'drizzle-kit';
    export default defineConfig({ dialect: 'postgresql', out: './db/migrations', dbCredentials: { url: process.env.DATABASE_URL! },
      migrations: { schema: 'project_history', table: 'migrations' } });`);
  await writeFile(join(path, 'db/migrations/meta/_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }));
  for (const { idx, tag } of entries) await writeFile(join(path, 'db/migrations', tag + '.sql'), migrationSql[idx]);
  await writeFile(join(path, '.gitignore'), '.env\n');
  await run('git', ['init'], { cwd: path });
  await startApp();
  ({ id } = await api('import', { path }, 201));
  const endpoint = id + '/database-development';
  const read = () => api(endpoint);
  const action = (body, status) => api(endpoint, body, status);
  assert.equal((await read()).status, 'absent');
  listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  const options = { name: 'portal', port };
  await api(endpoint, { mode: 'preview', ...options }, 403, false);
  assert.match((await action({ mode: 'preview', ...options }, 409)).error, /free port/);
  await new Promise(resolve => listener.close(resolve));
  listener = undefined;
  const { plan } = await action({ mode: 'preview', ...options });
  assert.equal((await read()).status, 'absent');
  await action({ mode: 'create', plan, ...options, confirm: 'wrong' }, 409);
  await action({ mode: 'create', plan, ...options, confirm: 'portal' });
  let status;
  for (let i = 0; i < 30; i++) {
    status = await read();
    if (status.status === 'ready') break;
    await delay(1000);
  }
  assert.equal(status.status, 'ready');
  const { volume, connections } = status;
  const container = volume.slice(0, -'-data'.length);
  assert.equal(await docker(['port', container, '5432']).then(value => value.trim()), '127.0.0.1:' + port);
  assert.equal(connections[0].variable, 'DATABASE_URL');
  const { key, container: identity } = JSON.parse(await readFile(stateFile, 'utf8')).development[id];
  const query = statement => docker(['exec', identity, 'psql', '-XAtw', '-U', 'stackforge', '-d', 'portal', '-c', statement]);
  const initialDiscovery = await api(id + '/database-discovery');
  const sourceId = initialDiscovery.migrationSources[0].id;
  const { id: alembicTarget } = initialDiscovery.alembicTargets.find(item => item.projectPostgres);
  const alembic = (target = alembicTarget, expected = 200) => api(id + '/database-alembic-preview', { sourceId, targetId: target }, expected);
  await alembic('a'.repeat(64), 409);
  const emptyHistory = (await alembic()).database;
  assert.equal(emptyHistory.status, 'pending', JSON.stringify(emptyHistory));
  assert.deepEqual(emptyHistory.heads, []);
  assert.equal((await query("SELECT to_regclass('public.alembic_version') IS NULL")).trim(), 't');
  await query('CREATE TABLE before_migrations (id integer)');
  assert.equal((await alembic()).database.status, 'history-missing');
  await query(`CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY);
    INSERT INTO alembic_version VALUES ('audit'), ('views');`);
  const branches = (await alembic()).database;
  assert.equal(branches.status, 'pending');
  assert.deepEqual(branches.heads, ['audit', 'views']);
  assert.deepEqual(branches.revisions.filter(item => item.state === 'pending').map(item => item.revision), ['tip']);
  await query("TRUNCATE alembic_version; INSERT INTO alembic_version VALUES ('tip');");
  const checked = (await alembic()).database;
  assert.equal(checked.status, 'current');
  assert.deepEqual(checked.heads, ['tip']);
  assert.ok(checked.revisions.every(item => item.state === 'applied'));
  await query('ALTER TABLE alembic_version ENABLE ROW LEVEL SECURITY');
  assert.equal((await alembic()).database.status, 'history-unavailable');
  await query("ALTER TABLE alembic_version DISABLE ROW LEVEL SECURITY; UPDATE alembic_version SET version_num = 'private_unknown_row';");
  const diverged = await alembic();
  assert.equal(diverged.database.status, 'history-conflict');
  assert.doesNotMatch(JSON.stringify(diverged), /private_unknown_row/);
  assert.equal((await query('SELECT version_num FROM alembic_version')).trim(), 'private_unknown_row');
  const result = await action({ mode: 'save', requirementId: connections[0].id });
  assert.deepEqual(result, { saved: true, file: '.env' });
  const stored = await readFile(join(path, '.env'), 'utf8');
  const password = /stackforge:([a-f\d]{48})@/.exec(stored)?.[1];
  assert.ok(password);
  assert.equal(JSON.stringify(await read()).includes(password), false);
  assert.equal((await readFile(stateFile, 'utf8')).includes(password), false);
  const discovery = await api(id + '/database-discovery');
  const configuredAlembic = discovery.alembicTargets.find(item => !item.projectPostgres);
  assert.equal((await alembic(configuredAlembic.id)).database.status, 'history-conflict');
  assert.equal(JSON.stringify(discovery.alembicTargets).includes(password), false);
  const historyPassword = randomBytes(12).toString('hex');
  await query(`CREATE ROLE history_reader LOGIN PASSWORD '${historyPassword}'; UPDATE alembic_version SET version_num = 'tip';`);
  await writeFile(join(path, '.env'), stored + '\nHISTORY_DATABASE_URL=postgresql://history_reader:' + historyPassword + '@127.0.0.1:' + port + '/portal\n');
  const readerTargets = (await api(id + '/database-discovery')).alembicTargets;
  assert.equal(JSON.stringify(readerTargets).includes(historyPassword), false);
  const reader = readerTargets.find(item => !item.projectPostgres && item.id !== configuredAlembic.id);
  assert.equal((await alembic(reader.id)).database.status, 'permission');
  await query('GRANT SELECT ON alembic_version TO history_reader');
  assert.equal((await alembic(reader.id)).database.status, 'current');
  await writeFile(join(path, '.env'), stored);
  await query('DROP TABLE alembic_version, before_migrations');
  const drizzle = discovery.requirements.find(item => item.migrationAdapter === 'drizzle');
  assert.equal(drizzle.status, 'configured');
  const drizzlePreview = () => api(id + '/database-drizzle-preview', { requirementId: drizzle.id });
  const pending = await drizzlePreview();
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.migrations.map(item => item.state), ['pending', 'pending']);
  assert.equal((await query("SELECT to_regclass('public.drizzle_first') IS NULL")).trim(), 't');
  assert.equal(JSON.stringify(pending).includes(password), false);
  const applyDrizzle = (preview, confirmName = 'portal', expected = 200) =>
    api(id + '/database-drizzle-apply', { requirementId: drizzle.id, planId: preview.planId, confirmName }, expected);
  await applyDrizzle(pending, 'wrong', 409);
  const secondFile = join(path, 'db/migrations', entries[1].tag + '.sql');
  await writeFile(secondFile, 'DROP TABLE drizzle_first;');
  assert.equal((await drizzlePreview()).applyBlocked, true);
  await applyDrizzle(pending, 'portal', 409);
  await writeFile(secondFile, 'CREATE TABLE drizzle_second (id type_that_does_not_exist);');
  assert.equal((await applyDrizzle(await drizzlePreview())).status, 'apply-failed');
  assert.equal((await query("SELECT to_regclass('public.drizzle_first') IS NULL AND to_regclass('project_history.migrations') IS NULL")).trim(), 't');
  await writeFile(secondFile, migrationSql[1]);
  const journal = join(path, 'db/migrations/meta/_journal.json');
  const writeJournal = selected => writeFile(journal, JSON.stringify({ version: '7', dialect: 'postgresql', entries: selected }));
  await writeJournal(entries.slice(0, 1));
  assert.equal((await applyDrizzle(await drizzlePreview())).status, 'applied');
  await writeJournal(entries);
  const remaining = await drizzlePreview();
  assert.deepEqual(remaining.migrations.map(item => item.state), ['applied', 'pending']);
  const sharedMigration = join(root, 'shared-migration');
  await mkdir(sharedMigration);
  await writeFile(join(sharedMigration, '.env'), stored);
  const otherMigration = await api('import', { path: sharedMigration }, 201);
  const blocked = await applyDrizzle(remaining, 'portal', 409);
  assert.match(blocked.error, /Another project uses this PostgreSQL database/);
  await api(otherMigration.id + '/remove', { confirmName: otherMigration.name });
  const applied = await applyDrizzle(remaining);
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  assert.deepEqual(applied.migrations.map(item => item.state), ['applied', 'applied']);
  assert.equal((await query("SELECT to_regclass('public.drizzle_first') IS NOT NULL AND to_regclass('public.drizzle_second') IS NOT NULL")).trim(), 't');
  await applyDrizzle(pending, 'portal', 409);
  assert.equal((await drizzlePreview()).status, 'current');
  const altered = join(path, 'db/migrations', entries[0].tag + '.sql');
  await writeFile(altered, migrationSql[0] + '-- changed after application\n');
  assert.equal((await drizzlePreview()).status, 'history-conflict');
  await writeFile(altered, migrationSql[0]);
  await query('DROP TABLE drizzle_first, drizzle_second; DROP SCHEMA project_history CASCADE; CREATE TABLE proof (value integer); INSERT INTO proof VALUES (42);');
  assert.equal((await drizzlePreview()).status, 'history-conflict');
  const requirement = discovery.requirements.find(item => item.guidedSetup);
  const binding = discovery.bindings.find(item => item.requirementId === requirement.id);
  const local = () => api(id + '/database-local-check', { bindingId: binding.id }).then(result => result.installation);
  const prisma = () => api(id + '/database-postgres-setup', { mode: 'inspect', requirementId: requirement.id });
  assert.deepEqual(await local(), { kind: 'project-docker', serviceStatus: 'running', portOpen: true,
    clientVersion: (await docker(['exec', identity, 'psql', '--version'])).match(/\b17\.\d+\b/)[0] });
  const schema = await prisma();
  assert.equal(schema.status, 'migrations-unavailable');
  assert.equal(schema.tables, 1);
  assert.equal(JSON.stringify(schema).includes(password), false);

  const transferStatus = (status = 200) => api(id + '/database-local-status', { bindingId: binding.id }, status);
  const source = await transferStatus();
  assert.deepEqual(source.capabilities, { connect: true, backup: true, restore: false });
  assert.equal(source.restoreHint, 'Restore requires an empty database.');
  assert.equal(JSON.stringify(source).includes(password), false);
  const archive = (action = '', body = '{}', extra = {}) => fetch(origin + '/api/projects/' + id + '/database-archive' + action, {
    method: 'POST', headers: { 'X-StackForge-Token': token, 'X-StackForge-Binding': binding.id,
      'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream', ...extra }, body
  });
  const downloaded = await archive();
  assert.equal(downloaded.status, 200, downloaded.ok ? '' : await downloaded.text());
  const backup = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(backup.subarray(0, 16).toString(), 'STACKFORGE-DB-1\n');
  await query('DROP TABLE proof');
  assert.equal((await transferStatus()).restoreHint, 'Restore requires a non-superuser account with permission on the target database.');
  const restorePassword = randomBytes(24).toString('hex');
  await query(`CREATE ROLE restore_user LOGIN PASSWORD '${restorePassword}';
    GRANT CREATE ON SCHEMA public TO restore_user;
    GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO restore_user;`);
  await writeFile(join(path, '.env'), 'DATABASE_URL=postgresql://restore_user:' + restorePassword + '@127.0.0.1:' + port + '/portal\n');
  try {
    assert.equal((await transferStatus()).capabilities.restore, true);
    const previewResponse = await archive('/preview', backup);
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200, preview.error);
    const restoreResponse = await archive('/restore', backup, { 'X-StackForge-Preview': preview.id,
      'X-StackForge-Target': Buffer.from(preview.name).toString('base64') });
    assert.deepEqual(await restoreResponse.json(), { restored: true, objects: preview.objects, limited: false });
    assert.equal((await query('SELECT value FROM proof')).trim(), '42');
  } finally {
    await writeFile(join(path, '.env'), stored);
  }
  await action({ mode: 'delete', confirm: volume }, 409);
  assert.match((await api(id + '/remove', { confirmName: 'portal' }, 409)).error, /dedicated PostgreSQL volume/);
  await action({ mode: 'stop' });
  assert.equal((await read()).status, 'stopped');
  assert.equal((await alembic()).database.status, 'container-stopped');
  assert.deepEqual(await local(), { kind: 'project-docker', serviceStatus: 'stopped', portOpen: false });
  assert.equal((await prisma()).status, 'docker-stopped');
  assert.match((await transferStatus(409)).error, /Open Project PostgreSQL/);
  await stopApp();
  await startApp();
  assert.equal((await read()).status, 'stopped');
  await action({ mode: 'start' });
  for (let i = 0; i < 30 && (await read()).status !== 'ready'; i++) await delay(1000);
  assert.equal((await query('SELECT value FROM proof')).trim(), '42');
  await action({ mode: 'stop' });
  await mkdir(shared);
  await writeFile(join(shared, '.env'), 'DATABASE_URL=postgresql://user:password@127.0.0.1:' + port + '/other_database\n');
  const other = await api('import', { path: shared }, 201);
  assert.match((await action({ mode: 'delete', confirm: volume }, 409)).error, /Another project/);
  await api(other.id + '/remove', { confirmName: other.name });
  await action({ mode: 'delete', confirm: 'wrong' }, 409);

  movedContainer = container + '-fixture-original';
  await docker(['container', 'rename', identity, movedContainer]);
  let replacement;
  try {
    replacement = (await docker(['container', 'create', '--name', container, '--label', 'stackforge.integration=' + key,
      'docker.io/library/postgres:17'])).trim();
    assert.equal((await alembic()).database.status, 'target-changed');
    assert.match((await transferStatus(409)).error, /could not be verified/);
    assert.match((await action({ mode: 'delete', confirm: volume }, 409)).error, /could not be verified/);
    await docker(['container', 'inspect', replacement]);
  } finally {
    if (replacement) await docker(['container', 'rm', '-v', replacement]);
    await docker(['container', 'rename', identity, container]);
    movedContainer = undefined;
  }
  await action({ mode: 'delete', confirm: volume });
  assert.equal((await read()).status, 'absent');
  await assert.rejects(docker(['volume', 'inspect', volume]), /no such volume/i);
  assert.ok((await readFile(join(path, '.env'), 'utf8')).includes(password));

  const nextPlan = await action({ mode: 'preview', ...options });
  await action({ mode: 'create', plan: nextPlan.plan, ...options, confirm: 'portal' });
  await alembic(alembicTarget, 409);
  await action({ mode: 'stop' });
  const second = JSON.parse(await readFile(stateFile, 'utf8')).development[id];
  const secondVolume = 'stackforge-pg-' + second.key + '-data';
  await docker(['container', 'rm', second.container]);
  await docker(['volume', 'rm', secondVolume]);
  await docker(['volume', 'create', '--label', 'stackforge.integration=' + second.key, secondVolume]);
  try {
    assert.match((await action({ mode: 'delete', confirm: secondVolume }, 409)).error, /could not be verified/);
    await docker(['volume', 'inspect', secondVolume]);
  } finally { await docker(['volume', 'rm', secondVolume]); }
  await action({ mode: 'delete', confirm: secondVolume });
  await api(id + '/remove', { confirmName: 'portal' });
  console.log('Verified dedicated PostgreSQL, including Alembic history, local connection checks, backup and scoped restore without host clients.');
} finally {
  if (listener) await new Promise(resolve => listener.close(resolve));
  await stopApp();
  const record = await readFile(stateFile, 'utf8').then(text => JSON.parse(text).development[id], () => undefined);
  if (record && /^[a-f\d]{32}$/.test(record.key)) {
    const name = 'stackforge-pg-' + record.key;
    for (const container of [name, movedContainer].filter(Boolean)) {
      const owner = await docker(['container', 'inspect', '--format', '{{index .Config.Labels "io.stackforge.development-postgres"}}', container]).catch(() => '');
      if (owner.trim() === record.key) await docker(['container', 'rm', '-f', container]);
    }
    const volume = name + '-data';
    const owner = await docker(['volume', 'inspect', '--format', '{{index .Labels "io.stackforge.development-postgres"}}', volume]).catch(() => '');
    if (owner.trim() === record.key) await docker(['volume', 'rm', volume]);
  }
  await rm(root, { recursive: true, force: true });
}
