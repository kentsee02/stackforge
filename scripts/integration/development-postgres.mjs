import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
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
const migrationSql = ['CREATE TABLE drizzle_first (id integer);\n',
  'CREATE TABLE drizzle_second (id integer, old_label text, obsolete text);\n' +
  'ALTER TABLE drizzle_second RENAME COLUMN old_label TO label;\nALTER TABLE drizzle_second DROP COLUMN obsolete;\n' +
  "INSERT INTO drizzle_second (id, label) VALUES (1, 'reviewed');\n"];
const entries = migrationSql.map((_, idx) => ({ idx, version: '7', when: 1726443359662 + idx,
  tag: '000' + idx + '_create', breakpoints: true }));
try {
  await mkdir(join(path, 'prisma'), { recursive: true });
  await writeFile(join(path, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" }');
  await writeFile(join(path, 'prisma.config.ts'), definition);
  await mkdir(join(path, 'backend/migrations/versions'), { recursive: true });
  await mkdir(join(path, 'services/reports/data'), { recursive: true });
  await writeFile(join(path, 'services/reports/data/Reports.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
  const efIds = ['20260102123456_CreateReports', '20260202123456_AddTags'];
  for (const migration of efIds) {
    const name = migration.split('_')[1];
    await writeFile(join(path, 'services/reports/data', name + '.cs'), [
      'using Microsoft.EntityFrameworkCore.Migrations;',
      'using Microsoft.EntityFrameworkCore.Infrastructure;',
      'namespace Reports.Data;',
      '[DbContext(typeof(ReportsContext))]',
      '[Migration("' + migration + '")]',
      'public class ' + name + ' : Migration { }'
    ].join('\n'));
  }
  await writeFile(join(path, 'backend/alembic.ini'), '[alembic]\nscript_location = %(here)s/migrations\n');
  for (const [revision, parent, dependency] of [['base', 'None', 'None'], ['audit', "'base'", 'None'],
    ['views', "'base'", 'None'], ['tip', "'views'", "'audit'"]]) {
    await writeFile(join(path, 'backend/migrations/versions', revision + '.py'),
      `revision = '${revision}'\ndown_revision = ${parent}\ndepends_on = ${dependency}\n`);
  }
  await mkdir(join(path, 'sql'), { recursive: true });
  await writeFile(join(path, 'flyway.conf'), 'flyway.locations=filesystem:sql\n');
  await writeFile(join(path, 'sql/V01_0__create.sql'), '\uFEFFCREATE TABLE flyway_example(id int);\r\n');
  await writeFile(join(path, 'sql/R__refresh.sql'), 'SELECT 1;\n');
  await writeFile(join(path, 'liquibase.properties'), 'changeLogFile=changes.xml\n');
  await writeFile(join(path, 'changes.xml'), '<databaseChangeLog><changeSet id="first" author="app"/><changeSet id="second" author="app"/></databaseChangeLog>\n');
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
  const target = (await read()).options.find(item => item.engine === 'postgres' && item.canCreate);
  const options = { name: 'portal', port, targetId: target.id };
  await api(endpoint, { mode: 'preview', ...options }, 403, false);
  assert.match((await action({ mode: 'preview', ...options }, 409)).error, /free port/);
  await new Promise(resolve => listener.close(resolve));
  listener = undefined;
  const { plan } = await action({ mode: 'preview', ...options });
  assert.equal((await read()).status, 'absent');
  await writeFile(join(path, '.env.example'), 'DATABASE_URL=mysql://example:example@localhost/app\n');
  await action({ mode: 'create', plan, ...options, confirm: 'portal' }, 409);
  await rm(join(path, '.env.example'));
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
  const sourceId = initialDiscovery.migrationSources.find(source => source.adapter === 'alembic').id;
  const efSourceId = initialDiscovery.migrationSources.find(source => source.adapter === 'ef-core').id;
  const efLocal = await api(id + '/database-ef-core-preview', { sourceId: efSourceId });
  const { id: efTarget } = initialDiscovery.efCoreTargets.find(item => item.projectPostgres);
  const readEf = (fields = {}, expected = 200) => api(id + '/database-ef-core-preview', {
    sourceId: efSourceId, targetId: efTarget, groupId: efLocal.groups[0].id, ...fields
  }, expected);
  await readEf({ schema: "public';" }, 409);
  await readEf({ groupId: 'a'.repeat(64) }, 409);
  assert.equal((await readEf()).database.status, 'history-missing');
  await query('CREATE TABLE public."__EFMigrationsHistory" ("MigrationId" varchar(150) PRIMARY KEY, "ProductVersion" varchar(32) NOT NULL)');
  await query('INSERT INTO public."__EFMigrationsHistory" VALUES (\'' + efIds[0] + "', '9.0.0')");
  assert.deepEqual((await readEf()).database.migrations, [{ id: efIds[0], state: 'applied' }, { id: efIds[1], state: 'pending' }]);
  await query('INSERT INTO public."__EFMigrationsHistory" VALUES (\'' + efIds[1] + "', '9.0.0')");
  assert.equal((await readEf()).database.status, 'current');
  await query('ALTER TABLE public."__EFMigrationsHistory" ENABLE ROW LEVEL SECURITY');
  assert.equal((await readEf()).database.status, 'history-unavailable');
  await query('ALTER TABLE public."__EFMigrationsHistory" DISABLE ROW LEVEL SECURITY');
  await query('CREATE SCHEMA reporting; ALTER TABLE public."__EFMigrationsHistory" SET SCHEMA reporting; ' +
    'ALTER TABLE reporting."__EFMigrationsHistory" RENAME TO "ReportHistory"');
  const custom = { schema: 'reporting', table: 'ReportHistory' };
  assert.equal((await readEf(custom)).database.status, 'current');
  await query('INSERT INTO reporting."ReportHistory" VALUES (\'private_unknown_migration\', \'9.0.0\')');
  const divergentEf = await readEf(custom);
  assert.equal(divergentEf.database.status, 'history-conflict');
  assert.doesNotMatch(JSON.stringify(divergentEf), /private_unknown_migration/);
  await query('DROP TABLE reporting."ReportHistory"; DROP SCHEMA reporting');
  const { id: alembicTarget } = initialDiscovery.alembicTargets.find(item => item.projectPostgres);
  const sqlTarget = initialDiscovery.sqlMigrationTargets.find(item => item.projectPostgres);
  const sqlHistory = (adapter, selection = {}, expected = 200) =>
    api(id + '/database-' + adapter + '-preview', { sourceId: initialDiscovery.migrationSources.find(item => item.adapter === adapter).id,
      targetId: sqlTarget.id, ...selection }, expected);
  assert.equal((await sqlHistory('flyway')).database.status, 'history-missing');
  assert.equal((await sqlHistory('liquibase')).database.status, 'history-missing');
  await sqlHistory('liquibase', { table: 'bad"; DROP TABLE x;' }, 409);
  await query(`CREATE SCHEMA migration_tracking;
    CREATE TABLE migration_tracking.flyway_log (installed_rank integer PRIMARY KEY, version varchar(50), script varchar(1000),
      type varchar(20), checksum integer, success boolean);
    INSERT INTO migration_tracking.flyway_log VALUES (1, '1', 'V01_0__create.sql', 'SQL',
      ${crc32('CREATE TABLE flyway_example(id int);') | 0}, true), (2, NULL, 'R__refresh.sql', 'SQL', 0, true);
    CREATE TABLE databasechangelog (id varchar(255), author varchar(255), filename varchar(255), exectype varchar(10));
    INSERT INTO databasechangelog VALUES ('first', 'app', 'changes.xml', 'MARK_RAN');`);
  const flywayTable = { schema: 'migration_tracking', table: 'flyway_log' };
  assert.deepEqual((await sqlHistory('flyway', flywayTable)).database.items, [{ state: 'applied' }, { state: 'outdated' }]);
  assert.deepEqual((await sqlHistory('liquibase')).database.items, [{ state: 'marked' }, { state: 'pending' }]);
  await query(`UPDATE migration_tracking.flyway_log SET checksum = 0 WHERE installed_rank = 1;
    INSERT INTO databasechangelog VALUES ('different', 'app', 'other.xml', 'EXECUTED');`);
  assert.equal((await sqlHistory('flyway', flywayTable)).database.status, 'history-conflict');
  assert.equal((await sqlHistory('liquibase')).database.status, 'history-conflict');
  await query(`ALTER TABLE databasechangelog ENABLE ROW LEVEL SECURITY;`);
  assert.equal((await sqlHistory('liquibase')).database.status, 'history-unavailable');
  await query('DROP TABLE databasechangelog, migration_tracking.flyway_log; DROP SCHEMA migration_tracking;');
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
  await query('ALTER TABLE alembic_version RENAME TO app_alembic_history;');
  const customAlembic = await api(id + '/database-alembic-preview', { sourceId, targetId: alembicTarget, table: 'app_alembic_history' });
  assert.equal(customAlembic.database.status, 'current');
  await query('ALTER TABLE app_alembic_history RENAME TO alembic_version;');
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
  const efReader = (await api(id + '/database-discovery')).efCoreTargets.find(item => item.variable === 'HISTORY_DATABASE_URL');
  await query('CREATE TABLE public."__EFMigrationsHistory" ("MigrationId" varchar(150) PRIMARY KEY, "ProductVersion" varchar(32) NOT NULL)');
  assert.equal((await readEf({ targetId: efReader.id })).database.status, 'permission');
  await query('GRANT SELECT ON public."__EFMigrationsHistory" TO history_reader');
  assert.equal((await readEf({ targetId: efReader.id })).database.status, 'pending');
  await query('DROP TABLE public."__EFMigrationsHistory"');
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
  await writeFile(secondFile, "COPY drizzle_first FROM '/unavailable';");
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
  await writeFile(secondFile, "CREATE TABLE drizzle_second (id integer);\nUPDATE project_history.migrations SET hash = 'tampered';");
  const tamperedPlan = await drizzlePreview();
  assert.match(tamperedPlan.reviewSql, /UPDATE project_history\.migrations/);
  assert.equal((await applyDrizzle(tamperedPlan)).status, 'apply-failed');
  assert.equal((await query("SELECT to_regclass('public.drizzle_second') IS NULL AND count(*) = 1 AND every(hash <> 'tampered') " +
    'FROM project_history.migrations')).trim(), 't');
  await writeFile(secondFile, migrationSql[1]);
  const remaining = await drizzlePreview();
  assert.deepEqual(remaining.migrations.map(item => item.state), ['applied', 'pending']);
  assert.match(remaining.reviewSql, /RENAME COLUMN[\s\S]*DROP COLUMN[\s\S]*INSERT INTO/);
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
  assert.equal((await query('SELECT label FROM drizzle_second WHERE id = 1')).trim(), 'reviewed');
  assert.equal((await query("SELECT count(*) FROM information_schema.columns WHERE table_name='drizzle_second' AND column_name='obsolete'")).trim(), '0');
  await applyDrizzle(pending, 'portal', 409);
  assert.equal((await drizzlePreview()).status, 'current');
  const rollbackInput = { operation: 'rollback', revision: entries[0].tag, scriptFile: 'drizzle-undo.sql' };
  const rollbackPreview = (selection, expected = 200) =>
    api(id + '/database-drizzle-preview', { requirementId: drizzle.id, ...selection }, expected);
  const rollbackDrizzle = (plan, expected = 200) => api(id + '/database-drizzle-apply',
    { requirementId: drizzle.id, ...rollbackInput, planId: plan.planId, confirmName: 'portal' }, expected);
  await rollbackPreview({ ...rollbackInput, scriptFile: '../outside.sql' }, 409);
  const rollbackFile = join(path, rollbackInput.scriptFile);
  await writeFile(rollbackFile, 'DROP TABLE drizzle_second;\nALTER TABLE unavailable RENAME TO another;');
  const failingRollback = await rollbackPreview(rollbackInput);
  assert.equal((await rollbackDrizzle(failingRollback)).status, 'apply-failed');
  assert.equal((await query("SELECT to_regclass('public.drizzle_second') IS NOT NULL AND count(*) = 2 FROM project_history.migrations")).trim(), 't');
  await writeFile(rollbackFile, 'DROP TABLE drizzle_second;\nINSERT INTO drizzle_first(id) VALUES ((SELECT 777 FROM pg_sleep(90)));');
  const slowRollback = await rollbackPreview(rollbackInput);
  const activeRollback = new AbortController();
  const runningRollback = fetch(origin + '/api/projects/' + id + '/database-drizzle-apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, signal: activeRollback.signal,
    body: JSON.stringify({ requirementId: drizzle.id, ...rollbackInput, planId: slowRollback.planId, confirmName: 'portal' })
  }).catch(error => error);
  try {
    let sleeping = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      sleeping = (await query("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'stackforge_migration_%' AND wait_event='PgSleep';")).trim() === '1';
      if (sleeping) break;
      await delay(400);
    }
    assert.equal(sleeping, true);
  } finally { activeRollback.abort(); }
  assert.equal((await runningRollback).name, 'AbortError');
  const operationFile = join(root, 'state', 'database-operations.jsonl');
  let cancelled;
  for (let attempt = 0; attempt < 60; attempt++) {
    cancelled = (await readFile(operationFile, 'utf8')).split('\n').some(line => {
      if (!line) return false;
      const action = JSON.parse(line);
      return action.projectId === id && action.action === 'database-rollback' && action.status === 'cancelled';
    });
    if (cancelled) break;
    await delay(300);
  }
  assert.equal(cancelled, true);
  assert.equal((await query("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'stackforge_migration_%';")).trim(), '0');
  assert.equal((await query("SELECT to_regclass('public.drizzle_second') IS NOT NULL AND count(*) = 2 FROM project_history.migrations")).trim(), 't');
  await writeFile(rollbackFile, 'DROP TABLE drizzle_second;\n');
  const approvedRollback = await rollbackPreview(rollbackInput);
  assert.equal(approvedRollback.status, 'rollback-planned');
  assert.deepEqual([approvedRollback.fromRevision, approvedRollback.toRevision], [entries[1].tag, entries[0].tag]);
  assert.match(approvedRollback.reviewSql, /DROP TABLE drizzle_second/);
  await writeFile(rollbackFile, '-- changed after review\n', { flag: 'a' });
  await rollbackDrizzle(approvedRollback, 409);
  const reverted = await rollbackDrizzle(await rollbackPreview(rollbackInput));
  assert.equal(reverted.status, 'rolled-back');
  assert.deepEqual(reverted.migrations.map(item => item.state), ['applied', 'pending']);
  assert.equal((await query("SELECT to_regclass('public.drizzle_second') IS NULL AND count(*) = 1 FROM project_history.migrations")).trim(), 't');
  assert.equal((await applyDrizzle(await drizzlePreview())).status, 'applied');
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
  assert.match((await api(id + '/remove', { confirmName: 'portal' }, 409)).error, /dedicated database volume/);
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

  options.targetId = (await read()).options.find(item => item.engine === 'postgres' && item.canCreate).id;
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
