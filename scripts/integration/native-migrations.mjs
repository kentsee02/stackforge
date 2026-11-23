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

async function database(id, name, engine = 'postgres') {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const endpoint = id + '/database-development';
  const { options } = await api(endpoint);
  const targetId = options.find(item => item.engine === engine && item.canCreate).id;
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
  if (engine === 'mysql') return (sql, useDatabase = true) => docker(['exec', container, 'sh', '-c',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --no-defaults --protocol=SOCKET -uroot --batch --raw --skip-column-names "$@"',
    'stackforge', ...(useDatabase ? ['--database=' + name] : []), '-e', sql]);
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

async function testExistingAdapters() {
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
}

async function testStructuredLiquibase() {
  const structured = join(root, 'liquibase-structured');
  await mkdir(join(structured, 'prisma'), { recursive: true });
  await writeFile(join(structured, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" }');
  await mkdir(join(structured, 'changes'));
  await writeFile(join(structured, 'liquibase.properties'), 'changeLogFile=changes/main.json\n');
  await writeFile(join(structured, 'changes/main.json'), JSON.stringify({ databaseChangeLog: [
    { include: { file: 'from-yaml.yaml', relativeToChangelogFile: true } },
    { include: { file: 'from-xml.xml', relativeToChangelogFile: true } },
    { changeSet: { id: 'json', author: 'fixture', changes: [
      { createTable: { tableName: 'json_fixture', columns: [{ column: { name: 'id', type: 'int' } }] } }
    ] } }
  ] }));
  await writeFile(join(structured, 'changes/from-yaml.yaml'), `databaseChangeLog:
  - changeSet:
      id: yaml
      author: fixture
      changes:
        - createTable:
            tableName: yaml_fixture
            columns:
              - column:
                  name: id
                  type: int
`);
  await writeFile(join(structured, 'changes/from-xml.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-4.33.xsd">
  <changeSet id="xml" author="fixture">
    <createTable tableName="xml_fixture"><column name="id" type="int"/></createTable>
  </changeSet>
</databaseChangeLog>`);
  const { id: structuredId } = await api('import', { path: structured }, 201);
  const structuredName = 'liquibase_structured_fixture';
  const structuredQuery = await database(structuredId, structuredName);
  const structuredDiscovery = await api(structuredId + '/database-discovery');
  const input = { adapter: 'liquibase', sourceId: structuredDiscovery.migrationSources.find(item => item.adapter === 'liquibase').id,
    targetId: structuredDiscovery.sqlMigrationTargets.find(item => item.projectPostgres).id };
  const structuredEndpoint = structuredId + '/database-native-migration';
  const requestPlan = (mode, operation, fields = {}, expected = 200) => api(structuredEndpoint, { ...input, mode, operation, ...fields }, expected);
  const tableCount = () => structuredQuery("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' " +
    "AND table_name IN ('yaml_fixture', 'xml_fixture', 'json_fixture');");
  const stale = await requestPlan('preview', 'apply');
  await writeFile(join(structured, 'changes/from-xml.xml'), '\n', { flag: 'a' });
  const rejection = await requestPlan('execute', 'apply', { planId: stale.planId, confirmName: structuredName }, 409);
  assert.match(rejection.error, /preview it again/i);
  assert.equal((await tableCount()).trim(), '0');
  const approved = await requestPlan('preview', 'apply');
  assert.deepEqual(approved.migrations.map(item => item.revision), ['fixture:yaml', 'fixture:xml', 'fixture:json']);
  assert.equal((await requestPlan('execute', 'apply', { planId: approved.planId, confirmName: structuredName })).status, 'applied');
  assert.equal((await structuredQuery('SELECT count(*) FROM databasechangelog;')).trim(), '3');
  assert.equal((await tableCount()).trim(), '3');
  const structuredUndo = await requestPlan('preview', 'rollback', { rollbackCount: 3 });
  assert.match(structuredUndo.undo.join('\n'), /DROP TABLE[^;]*json_fixture[\s\S]*DROP TABLE[^;]*xml_fixture[\s\S]*DROP TABLE[^;]*yaml_fixture/i);
  assert.equal((await structuredQuery('SELECT count(*) FROM databasechangelog;')).trim(), '3');
  assert.equal((await tableCount()).trim(), '3');
  const result = await requestPlan('execute', 'rollback', { rollbackCount: 3, planId: structuredUndo.planId, confirmName: structuredName });
  assert.equal(result.status, 'rolled-back');
  assert.equal((await structuredQuery('SELECT count(*) FROM databasechangelog;')).trim(), '0');
  assert.equal((await tableCount()).trim(), '0');
  console.log('Verified structured Liquibase JSON, YAML and XML with read-only rollback preview and native rollback.');
}

async function testNativeMysql() {
  for (const adapter of ['flyway', 'liquibase']) {
    const project = join(root, adapter + '-mysql');
    await mkdir(join(project, 'prisma'), { recursive: true });
    await writeFile(join(project, 'prisma/schema.prisma'), 'datasource db { provider = "mysql" }');
    const name = adapter + '_mysql_fixture';
    if (adapter === 'flyway') {
      await mkdir(join(project, 'sql'));
      await writeFile(join(project, 'flyway.conf'), 'flyway.locations=filesystem:sql\n');
      await writeFile(join(project, 'sql/V1__first.sql'), 'CREATE TABLE first_item (id int PRIMARY KEY);\n');
      await writeFile(join(project, 'sql/V2__failing.sql'), 'CREATE TABLE partial_item (id int PRIMARY KEY);\nSELECT * FROM absent_table;\n');
    } else {
      await writeFile(join(project, 'liquibase.properties'), 'changeLogFile=changelog.json\n');
      await writeFile(join(project, 'changelog.json'), JSON.stringify({ databaseChangeLog: ['first_item', 'second_item'].map((tableName, index) => ({
        changeSet: { id: String(index + 1), author: 'fixture', changes: [{ createTable: { tableName, columns: [{ column: { name: 'id', type: 'int' } }] } }] }
      })) }));
    }
    const { id } = await api('import', { path: project }, 201);
    const query = await database(id, name, 'mysql');
    const discovery = await api(id + '/database-discovery');
    const targetId = discovery.sqlMigrationTargets.find(item => item.projectMysql).id;
    const sourceId = discovery.migrationSources.find(item => item.adapter === adapter).id;
    const request = (mode, operation, fields, expected) =>
      api(id + '/database-native-migration', { adapter, targetId, sourceId, mode, operation, ...fields }, expected);
    const revision = adapter === 'flyway' ? { revision: '1' } : {};
    const beforeReplacement = await request('preview', 'apply', revision);
    assert.equal(beforeReplacement.target.engine, 'mysql');
    await query('DROP DATABASE ' + name + '; CREATE DATABASE ' + name + ';', false);
    const stale = await request('execute', 'apply', { ...revision, planId: beforeReplacement.planId, confirmName: name }, 409);
    assert.match(stale.error, /preview it again/i);
    assert.equal((await query('SHOW TABLES;')).trim(), '');
    const apply = await request('preview', 'apply', revision);
    if (adapter === 'flyway') {
      const shared = join(root, 'mysql-shared');
      await mkdir(shared);
      await writeFile(join(shared, '.env'), 'DATABASE_URL=mysql://fixture@127.0.0.1:' + apply.target.port + '/' + name + '\n');
      await api('import', { path: shared }, 201);
      const rejected = await request('execute', 'apply', { ...revision, planId: apply.planId, confirmName: name }, 409);
      assert.match(rejected.error, /shared database/i);
      await writeFile(join(shared, '.env'), '');
    }
    const applied = await request('execute', 'apply', { ...revision, planId: apply.planId, confirmName: name });
    assert.equal(applied.status, 'applied');
    if (adapter === 'flyway') {
      assert.match(await query('SELECT version, success FROM flyway_schema_history WHERE version IS NOT NULL;'), /^1\t1/);
      const failure = await request('preview', 'apply');
      assert.equal((await request('execute', 'apply', { planId: failure.planId, confirmName: name })).status, 'execution-failed');
      assert.match(await query("SHOW TABLES LIKE 'partial_item';"), /^partial_item/);
      assert.match(await query("SELECT success FROM flyway_schema_history WHERE version='2';"), /^0/);
      console.log('Verified Flyway MySQL target selection, stale database replacement, and partial DDL reporting.');
    } else {
      const undo = await request('preview', 'rollback', { rollbackCount: 2 });
      assert.match(undo.undo.join('\n'), /DROP TABLE[^;]*second_item[\s\S]*DROP TABLE[^;]*first_item/i);
      assert.equal((await query('SELECT count(*) FROM DATABASECHANGELOG;')).trim(), '2');
      assert.match(await query("SHOW TABLES LIKE 'first_item';"), /^first_item/);
      assert.equal((await request('execute', 'rollback', { rollbackCount: 2, planId: undo.planId, confirmName: name })).status, 'rolled-back');
      assert.equal((await query('SELECT count(*) FROM DATABASECHANGELOG;')).trim(), '0');
      assert.equal((await query("SHOW TABLES LIKE '%_item';")).trim(), '');
      await writeFile(join(project, 'changelog.json'), JSON.stringify({ databaseChangeLog: [{
        changeSet: { id: 'slow', author: 'fixture', changes: [{ sql: { sql: 'SELECT SLEEP(90)' } },
          { createTable: { tableName: 'cancelled_item', columns: [{ column: { name: 'id', type: 'int' } }] } }] }
      }] }));
      const slow = await request('preview', 'apply');
      const active = new AbortController();
      const running = fetch(origin + '/api/projects/' + id + '/database-native-migration', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, signal: active.signal,
        body: JSON.stringify({ adapter, targetId, sourceId, mode: 'execute', operation: 'apply', planId: slow.planId, confirmName: name })
      }).catch(error => error);
      const workerSessions = condition => query("SELECT count(*) FROM performance_schema.session_connect_attrs attr " +
        "JOIN performance_schema.threads thread ON thread.PROCESSLIST_ID=attr.PROCESSLIST_ID " +
        "WHERE attr.ATTR_NAME='stackforgeMigration' AND thread.PROCESSLIST_DB=DATABASE()" + condition + ';');
      try {
        let sleeping = false;
        for (let retry = 0; retry < 60; retry++) {
          sleeping = (await workerSessions(" AND thread.PROCESSLIST_INFO LIKE '%SLEEP(90)%'")).trim() === '1';
          if (sleeping) break;
          await delay(400);
        }
        assert.equal(sleeping, true);
      } finally { active.abort(); }
      assert.equal((await running).name, 'AbortError');
      let cancelled;
      for (let retry = 0; retry < 50; retry++) {
        cancelled = (await readFile(operationFile, 'utf8')).split('\n').some(line =>
          line && JSON.parse(line).projectId === id && JSON.parse(line).status === 'cancelled');
        if (cancelled) break;
        await delay(300);
      }
      assert.equal(cancelled, true);
      assert.equal((await workerSessions('')).trim(), '0');
      assert.equal((await query("SHOW TABLES LIKE 'cancelled_item';")).trim(), '');
      console.log('Verified Liquibase MySQL update, read-only structured rollback preview, rollback, and cancellation.');
    }
  }
}

async function testLiquibaseTags() {
  for (const engine of ['postgres', 'mysql']) {
    const project = join(root, 'liquibase-tags-' + engine);
    await mkdir(join(project, 'prisma'), { recursive: true });
    await writeFile(join(project, 'prisma/schema.prisma'), 'datasource db { provider = "' + (engine === 'mysql' ? 'mysql' : 'postgresql') + '" }');
    await writeFile(join(project, 'liquibase.properties'), 'changeLogFile=changelog.json\n');
    const create = tableName => [{ createTable: { tableName, columns: [{ column: { name: 'id', type: 'int' } }] } }];
    await writeFile(join(project, 'changelog.json'), JSON.stringify({ databaseChangeLog: [
      ['base', create('tag_base_item')], ['checkpoint', [{ tagDatabase: { tag: 'release-one', keepTagOnRollback: engine === 'mysql' } }]],
      ['after', create('tag_after_item')], ['last', create('tag_last_item')]
    ].map(([id, changes]) => ({ changeSet: { id, author: 'fixture', changes } })) }));
    const { id } = await api('import', { path: project }, 201);
    const name = 'liquibase_tags_' + engine;
    const query = await database(id, name, engine);
    const discovery = await api(id + '/database-discovery');
    const targetId = discovery.sqlMigrationTargets.find(item => engine === 'mysql' ? item.projectMysql : item.projectPostgres).id;
    const sourceId = discovery.migrationSources.find(item => item.adapter === 'liquibase').id;
    const request = (mode, operation, fields, expected) =>
      api(id + '/database-native-migration', { adapter: 'liquibase', targetId, sourceId, mode, operation, ...fields }, expected);
    const apply = await request('preview', 'apply');
    assert.equal((await request('execute', 'apply', { planId: apply.planId, confirmName: name })).status, 'applied');
    const history = engine === 'mysql' ? 'DATABASECHANGELOG' : 'databasechangelog';
    const tags = async () => (await api(id + '/database-liquibase-preview', { sourceId, targetId })).database.tags;
    const tables = () => query("SELECT table_name FROM information_schema.tables WHERE table_schema='" +
      (engine === 'mysql' ? name : 'public') + "' AND table_name LIKE 'tag_%_item' ORDER BY table_name;");
    await request('preview', 'rollback', { rollbackTag: 'missing' }, 409);
    await request('preview', 'rollback', { rollbackTag: 'release-one', rollbackCount: 1 }, 409);
    assert.deepEqual(await tags(), ['release-one']);
    await query("UPDATE " + history + " SET tag='release-one' WHERE id='after';");
    await request('preview', 'rollback', { rollbackTag: 'release-one' }, 409);
    assert.deepEqual(await tags(), []);
    await query("UPDATE " + history + " SET tag='manual-tag' WHERE id='after';");
    const manual = await request('preview', 'rollback', { rollbackTag: 'manual-tag' });
    assert.deepEqual(manual.migrations.map(item => item.revision), ['fixture:last']);
    assert.match(manual.undo.join('\n'), /DROP TABLE[^;]*tag_last_item/i);
    assert.equal((await tables()).trim().split(/\r?\n/).length, 3);
    assert.equal((await request('execute', 'rollback', { rollbackTag: 'manual-tag', planId: manual.planId, confirmName: name })).status, 'rolled-back');
    assert.equal((await query("SELECT id FROM " + history + " WHERE tag='manual-tag';")).trim(), 'after');
    const declared = await request('preview', 'rollback', { rollbackTag: 'release-one' });
    const keepTag = engine === 'mysql';
    assert.deepEqual(declared.migrations.map(item => item.revision), keepTag ? ['fixture:after'] : ['fixture:after', 'fixture:checkpoint']);
    assert.equal((await request('execute', 'rollback', { rollbackTag: 'release-one', planId: declared.planId, confirmName: name })).status, 'rolled-back');
    assert.equal((await query('SELECT id FROM ' + history + ' ORDER BY orderexecuted;')).trim(), keepTag ? 'base\ncheckpoint' : 'base');
    assert.equal((await tables()).trim(), 'tag_base_item');
    console.log('Verified Liquibase rollback to declared and manual tags on ' + engine + '.');
  }
}

try {
  const mysqlOnly = process.argv.includes('--mysql-only');
  const structuredOnly = process.argv.includes('--structured-only');
  const tagsOnly = process.argv.includes('--tags-only');
  if (!mysqlOnly && !structuredOnly && !tagsOnly) await testExistingAdapters();
  if (!mysqlOnly && !tagsOnly) await testStructuredLiquibase();
  if (!structuredOnly && !tagsOnly) await testNativeMysql();
  if (!mysqlOnly && !structuredOnly) await testLiquibaseTags();
} finally {
  for (const id of records) await removeDatabase(id);
  await app.shutdownTasks();
  await new Promise(resolve => app.close(resolve));
  await rm(root, { recursive: true, force: true });
}
