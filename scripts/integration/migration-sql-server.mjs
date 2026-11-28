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

const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-migration-mssql-')));
const container = 'stackforge-ef-history-' + randomBytes(8).toString('hex');
const password = 'Aa1!' + randomBytes(20).toString('hex');
const database = 'migration_fixture';
const cli = '/opt/mssql-tools18/bin/sqlcmd';
const docker = (args, options = {}) => run('docker', args, { stdoutOnly: true, timeout: 30000, ...options });
const stateDir = join(root, 'state', 'jobs');
let app, containerId, port, dedicated;
let archiveTest = false;
try {
  containerId = (await docker(['run', '-d', '--name', container, '--publish', '127.0.0.1::1433',
    '--env', 'ACCEPT_EULA=Y', '--env', 'MSSQL_PID=Developer', '--env', 'MSSQL_SA_PASSWORD',
    'mcr.microsoft.com/mssql/server:2022-latest'], { env: { ...process.env, MSSQL_SA_PASSWORD: password }, timeout: 360000 })).trim();
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const published = await docker(['port', containerId, '1433/tcp']);
  port = Number(/^127\.0\.0\.1:(\d+)\s*$/.exec(published)?.[1]);
  assert.ok(port > 0);
  const query = sql => docker(['exec', '-e', 'SQLCMDPASSWORD', containerId, cli, '-S', 'tcp:127.0.0.1,1433',
    '-U', 'sa', '-C', '-b', '-l', '5', '-Q', sql], { env: { ...process.env, SQLCMDPASSWORD: password } });
  for (let attempt = 0; ; attempt++) {
    try { await query('SELECT 1;'); break; }
    catch (error) { if (attempt === 59) throw error; await delay(1000); }
  }
  await query('CREATE DATABASE ' + database + ';');
  await writeFile(join(root, 'Reports.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="9.0.0"/></ItemGroup></Project>');
  const ids = ['20260102123456_First', '20260202123456_Second'];
  for (const id of ids) {
    const name = id.split('_')[1];
    await writeFile(join(root, name + '.cs'), `using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Infrastructure;
namespace Reports;
[DbContext(typeof(ReportsContext))]
[Migration("${id}")]
public class ${name} : Migration { }`);
  }
  await writeFile(join(root, 'appsettings.json'), JSON.stringify({ ConnectionStrings: {
    Application: `Server=tcp:127.0.0.1,${port};Database=${database};User Id=sa;Password=${password};TrustServerCertificate=True;`
  } }));

  app = createApp({ stateDir, databaseAdapters: { developmentPostgres: { async command(program, args, options) {
    try { return await run(program, args, options); }
    catch (error) {
      const input = options?.input?.toString();
      if (archiveTest && (args.includes('sqlcmd') || args.some(arg => arg.includes('/bin/sqlcmd'))) && !input?.startsWith('SET NOCOUNT ON; SELECT 1;')) {
        console.error(error.message.replaceAll(password, '[redacted]'));
      }
      throw error;
    }
  } } }, localDatabase: { async command(program, args, options) {
    assert.equal(program, 'sqlcmd');
    assert.equal(args.includes(password), false);
    const address = args.indexOf('-S') + 1;
    assert.equal(args[address], 'tcp:127.0.0.1,' + port);
    const localArgs = args.with(address, 'tcp:127.0.0.1,1433');
    return docker(['exec', '-e', 'SQLCMDPASSWORD', containerId, cli, ...localArgs], options);
  } } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = 'http://127.0.0.1:' + app.address().port;
  const { token } = await (await fetch(origin + '/api/state')).json();
  async function api(path, body, expected = 200) {
    const response = await fetch(origin + '/api/projects/' + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body)
    });
    const text = await response.text();
    assert.equal(text.includes(password), false);
    assert.equal(response.status, expected, text);
    return JSON.parse(text);
  }
  const { id } = await api('import', { path: root }, 201);
  const discovery = await api(id + '/database-discovery');
  const { id: sourceId } = discovery.migrationSources.find(item => item.adapter === 'ef-core');
  const { id: targetId } = discovery.efCoreTargets.find(item => item.engine === 'sqlserver');
  const endpoint = id + '/database-ef-core-preview';
  const preview = await api(endpoint, { sourceId });
  const selection = { sourceId, targetId, groupId: preview.groups[0].id };
  const history = async (data = {}) => (await api(endpoint, { ...selection, ...data })).database;
  assert.equal((await history()).status, 'history-missing');
  const changes = sql => query(`USE ${database}; ${sql}`);
  await changes(`CREATE TABLE dbo.__EFMigrationsHistory (MigrationId nvarchar(150) NOT NULL PRIMARY KEY, ProductVersion nvarchar(32) NOT NULL);
    INSERT dbo.__EFMigrationsHistory VALUES ('${ids[0]}', '9.0.0');`);
  const pending = await history();
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.migrations.map(item => item.state), ['applied', 'pending']);
  await changes(`INSERT dbo.__EFMigrationsHistory VALUES ('${ids[1]}', '9.0.0');`);
  assert.equal((await history()).status, 'current');
  await changes("EXEC sp_rename 'dbo.__EFMigrationsHistory', 'ReportsHistory';");
  assert.equal((await history()).status, 'history-missing');
  assert.equal((await history({ table: 'ReportsHistory' })).status, 'current');
  await changes("INSERT dbo.ReportsHistory VALUES ('unknown', '9.0.0');");
  assert.equal((await history({ table: 'ReportsHistory' })).status, 'history-conflict');
  await api(endpoint, { ...selection, table: 'invalid];' }, 409);
  console.log('Verified EF Core migration history against SQL Server 2022.');
  await api(id + '/database-native-migration', { ...selection, adapter: 'ef-core', operation: 'apply', mode: 'preview', scriptFile: 'apply.sql' }, 409);
  await docker(['rm', '-f', containerId]);
  containerId = undefined;

  const development = id + '/database-development';
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const available = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const target = (await api(development)).options.find(item => item.engine === 'sqlserver' && item.canCreate);
  assert.ok(target);
  const name = 'ef_owned_fixture';
  const input = { name, port: available, targetId: target.id };
  const plan = await api(development, { mode: 'preview', ...input });
  assert.match(plan.terms, /^https:\/\/www\.microsoft\.com\//);
  await api(development, { mode: 'create', plan: plan.plan, ...input, confirm: name }, 409);
  dedicated = development;
  await api(development, { mode: 'create', plan: plan.plan, ...input, confirm: name, acceptTerms: true });
  const ready = await api(development);
  assert.equal(ready.status, 'ready');
  const recorded = JSON.parse(await readFile(join(root, 'state', 'databases.json'), 'utf8')).development[id];
  assert.match(recorded.sqlDatabase, /^[a-f0-9-]{36}$/i);
  const ownedTarget = (await api(id + '/database-discovery')).efCoreTargets.find(item => item.projectSqlServer);
  assert.equal(ownedTarget.name, name);
  const selected = { ...selection, targetId: ownedTarget.id, adapter: 'ef-core' };
  const ownedQuery = (sql, db = name) => docker(['exec', recorded.container, 'sh', '-c',
    'export SQLCMDPASSWORD="$MSSQL_SA_PASSWORD"; exec /opt/mssql-tools18/bin/sqlcmd -S tcp:127.0.0.1,1433 -U sa -C -b -d "$1" -Q "$2"',
    'stackforge', db, 'SET NOCOUNT ON; ' + sql]);
  const createSql = "IF OBJECT_ID(N'[__EFMigrationsHistory]') IS NULL\nBEGIN\n" +
    'CREATE TABLE [__EFMigrationsHistory] ([MigrationId] nvarchar(150) NOT NULL PRIMARY KEY, [ProductVersion] nvarchar(32) NOT NULL);\nEND;\nGO\n' +
    'BEGIN TRANSACTION;\nGO\nCREATE TABLE [Reports] ([Id] int NOT NULL PRIMARY KEY);\n' +
    "INSERT INTO [__EFMigrationsHistory] VALUES (N'" + ids[0] + "', N'9.0.0');\nGO\nCOMMIT;\nGO\n";
  const applyFile = join(root, 'apply.sql');
  await writeFile(applyFile, createSql);
  const native = id + '/database-native-migration';
  const first = { ...selected, operation: 'apply', revision: ids[0], scriptFile: 'apply.sql' };
  const prepare = (payload, expected) => api(native, { ...payload, mode: 'preview' }, expected);
  const execute = (payload, plan, expected) => api(native, { ...payload, mode: 'execute', planId: plan.planId, confirmName: name }, expected);
  const draft = await prepare(first);
  assert.equal(draft.target.engine, 'sqlserver');
  await writeFile(applyFile, createSql + '-- other bytes\n');
  await execute(first, draft, 409);
  await writeFile(applyFile, createSql.replace(ids[0], ids[1]));
  assert.equal((await execute(first, await prepare(first))).status, 'execution-failed');
  assert.match(await ownedQuery("SELECT IIF(OBJECT_ID(N'dbo.Reports') IS NULL, 'empty', 'written');"), /empty/);
  await writeFile(applyFile, createSql);
  assert.equal((await execute(first, await prepare(first))).status, 'applied');
  assert.equal((await history({ targetId: ownedTarget.id })).status, 'pending');
  assert.match(await ownedQuery("SELECT name FROM sys.tables WHERE name='Reports';"), /Reports/);
  await ownedQuery('INSERT dbo.Reports VALUES (371);');
  await ownedQuery("EXEC(N'CREATE PROCEDURE dbo.ReportTotal AS SELECT SUM(Id) FROM dbo.Reports;');");
  const archive = async (operation, body, headers = {}) => fetch(origin + '/api/projects/' + id + '/database-archive' +
    (operation === 'backup' ? '' : '/' + operation), { method: 'POST', body, headers: {
    'Content-Type': operation === 'backup' ? 'application/json' : 'application/octet-stream',
    'X-StackForge-Token': token, 'X-StackForge-Binding': ready.archive.id, ...headers
  } });
  archiveTest = true;
  const download = await archive('backup', '{}');
  const backup = Buffer.from(await download.arrayBuffer());
  assert.equal(download.status, 200, backup.subarray(0, 500).toString());
  assert.match(download.headers.get('content-disposition'), /-sqlserver\.bak\.sfdb/);
  assert.match(backup.toString('utf8', 0, 240), /"engine":"sqlserver"/);
  const occupied = await archive('preview', backup);
  assert.equal(occupied.status, 409, await occupied.text());
  await ownedQuery('DROP PROCEDURE dbo.ReportTotal; DROP TABLE dbo.Reports; DROP TABLE dbo.__EFMigrationsHistory;');
  const consumer = join(root, 'shared-consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'Reports.csproj'), await readFile(join(root, 'Reports.csproj')));
  await writeFile(join(consumer, 'appsettings.json'), JSON.stringify({ ConnectionStrings: {
    Application: `Server=tcp:127.0.0.1,${available};Database=${name};User Id=sa;Password=placeholder-not-used;TrustServerCertificate=True;`
  } }));
  const registered = await api('import', { path: consumer }, 201);
  const shared = await archive('preview', backup);
  assert.equal(shared.status, 409);
  assert.match(await shared.text(), /Another project uses this database/);
  await api(registered.id + '/remove', { confirmName: registered.name });
  const bad = Buffer.from(backup);
  bad[bad.length - 20] ^= 1;
  const invalid = await archive('preview', bad);
  assert.equal(invalid.status, 409, await invalid.text());
  const previewResponse = await archive('preview', backup);
  const archivePreview = await previewResponse.json();
  assert.equal(previewResponse.status, 200, JSON.stringify(archivePreview));
  assert.equal(archivePreview.name, name);
  assert.ok(archivePreview.objects >= 3);
  const restore = (confirmed, data = backup) => archive('restore', data, {
    'X-StackForge-Preview': archivePreview.id, 'X-StackForge-Target': Buffer.from(confirmed).toString('base64')
  });
  const wrong = await restore(name + '_wrong');
  assert.equal(wrong.status, 409, await wrong.text());
  const tampered = await restore(name, bad);
  assert.equal(tampered.status, 409, await tampered.text());
  const recovered = await restore(name);
  const result = await recovered.json();
  assert.equal(recovered.status, 200, JSON.stringify(result));
  assert.equal(result.restored, true);
  assert.match(await ownedQuery('EXEC dbo.ReportTotal;'), /371/);
  assert.equal((await history({ targetId: ownedTarget.id })).status, 'pending');
  const consumed = await restore(name);
  assert.equal(consumed.status, 409, await consumed.text());
  await ownedQuery('DROP PROCEDURE dbo.ReportTotal;');
  archiveTest = false;
  console.log('Verified native SQL Server backup, isolated preview, archive tampering, exact confirmation, and table, procedure and EF history recovery.');
  const down = { ...selected, operation: 'rollback', revision: 'base', scriptFile: 'down.sql' };
  await writeFile(join(root, 'down.sql'), "DROP TABLE [Reports];\nDELETE FROM [__EFMigrationsHistory] WHERE [MigrationId]=N'" + ids[0] + "';\nGO\n");
  assert.equal((await execute(down, await prepare(down))).status, 'rolled-back');
  assert.match(await ownedQuery("SELECT IIF(OBJECT_ID(N'dbo.Reports') IS NULL, 'empty', 'written');"), /empty/);
  const stale = await prepare(first);
  await ownedQuery('DROP DATABASE [' + name + ']; CREATE DATABASE [' + name + '];', 'master');
  await execute(first, stale, 409);
  console.log('Verified owned SQL Server EF Core apply, rollback, stale SQL, transaction failure, and database identity.');
  await api(development, { mode: 'stop' });
  await api(development, { mode: 'delete', confirm: ready.volume });
  dedicated = undefined;
} finally {
  if (app) {
    if (dedicated) {
      const origin = 'http://127.0.0.1:' + app.address().port;
      const { token } = await (await fetch(origin + '/api/state')).json();
      const url = origin + '/api/projects/' + dedicated;
      const result = await (await fetch(url)).json();
      for (const mode of ['stop', 'delete']) {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token },
          body: JSON.stringify({ mode, confirm: result.volume }) });
      }
    }
    await app.shutdownTasks();
    await new Promise(resolve => app.close(resolve));
  }
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) await docker(['rm', '-f', containerId]);
  await rm(root, { recursive: true, force: true });
}
