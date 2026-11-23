import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
let app, containerId, port;
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

  app = createApp({ stateDir: false, localDatabase: { async command(program, args, options) {
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
} finally {
  if (app) {
    await app.shutdownTasks();
    await new Promise(resolve => app.close(resolve));
  }
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) await docker(['rm', '-f', containerId]);
  await rm(root, { recursive: true, force: true });
}
