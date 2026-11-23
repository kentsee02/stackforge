import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../src/http/server.mjs';
import { run } from '../../src/platform/process.mjs';
import { cloneGithub } from '../../src/projects/project-clone.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-native-migrations-')));
const stateDir = join(root, 'state', 'jobs');
const stateFile = join(root, 'state', 'databases.json');
const operationFile = join(root, 'state', 'database-operations.jsonl');
const docker = args => run('docker', args, { stdoutOnly: true, timeout: 30000 });
const records = new Set();
const repository = 'https://github.com/stackforge-test/liquibase-fixture';
const app = createApp({ stateDir, clone(url, parent, options) {
  return cloneGithub(url, parent, { ...options, command(program, args, config) {
    assert.equal(program, 'git');
    const separator = args.indexOf('--');
    assert.equal(args[separator + 1], repository + '.git');
    return run(program, ['-c', 'protocol.file.allow=always', ...args.slice(0, separator + 1), join(root, 'liquibase'), args.at(-1)], config);
  } });
} });
app.listen(0, '127.0.0.1');
await once(app, 'listening');
const origin = 'http://127.0.0.1:' + app.address().port;
const { token } = await (await fetch(origin + '/api/state')).json();

async function api(endpoint, data, expected = 200, authorized = true) {
  const response = await fetch(origin + '/api/projects/' + endpoint, data === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': authorized ? token : '' },
    body: JSON.stringify(data)
  });
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return JSON.parse(text);
}

async function database(id, name) {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const endpoint = id + '/database-development';
  const { options } = await api(endpoint);
  const targetId = options.find(item => item.engine === 'postgres' && item.canCreate).id;
  const input = { name, port, targetId };
  const { plan } = await api(endpoint, { mode: 'preview', ...input });
  records.add(id);
  await api(endpoint, { mode: 'create', plan, confirm: name, ...input });
  for (let tryCount = 0; tryCount < 50; tryCount++) {
    if ((await api(endpoint)).status === 'ready') break;
    await delay(700);
  }
  assert.equal((await api(endpoint)).status, 'ready');
  const { development } = JSON.parse(await readFile(stateFile, 'utf8'));
  const { container } = development[id];
  return sql => docker(['exec', container, 'psql', '-XqAt', '-U', 'stackforge', '-d', name, '-v', 'ON_ERROR_STOP=1', '-c', sql]);
}

async function removeDatabase(id) {
  const endpoint = id + '/database-development';
  const resource = await api(endpoint);
  if (resource.status === 'absent') return;
  await api(endpoint, { mode: 'stop' });
  await api(endpoint, { mode: 'delete', confirm: resource.volume });
}

async function archive(id, path = '', bindingId, body = '{}', extra = {}) {
  return fetch(origin + '/api/projects/' + id + '/database-archive' + path, { method: 'POST', body,
    headers: { 'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream',
      'X-StackForge-Token': token, 'X-StackForge-Binding': bindingId, ...extra } });
}

try {
  for (const adapter of ['flyway', 'liquibase']) {
    const project = join(root, adapter);
    const name = adapter + '_fixture';
    await mkdir(join(project, 'prisma'), { recursive: true });
    await writeFile(join(project, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" }');
    const sql = 'CREATE TABLE first_item (id int PRIMARY KEY);\n';
    let pathToChange, body;
    if (adapter === 'flyway') {
      await mkdir(join(project, 'sql'));
      await writeFile(join(project, 'flyway.conf'), 'flyway.locations=filesystem:sql\n');
      pathToChange = join(project, 'sql/V01__first.sql');
      await writeFile(join(project, 'sql/V2__second.sql'), 'CREATE TABLE second_item(id int);\n');
      await writeFile(join(project, 'sql/R__labels.sql'), 'CREATE VIEW labels AS SELECT 1 AS version;\n');
      body = sql;
    } else {
      await writeFile(join(project, 'liquibase.properties'), 'changeLogFile=changes.sql\n');
      pathToChange = join(project, 'changes.sql');
      body = '--liquibase formatted sql\n--changeset sample:first\n' + sql +
        '--rollback DROP TABLE first_item;\n--changeset sample:second\nCREATE TABLE second_item (id int);\n--rollback DROP TABLE second_item;\n';
    }
    await writeFile(pathToChange, body);
    let id;
    if (adapter === 'flyway') {
      ({ id } = await api('import', { path: project }, 201));
    } else {
      const git = args => run('git', args, { cwd: project });
      await git(['init', '-b', 'main']);
      await git(['add', 'liquibase.properties', 'changes.sql', 'prisma/schema.prisma']);
      await git(['-c', 'user.name=StackForge Test', '-c', 'user.email=stackforge-test@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + join(root, 'disabled-hooks'), 'commit', '-m', 'Create isolated Liquibase fixture']);
      const parent = join(root, 'checkouts');
      await mkdir(parent);
      const cloned = await api('clone', { repository, parentDir: parent, requestId: randomUUID() }, 201);
      ({ id } = cloned);
      pathToChange = join(parent, 'liquibase-fixture', 'changes.sql');
    }
    const query = await database(id, name);
    const discovery = await api(id + '/database-discovery');
    const { id: sourceId } = discovery.migrationSources.find(item => item.adapter === adapter);
    const { id: targetId } = discovery.sqlMigrationTargets.find(item => item.projectPostgres);
    const endpoint = id + '/database-native-migration';
    const select = { adapter, sourceId, targetId };
    const preview = (operation = 'apply', expected = 200) => api(endpoint, { ...select, mode: 'preview', operation }, expected);
    const execute = (planId, operation = 'apply', confirmName = name, expected = 200) =>
      api(endpoint, { ...select, mode: 'execute', operation, planId, confirmName }, expected);
    await api(endpoint, { ...select, mode: 'preview', operation: 'apply' }, 403, false);
    await api(endpoint, { ...select, targetId: 'a'.repeat(64), mode: 'preview', operation: 'apply' }, 409);
    let plan = await preview();
    assert.equal(plan.status, 'planned');
    assert.equal(plan.migrations.length, adapter === 'flyway' ? 3 : 2);
    assert.equal((await query("SELECT to_regclass('public.first_item') IS NULL;")).trim(), 't');
    await execute(plan.planId, 'apply', 'other', 409);
    await writeFile(pathToChange, body + '\n-- changed after preview\n');
    await execute(plan.planId, 'apply', name, 409);
    await writeFile(pathToChange, body);
    if (adapter === 'flyway') {
      const last = join(project, 'sql/V2__second.sql');
      await writeFile(last, 'SELECT * FROM missing_table;\n');
      assert.equal((await execute((await preview()).planId)).status, 'execution-failed');
      assert.equal((await query("SELECT to_regclass('public.first_item') IS NULL;")).trim(), 't');
      await writeFile(last, 'CREATE TABLE second_item(id int);\n');
      plan = await preview();
      const shared = join(root, 'shared');
      await mkdir(shared);
      const { port } = plan.target;
      await writeFile(join(shared, '.env'), 'DATABASE_URL=postgresql://fixture@127.0.0.1:' + port + '/' + name + '\n');
      await api('import', { path: shared }, 201);
      assert.match((await execute(plan.planId, 'apply', name, 409)).error, /shared database/);
      await writeFile(join(shared, '.env'), '');

      await writeFile(last, 'SELECT pg_sleep(90); CREATE TABLE second_item(id int);\n');
      const slow = await preview();
      const active = new AbortController();
      const running = fetch(origin + '/api/projects/' + endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token },
        body: JSON.stringify({ ...select, mode: 'execute', operation: 'apply', planId: slow.planId, confirmName: name }),
        signal: active.signal
      }).catch(error => error);
      try {
        let isRunning = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          isRunning = (await query("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'stackforge_migration_%' AND query LIKE '%pg_sleep(90)%';")).trim() === '1';
          if (isRunning) break;
          await delay(400);
        }
        assert.equal(isRunning, true);
      } finally { active.abort(); }
      assert.equal((await running).name, 'AbortError');
      let cancelled;
      for (let attempt = 0; attempt < 50; attempt++) {
        cancelled = (await readFile(operationFile, 'utf8')).split('\n').some(line =>
          line && JSON.parse(line).projectId === id && JSON.parse(line).status === 'cancelled');
        if (cancelled) break;
        await delay(300);
      }
      assert.equal(cancelled, true);
      assert.equal((await query("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'stackforge_migration_%';")).trim(), '0');
      assert.equal((await query("SELECT to_regclass('public.first_item') IS NULL;")).trim(), 't');
      await writeFile(last, 'CREATE TABLE second_item(id int);\n');
    }
    plan = await preview();
    assert.equal((await execute(plan.planId)).status, 'applied');
    assert.equal((await query("SELECT to_regclass('public.first_item') IS NOT NULL AND to_regclass('public.second_item') IS NOT NULL;")).trim(), 't');
    await preview('apply', 409);
    if (adapter === 'liquibase') {
      plan = await preview('rollback');
      assert.deepEqual(plan.undo, ['DROP TABLE second_item;']);
      assert.equal(plan.migrations[0].revision, 'sample:second');
      assert.equal((await execute(plan.planId, 'rollback')).status, 'rolled-back');
      assert.equal((await query("SELECT to_regclass('public.first_item') IS NOT NULL AND to_regclass('public.second_item') IS NULL;")).trim(), 't');
      assert.equal((await execute((await preview('rollback')).planId, 'rollback')).status, 'rolled-back');
      assert.equal((await execute((await preview()).planId)).status, 'applied');
      const rollback = { ...select, operation: 'rollback', rollbackCount: 2 };
      await api(endpoint, { ...rollback, rollbackCount: 3, mode: 'preview' }, 409);
      const rangePlan = await api(endpoint, { ...rollback, mode: 'preview' });
      assert.deepEqual(rangePlan.undo, ['DROP TABLE second_item;', 'DROP TABLE first_item;']);
      await api(endpoint, { ...rollback, rollbackCount: 1, mode: 'execute', planId: rangePlan.planId, confirmName: name }, 409);
      assert.equal((await api(endpoint, { ...rollback, mode: 'execute', planId: rangePlan.planId, confirmName: name })).status, 'rolled-back');
      assert.equal((await query("SELECT to_regclass('public.first_item') IS NULL AND to_regclass('public.second_item') IS NULL;")).trim(), 't');
    } else {
      await preview('rollback', 409);
      await writeFile(join(project, 'sql/R__labels.sql'), 'CREATE OR REPLACE VIEW labels AS SELECT 2 AS version;\n');
      const repeat = await preview();
      assert.deepEqual(repeat.migrations, [{ file: 'sql/R__labels.sql', revision: 'labels' }]);
      assert.equal((await execute(repeat.planId)).status, 'applied');
      assert.equal((await query('SELECT version FROM labels;')).trim(), '2');
      const { archive: backupTarget } = await api(id + '/database-development');
      assert.equal(backupTarget.backup, true);
      assert.equal(backupTarget.restore, false);
      const exported = await archive(id, '', backupTarget.id);
      if (!exported.ok) assert.fail(await exported.text());
      const backup = Buffer.from(await exported.arrayBuffer());
      await removeDatabase(id);
      const recoveredName = 'flyway_recovery';
      const recovered = await database(id, recoveredName);
      await execute(plan.planId, 'apply', name, 409);
      const { archive: restoreTarget } = await api(id + '/database-development');
      assert.equal(restoreTarget.restore, true);
      const inspected = await archive(id, '/preview', restoreTarget.id, backup);
      const approval = await inspected.json();
      assert.equal(inspected.status, 200, approval.error);
      assert.equal(approval.name, recoveredName);
      const restored = await archive(id, '/restore', restoreTarget.id, backup, {
        'X-StackForge-Preview': approval.id, 'X-StackForge-Target': Buffer.from(recoveredName).toString('base64')
      });
      const result = await restored.json();
      assert.equal(restored.status, 200, result.error);
      assert.equal(result.restored, true);
      assert.equal((await recovered('SELECT count(*) FROM flyway_schema_history WHERE success;')).trim(), '4');
    }
    console.log('Verified real ' + adapter + ' native migration plans and target history.');
  }

  const project = join(root, 'ef-core');
  await mkdir(join(project, 'prisma'), { recursive: true });
  await writeFile(join(project, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" }');
  await writeFile(join(project, 'Reports.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
  const migration = '20260102123456_CreateReports';
  await writeFile(join(project, 'CreateReports.cs'), `using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Infrastructure;
namespace Reports;
[DbContext(typeof(ReportsContext))]
[Migration("${migration}")]
public class CreateReports : Migration { }`);
  const { id } = await api('import', { path: project }, 201);
  const name = 'ef_core_fixture';
  const query = await database(id, name);
  const discovery = await api(id + '/database-discovery');
  const { id: sourceId } = discovery.migrationSources.find(item => item.adapter === 'ef-core');
  const { id: targetId } = discovery.efCoreTargets.find(item => item.projectPostgres);
  const preview = await api(id + '/database-ef-core-preview', { sourceId });
  const groupId = preview.groups[0].id;
  const endpoint = id + '/database-native-migration';
  const request = (mode, scriptFile, overrides = {}, expected = 200) => api(endpoint, {
    adapter: 'ef-core', operation: 'apply', sourceId, targetId, groupId, mode, scriptFile, ...overrides
  }, expected);

  const initHistory = `CREATE TABLE IF NOT EXISTS "__EFMigrationsHistory" (
    "MigrationId" character varying(150) NOT NULL PRIMARY KEY, "ProductVersion" character varying(32) NOT NULL
  );`;
  const applySql = initHistory + `
START TRANSACTION;
CREATE TABLE report (id integer PRIMARY KEY);
INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion")
VALUES ('${migration}', '8.0.15');
COMMIT;
`;
  await writeFile(join(project, 'apply.sql'), applySql);
  await writeFile(join(project, 'wrong.sql'), initHistory + '\nCREATE TABLE wrong (id int);');
  await request('preview', '../apply.sql', {}, 409);
  await writeFile(join(project, 'meta.sql'), '\\! unsafe-client-command\n');
  await request('preview', 'meta.sql', {}, 409);
  const wrong = await request('preview', 'wrong.sql');
  assert.equal((await request('execute', 'wrong.sql', { planId: wrong.planId, confirmName: name })).status, 'execution-failed');
  assert.equal((await query(`SELECT to_regclass('wrong') IS NULL AND to_regclass('"__EFMigrationsHistory"') IS NULL;`)).trim(), 't');
  const plan = await request('preview', 'apply.sql');
  assert.equal(plan.toRevision, migration);
  assert.equal(plan.sql, applySql);
  await writeFile(join(project, 'apply.sql'), applySql + '\n-- changed');
  await request('execute', 'apply.sql', { planId: plan.planId, confirmName: name }, 409);
  await writeFile(join(project, 'apply.sql'), applySql);
  assert.equal((await request('execute', 'apply.sql', { planId: plan.planId, confirmName: name })).status, 'applied');
  assert.equal((await query('SELECT to_regclass(\'report\') IS NOT NULL;')).trim(), 't');
  await writeFile(join(project, 'rollback.sql'), `BEGIN;
DROP TABLE report;
DELETE FROM "__EFMigrationsHistory" WHERE "MigrationId" = '${migration}';
COMMIT;`);
  const rollback = await request('preview', 'rollback.sql', { operation: 'rollback', revision: 'base' });
  assert.equal((await request('execute', 'rollback.sql', {
    operation: 'rollback', revision: 'base', planId: rollback.planId, confirmName: name
  })).status, 'rolled-back');
  assert.equal((await query("SELECT to_regclass('report') IS NULL;")).trim(), 't');
  console.log('Verified EF Core SQL apply, guarded transaction rollback, stale plan rejection, and downgrade on PostgreSQL.');

  const branched = join(root, 'alembic-branches');
  await mkdir(join(branched, 'prisma'), { recursive: true });
  await writeFile(join(branched, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" }');
  await mkdir(join(branched, 'alembic/versions'), { recursive: true });
  await writeFile(join(branched, 'alembic.ini'), '[alembic]\nscript_location = %(here)s/alembic\n');
  for (const [revision, parent] of [['root_node', 'None'], ['branch_a', "'root_node'"], ['branch_b', "'root_node'"]]) {
    await writeFile(join(branched, 'alembic/versions', revision + '.py'), `from alembic import op
revision = '${revision}'
down_revision = ${parent}
def upgrade():
    op.execute('CREATE TABLE ${revision} (id integer)')
def downgrade():
    op.execute('DROP TABLE ${revision}')
`);
  }
  const { id: branchedId } = await api('import', { path: branched }, 201);
  const branchDb = 'alembic_branch_fixture';
  const branchQuery = await database(branchedId, branchDb);
  const branchDiscovery = await api(branchedId + '/database-discovery');
  const selection = { adapter: 'alembic', sourceId: branchDiscovery.migrationSources.find(item => item.adapter === 'alembic').id,
    targetId: branchDiscovery.alembicTargets.find(item => item.projectPostgres).id };
  const branchRequest = (mode, operation, data = {}, expected = 200) =>
    api(branchedId + '/database-native-migration', { mode, operation, ...selection, ...data }, expected);
  const upgrade = await branchRequest('preview', 'apply');
  assert.equal(upgrade.toRevision, 'heads');
  assert.equal((await branchRequest('execute', 'apply', { planId: upgrade.planId, confirmName: branchDb })).status, 'applied');
  assert.equal((await branchQuery('SELECT count(*) FROM alembic_version;')).trim(), '2');
  await branchRequest('preview', 'rollback', {}, 409);
  const downgrade = await branchRequest('preview', 'rollback', { revision: 'base' });
  assert.equal((await branchRequest('execute', 'rollback', {
    revision: 'base', planId: downgrade.planId, confirmName: branchDb
  })).status, 'rolled-back');
  assert.equal((await branchQuery('SELECT count(*) FROM alembic_version;')).trim(), '0');
  console.log('Verified Alembic multiple heads, explicit branched rollback, and version history.');
} finally {
  for (const id of records) await removeDatabase(id);
  await app.shutdownTasks();
  await new Promise(resolve => app.close(resolve));
  await rm(root, { recursive: true, force: true });
}
