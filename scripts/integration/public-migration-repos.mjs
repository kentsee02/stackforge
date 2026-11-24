import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../src/http/server.mjs';
import { run } from '../../src/platform/process.mjs';
import { cloneGithub } from '../../src/projects/project-clone.mjs';

// Pin the upstream files so a change in coverage can be reproduced.
const cases = [
  { repo: 'nextjs/saas-starter', commit: '6e33e58b1e553a41fe22e6b941a7229a002de361', adapter: 'drizzle' },
  { repo: 'fastapi/full-stack-fastapi-template', commit: '77e550a73bb49dd2967622c5ed11bf7a49603c93', adapter: 'alembic' },
  { repo: 'dotnet/eShop', commit: 'ab10e4c68fd26369578ebfb3fd1ccf3b867d0444', adapter: 'ef-core' },
  { repo: 'I-RzR-I/ModularMonolithSharedDbContextSample', commit: 'aa79eeffb5a4a02785e24c500d2524a3095d3adb', adapter: 'ef-core', efExport: true },
  { repo: 'nanotaboada/java.samples.spring.boot', commit: '2cbc59f0d968951a5f80b6624ec1fd27c93363ed', adapter: 'flyway', live: true },
  { repo: 'BootcampToProd/flyway-with-spring-boot-maven', commit: '046d4ae118e99f9197bea434daf870873c789b2e', adapter: 'flyway', live: true, flywayProfile: 'stage' },
  { repo: 'h3yzack/springboot3-liquibase-example', commit: 'baa98678824b59476bf09805ac516e4aa8729916', adapter: 'liquibase', live: true },
  { repo: 'jhipster/jhipster-sample-app', commit: '6b000b5d23a36c45e01472471b84a44fa2464044', adapter: 'liquibase' },
  { repo: 'talenteddeveloper/spring-boot-flyway-demo', commit: '77403a2a10af102452b6f026bf6473021decbf99', adapter: 'flyway', number: 10 },
  { repo: 'arjunemirchandani/electron-db', commit: '43be51f7a44f23e05f481b3745f44cfe6fdea38c', adapter: 'drizzle', number: 14, sqlite: true }
];
const expectedCounts = [[1], [5], [3, 1, 4, 1], Array(10).fill(1), [3], [3, 3, 3, 3, 0], [4, 4], [12], [2], [8]];
const selectedCases = new Set(process.argv.filter(arg => arg.startsWith('--case=')).map(arg => arg.slice('--case='.length)));
assert.ok([...selectedCases].every(value => /^PUB-(?:0[1-9]|1[0-5])$/.test(value)), 'Select a case from PUB-01 through PUB-15.');
const selected = number => !selectedCases.size || selectedCases.has('PUB-' + String(number).padStart(2, '0'));
const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-public-migrations-')));
const repositories = new Map();
const live = process.argv.includes('--postgres');
const liveMysql = process.argv.includes('--mysql');
const efCli = process.argv.includes('--ef-cli');
const databaseProjects = new Set();
const app = createApp({
  stateDir: live || liveMysql ? join(root, 'state', 'jobs') : false,
  clone(url, parent, options) {
    return cloneGithub(url, parent, { ...options, command(program, args, config) {
      const separator = args.indexOf('--');
      const checkout = repositories.get(args[separator + 1]);
      assert.equal(program, 'git');
      assert.ok(checkout);
      return run(program, ['-c', 'protocol.file.allow=always', ...args.slice(0, separator + 1), checkout, args.at(-1)], config);
    } });
  }
});

async function assertLiveMigration(api, project, adapter, engine = 'postgres', flywayProfile) {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  const endpoint = project.id + '/database-development';
  const readTarget = async () => (await api(endpoint)).options.find(item => item.engine === engine && item.canCreate);
  let eligible = await readTarget();
  if (!eligible && adapter === 'flyway' && engine === 'postgres') {
    // The public Spring sample defaults to SQLite. Keep its migration files and
    // Flyway config intact, and declare the disposable PostgreSQL test target.
    await mkdir(join(project.path, 'prisma'), { recursive: true });
    await writeFile(join(project.path, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" }', { flag: 'wx' });
    eligible = await readTarget();
  }
  assert.ok(eligible, 'Project ' + engine + ' was not available for ' + adapter);
  const name = 'public_' + adapter.replaceAll('-', '_');
  const input = { targetId: eligible.id, port, name };
  const { plan } = await api(endpoint, { mode: 'preview', ...input });
  databaseProjects.add(project.id);
  await api(endpoint, { mode: 'create', plan, confirm: name, ...input });
  for (let retry = 0; retry < 60; retry++) {
    if ((await api(endpoint)).status === 'ready') break;
    await delay(500);
  }
  const database = await api(endpoint);
  assert.equal(database.status, 'ready');
  if (adapter === 'drizzle') {
    const variable = engine === 'mysql' ? 'DRIZZLE_DATABASE_URL' : 'POSTGRES_URL';
    const connection = database.connections.find(item => item.variable === variable);
    assert.ok(connection, 'Expected the Drizzle ' + variable);
    await api(endpoint, { mode: 'save', requirementId: connection.id, revision: connection.revision });
    const { requirements } = await api(project.id + '/database-discovery');
    const requirementId = requirements.find(item => item.migrationAdapter === adapter).id;
    const preview = () => api(project.id + '/database-drizzle-preview', { requirementId });
    const pending = await preview();
    assert.equal(pending.status, 'pending');
    assert.ok(pending.planId);
    if (engine === 'mysql') assert.match(pending.reviewSql, /CREATE TABLE `cities_migration`/);
    const applied = await api(project.id + '/database-drizzle-apply', { requirementId, planId: pending.planId, confirmName: name });
    assert.equal(applied.status, 'applied');
    assert.equal((await preview()).status, 'current');
    return ['apply', 'history'];
  }
  const discovery = await api(project.id + '/database-discovery');
  if (adapter === 'ef-core') return assertEfCoreExport(api, project, discovery, name);
  if (['flyway', 'liquibase'].includes(adapter)) {
    const source = discovery.migrationSources.find(item => item.adapter === adapter &&
      (flywayProfile ? item.scope === 'maven' && item.profile === flywayProfile && item.nativeLocations : ['standalone', 'spring'].includes(item.scope)));
    assert.ok(source, 'Expected a reviewed migration source');
    const { id: sourceId } = source;
    const { id: targetId } = discovery.sqlMigrationTargets.find(item => engine === 'mysql' ? item.projectMysql : item.projectPostgres);
    const endpoint = project.id + '/database-native-migration';
    const selection = { adapter, sourceId, targetId, operation: 'apply' };
    const check = () => api(project.id + '/database-' + adapter + '-preview', { sourceId, targetId });
    const previewPlan = extras => api(endpoint, { ...selection, ...extras, mode: 'preview' });
    const execute = (planId, extras) => api(endpoint, { ...selection, ...extras, mode: 'execute', planId, confirmName: name });
    const plan = await previewPlan();
    if (adapter === 'flyway' && engine === 'postgres' && !flywayProfile) {
      // The upstream seed scripts insert integer literals into a Boolean column.
      // The native PostgreSQL attempt should fail as a group. V1 itself is portable.
      assert.equal((await execute(plan.planId)).status, 'execution-failed');
      const failed = (await check()).database;
      assert.ok(['history-missing', 'pending'].includes(failed.status));
      assert.ok(!failed.items?.some(item => item.state === 'applied'));
      const revision = plan.migrations[0].revision;
      const first = await previewPlan({ revision });
      assert.equal(first.toRevision, revision);
      assert.equal((await execute(first.planId, { revision })).status, 'applied');
      assert.deepEqual((await check()).database.items.map(item => item.state), ['applied', 'pending', 'pending']);
      return ['grouped-failure', 'apply-to-version-1', 'history'];
    }
    const applied = await execute(plan.planId);
    assert.equal(applied.status, 'applied');
    const after = await check();
    assert.equal(after.database.status, 'recorded');
    assert.ok(after.database.items.every(item => item.state === (adapter === 'flyway' ? 'applied' : 'recorded')));
    if (adapter === 'liquibase' && engine === 'mysql') {
      const rollback = { ...selection, operation: 'rollback', rollbackCount: plan.migrations.length };
      const undo = await api(endpoint, { ...rollback, mode: 'preview' });
      assert.match(undo.undo.join('\n'), /DROP VIEW[^;]*testView[\s\S]*DROP TABLE[^;]*test_table/i);
      assert.equal((await check()).database.status, 'recorded');
      const rolledBack = await api(endpoint, { ...rollback, mode: 'execute', planId: undo.planId, confirmName: name });
      assert.equal(rolledBack.status, 'rolled-back');
      assert.ok((await check()).database.items.every(item => item.state === 'pending'));
      return ['apply', 'rollback-view-and-table', 'history'];
    }
    return [...(flywayProfile ? ['maven-profile:' + flywayProfile] : []), 'apply', 'history'];
  }
  const sourceId = discovery.migrationSources.find(item => item.adapter === 'alembic').id;
  const targetId = discovery.alembicTargets.find(item => item.projectPostgres).id;
  const history = () => api(project.id + '/database-alembic-preview', { sourceId, targetId });
  const first = (await history()).revisions[0].revision;
  const migrate = async (operation, revision, expected) => {
    const selection = { adapter, operation, revision, sourceId, targetId };
    const before = await api(project.id + '/database-native-migration', { ...selection, mode: 'preview' });
    assert.equal(before.toRevision, revision ?? (await history()).heads[0]);
    const after = await api(project.id + '/database-native-migration', { ...selection, mode: 'execute', planId: before.planId, confirmName: name });
    assert.equal(after.status, expected);
  };
  await migrate('apply', first, 'applied');
  assert.deepEqual((await history()).database.heads, [first]);
  await migrate('rollback', 'base', 'rolled-back');
  assert.deepEqual((await history()).database.heads, []);
  await migrate('apply', undefined, 'applied');
  assert.equal((await history()).database.status, 'current');
  return ['apply-to-revision', 'rollback-to-base', 'apply-all', 'history'];
}

async function assertEfCoreExport(api, project, discovery, name) {
  const sourceName = 'src/v1/Modules/Document/DocumentService/DocumentService.csproj';
  const startup = 'src/v1/Host/MMDbConnect.Host/MMDbConnect.Host.csproj';
  const revision = '20260328110619_InitialCreate';
  const { id: sourceId } = discovery.migrationSources.find(item => item.source === sourceName);
  const { id: targetId } = discovery.efCoreTargets.find(item => item.projectPostgres);
  const preview = await api(project.id + '/database-ef-core-preview', { sourceId });
  const { id: groupId } = preview.groups.find(item => item.context.endsWith('DocumentDbContext'));
  const args = '--project ' + sourceName + ' --startup-project ' + startup + ' --context DocumentDbContext --no-color';
  const scripts = await run('docker', ['run', '--rm', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--volume', project.path + ':/upstream:ro', 'mcr.microsoft.com/dotnet/sdk@sha256:1b955f179b02df4f0eb5fadedaa898cbe44d620a64aab52eec72c8e91d1355b5',
    'sh', '-ec', [
      'export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1',
      'mkdir /tmp/project && cp -R /upstream/. /tmp/project && cd /tmp/project',
      'dotnet tool install dotnet-ef --version 8.0.15 --tool-path /tmp/eftools >&2',
      '/tmp/eftools/dotnet-ef migrations script 0 ' + revision + ' ' + args + ' --output /tmp/apply.sql >&2',
      '/tmp/eftools/dotnet-ef migrations script ' + revision + ' 0 ' + args + ' --no-build --output /tmp/rollback.sql >&2',
      'base64 -w0 /tmp/apply.sql; printf "\\n"; base64 -w0 /tmp/rollback.sql; printf "\\n"'
    ].join('\n')], { stdoutOnly: true, stdoutLimit: 1024 * 1024, timeout: 300000 });
  const exports = scripts.trim().split(/\r?\n/);
  assert.equal(exports.length, 2);
  const history = () => api(project.id + '/database-ef-core-preview', { sourceId, targetId, groupId, schema: 'doc' });
  for (const [index, operation] of ['apply', 'rollback'].entries()) {
    const scriptFile = 'stackforge-review-' + operation + '.sql';
    const sql = Buffer.from(exports[index], 'base64');
    assert.ok(sql.includes(Buffer.from('__EFMigrationsHistory')));
    await writeFile(join(project.path, scriptFile), sql);
    const endpoint = project.id + '/database-native-migration';
    const selection = { adapter: 'ef-core', sourceId, targetId, groupId, scriptFile, operation, schema: 'doc',
      revision: operation === 'apply' ? revision : 'base' };
    const plan = await api(endpoint, { ...selection, mode: 'preview' });
    const result = await api(endpoint, { ...selection, mode: 'execute', planId: plan.planId, confirmName: name });
    assert.equal(result.status, operation === 'apply' ? 'applied' : 'rolled-back');
    const expected = operation === 'apply' ? 'applied' : 'pending';
    assert.equal((await history()).database.migrations.find(item => item.id === revision).state, expected);
  }
  return ['native-cli-sql-export', 'apply', 'rollback-to-base', 'custom-history-schema'];
}

async function scan(api, project, adapter) {
  const discovery = await api(project.id + '/database-discovery');
  if (adapter === 'drizzle') {
    const requirement = discovery.requirements.find(item => item.migrationAdapter === adapter);
    assert.ok(requirement, 'Drizzle requirement was not detected');
    const preview = await api(project.id + '/database-drizzle-preview', { requirementId: requirement.id });
    assert.equal(preview.status, 'configuration-needed');
    assert.ok(preview.migrations.length);
    return [{ source: preview.source, status: preview.status, count: preview.migrations.length }];
  }
  const sources = discovery.migrationSources.filter(item => item.adapter === adapter);
  assert.ok(sources.length, 'No ' + adapter + ' source was detected');
  return Promise.all(sources.map(async source => {
    const preview = await api(project.id + '/database-' + adapter + '-preview', { sourceId: source.id });
    const count = (preview.revisions ?? preview.migrations ?? preview.changes ??
      preview.groups?.flatMap(group => group.migrations) ?? []).length;
    return { source: source.source, profile: source.profile, status: preview.status, count };
  }));
}

async function assertLiveSqlite(api, project, format, count) {
  const databaseFile = 'stackforge-test.sqlite';
  const { requirements } = await api(project.id + '/database-discovery');
  const requirement = requirements.find(item => item.migrationAdapter === 'drizzle');
  assert.equal(requirement.engine, 'sqlite');
  const body = { requirementId: requirement.id, databaseFile };
  const preview = () => api(project.id + '/database-drizzle-preview', body);
  const plan = await preview();
  assert.equal(plan.format, format);
  const sqlite = await import('node:sqlite').catch(() => undefined);
  if (!sqlite?.DatabaseSync.prototype.setAuthorizer) {
    assert.equal(plan.status, 'sqlite-runtime');
    assert.equal(plan.planId, undefined);
    return ['preview'];
  }
  assert.equal(plan.status, 'pending', JSON.stringify(plan));
  assert.ok(plan.reviewSql && plan.planId);
  const applied = await api(project.id + '/database-drizzle-apply', { ...body, planId: plan.planId, confirmName: databaseFile });
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  assert.equal((await preview()).status, 'current');
  const db = new sqlite.DatabaseSync(join(project.path, databaseFile), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS total FROM __drizzle_migrations').get().total, count);
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'notes_fts'").get()?.sql;
    if (count === 8) assert.match(sql, /USING fts5/i);
    if (format === 'v1') assert.match(db.prepare('SELECT name FROM __drizzle_migrations').get().name, /^\d{14}_/);
  } finally { db.close(); }
  return ['apply', 'schema', 'history'];
}

let api;
try {
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = 'http://127.0.0.1:' + app.address().port;
  const { token } = await (await fetch(origin + '/api/state')).json();
  api = async (endpoint, body, expected = 200) => {
    const response = await fetch(origin + '/api/projects/' + endpoint, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body)
    });
    const data = await response.json();
    assert.equal(response.status, expected, data.error);
    return data;
  };
  const downloads = await Promise.allSettled(cases.map(async ({ repo, commit, number }, index) => {
    if (!selected(number ?? index + 1)) return;
    const path = join(root, 'upstream-' + index);
    const url = 'https://github.com/' + repo;
    await mkdir(path);
    const git = args => run('git', ['-c', 'core.hooksPath=' + join(root, 'disabled-hooks'), ...args], { cwd: path, timeout: 120000 });
    await git(['init']);
    for (let attempt = 0; ; attempt++) {
      try { await git(['fetch', '--depth=1', url + '.git', commit]); break; }
      catch (error) { if (attempt === 2) throw error; await delay(1000 * (attempt + 1)); }
    }
    await git(['checkout', '--detach', commit]);
    assert.equal((await git(['rev-parse', 'HEAD'])).trim(), commit);
    repositories.set(url + '.git', path);
    return { path, url };
  }));
  for (const [index, item] of cases.entries()) {
    if (!selected(item.number ?? index + 1)) continue;
    const download = downloads[index];
    if (download.status === 'rejected') throw new Error('Could not fetch pinned repository ' + item.repo, { cause: download.reason });
    const { path, url } = download.value;
    const imported = await api('import', { path }, 201);
    const parentDir = join(root, 'clones-' + index);
    await mkdir(parentDir);
    const cloned = await api('clone', { repository: url, parentDir, requestId: randomUUID() }, 201);
    const importedResults = await scan(api, imported, item.adapter);
    assert.deepEqual(await scan(api, cloned, item.adapter), importedResults);
    assert.deepEqual(importedResults.map(result => result.count), expectedCounts[index], item.repo);
    console.log(JSON.stringify({ repository: item.repo, commit: item.commit, adapter: item.adapter, previews: importedResults }));
    assert.ok(importedResults.some(result => ['ready', 'configuration-needed'].includes(result.status) && result.count > 0),
      'The expected public repository migration preview is unavailable: ' + item.repo);
    if (live && !item.sqlite && (item.live || ['drizzle', 'alembic'].includes(item.adapter) || efCli && item.efExport)) {
      console.log(JSON.stringify({ repository: item.repo, postgres: await assertLiveMigration(api, cloned, item.adapter, 'postgres', item.flywayProfile) }));
    }
    if (liveMysql && item.number === 10) {
      console.log(JSON.stringify({ repository: item.repo, mysql: await assertLiveMigration(api, cloned, item.adapter, 'mysql') }));
    }
    if (item.sqlite) {
      console.log(JSON.stringify({ repository: item.repo, commit: item.commit,
        sqlite: await assertLiveSqlite(api, cloned, 'journal-v7', 8) }));
    }
  }
  for (const { number, engine, path } of [
    { number: 9, engine: 'postgres', path: 'liquibase-integration-tests/src/test/resources/changelogs/pgsql/complete/basic.formatted.sql' },
    { number: 11, engine: 'mysql', path: 'liquibase-integration-tests/src/test/resources/changelogs/mysql/complete/createtable.and.view.changelog.xml' }
  ]) {
    if (!(engine === 'mysql' ? liveMysql : live) || !selected(number)) continue;
    const commit = '75773ed9b45b0a5adf3c42872d2e5494da669427';
    const checkout = join(root, 'liquibase-upstream-' + engine);
    await mkdir(checkout);
    const git = args => run('git', args, { cwd: checkout, timeout: 120000 });
    await git(['init']);
    await git(['fetch', '--depth=1', 'https://github.com/liquibase/liquibase.git', commit]);
    const contents = await git(['show', commit + ':' + path]);
    const filename = path.split('/').at(-1);
    assert.match(contents, engine === 'mysql' ? /<databaseChangeLog\b/ : /^--liquibase formatted sql/);
    const wrapper = join(root, 'liquibase-official-' + engine + '-fixture');
    await mkdir(join(wrapper, 'prisma'), { recursive: true });
    await writeFile(join(wrapper, 'prisma/schema.prisma'), 'datasource db { provider = "' + (engine === 'postgres' ? 'postgresql' : engine) + '" }');
    await writeFile(join(wrapper, 'liquibase.properties'), 'changeLogFile=' + filename + '\n');
    await writeFile(join(wrapper, filename), contents);
    const imported = await api('import', { path: wrapper }, 201);
    console.log(JSON.stringify({ repository: 'liquibase/liquibase', commit, file: path,
      [engine]: await assertLiveMigration(api, imported, 'liquibase', engine) }));
  }
  const upstreamDrizzleMysql = [
    { number: 12, commit: 'a086f59fba7f46f3a077893ba912c99e91eaa760',
      paths: ['meta/_journal.json', '0000_nostalgic_carnage.sql'], format: 'journal-v5' },
    { number: 13, commit: '5d71fc408add08bd207f4753f4554578ec9e0640',
      paths: ['20230331135521_nostalgic_carnage/migration.sql'], format: 'v1' }
  ];
  for (const { number, commit, paths, format } of upstreamDrizzleMysql) {
    if (!liveMysql || !selected(number)) continue;
    const checkout = join(root, 'drizzle-upstream-' + number);
    await mkdir(checkout);
    const git = args => run('git', args, { cwd: checkout, timeout: 120000, stdoutOnly: true });
    await git(['init']);
    await git(['fetch', '--depth=1', 'https://github.com/drizzle-team/drizzle-orm.git', commit]);
    const path = join(root, 'drizzle-mysql-' + number);
    await mkdir(path);
    await writeFile(join(path, 'package.json'), JSON.stringify({ devDependencies: { 'drizzle-kit': '*' } }));
    await writeFile(join(path, 'drizzle.config.ts'), "export default { dialect: 'mysql', dbCredentials: { url: process.env.DRIZZLE_DATABASE_URL } };\n");
    for (const file of paths) {
      const destination = join(path, 'drizzle', ...file.split('/'));
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, await git(['show', commit + ':integration-tests/drizzle2/mysql/' + file]));
    }
    const imported = await api('import', { path }, 201);
    const { requirements } = await api(imported.id + '/database-discovery');
    const requirement = requirements.find(item => item.migrationAdapter === 'drizzle');
    assert.equal(requirement.engine, 'mysql');
    const preview = await api(imported.id + '/database-drizzle-preview', { requirementId: requirement.id });
    assert.equal(preview.format, format);
    assert.equal(preview.status, 'configuration-needed');
    console.log(JSON.stringify({ repository: 'drizzle-team/drizzle-orm', commit, format,
      mysql: await assertLiveMigration(api, imported, 'drizzle', 'mysql') }));
  }
  if (selected(15)) {
    const commit = '5d71fc408add08bd207f4753f4554578ec9e0640';
    const folder = '20230330185056_fancy_bug';
    const checkout = join(root, 'drizzle-upstream-sqlite');
    await mkdir(checkout);
    const git = args => run('git', args, { cwd: checkout, timeout: 120000, stdoutOnly: true });
    await git(['init']);
    await git(['fetch', '--depth=1', 'https://github.com/drizzle-team/drizzle-orm.git', commit]);
    const path = join(root, 'drizzle-sqlite-v1');
    await mkdir(join(path, 'drizzle', folder), { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ devDependencies: { 'drizzle-kit': '*' } }));
    await writeFile(join(path, 'drizzle.config.ts'), "export default { dialect: 'sqlite', dbCredentials: { url: 'file:stackforge-test.sqlite' } };\n");
    await writeFile(join(path, 'drizzle', folder, 'migration.sql'),
      await git(['show', commit + ':integration-tests/drizzle2/sqlite/' + folder + '/migration.sql']));
    const imported = await api('import', { path }, 201);
    console.log(JSON.stringify({ repository: 'drizzle-team/drizzle-orm', commit, sqlite: await assertLiveSqlite(api, imported, 'v1', 1) }));
  }
} finally {
  for (const id of databaseProjects) {
    try {
      const endpoint = id + '/database-development';
      const database = await api(endpoint);
      if (database.status === 'absent') continue;
      await api(endpoint, { mode: 'stop' });
      await api(endpoint, { mode: 'delete', confirm: database.volume });
    } catch (error) {
      console.error('Could not clean up public repository database fixture:', error.message);
      process.exitCode = 1;
    }
  }
  await app.shutdownTasks();
  await new Promise(resolve => app.close(resolve));
  await rm(root, { recursive: true, force: true });
}
