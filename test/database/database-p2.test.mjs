import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../../src/http/server.mjs';
import { archiveBackup, inspectArchive, isLegacyBackup } from '../../src/database/backup/archive.mjs';
import { sqlServerBackupSignature } from '../../src/database/backup/payload.mjs';

test('SQL Server archive verifies signature, checksum and 2022 build direction, and rejects raw legacy uploads', () => {
  const payload = Buffer.concat([sqlServerBackupSignature, Buffer.from('fixture')]);
  const { data, filename } = archiveBackup({ data: payload, engine: 'sqlserver', version: '16.0.4200', project: 'fixture' });
  assert.match(filename, /-sqlserver\.bak\.sfdb$/);
  assert.deepEqual(inspectArchive(data, 'sqlserver', '16.0.4201').data, payload);
  assert.throws(() => inspectArchive(data, 'sqlserver', '16.0.4199'), /incompatible/);
  assert.throws(() => inspectArchive(data, 'sqlserver', '17.0.1000'), /incompatible/);
  assert.equal(isLegacyBackup(Buffer.from('TAPEfixture'), 'sqlserver'), false);
  assert.throws(() => archiveBackup({ data: Buffer.from('TAPEfixture'), engine: 'sqlserver', version: '16.0.4200', project: 'fixture' }), /format/);
  const corrupt = Buffer.from(data);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => inspectArchive(corrupt, 'sqlserver', '16.0.4201'), /checksum/);
});
import { run } from '../../src/platform/process.mjs';
import { databaseVault } from '../../src/database/security/vault.mjs';
import { cloneGithub } from '../../src/projects/project-clone.mjs';

const sqlite = await import('node:sqlite').catch(() => undefined);

async function fixture(t, adapters, options) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-p2-')));
  const project = join(root, 'project');
  await mkdir(project);
  let app, base, token;
  async function stop() {
    await app.shutdownTasks();
    await new Promise(resolve => app.close(resolve));
  }
  async function restart() {
    if (app) await stop();
    app = createApp({ stateDir: join(root, 'state', 'jobs'), databaseAdapters: adapters, ...options }).listen(0, '127.0.0.1');
    await once(app, 'listening');
    base = 'http://127.0.0.1:' + app.address().port;
    ({ token } = await (await fetch(base + '/api/state')).json());
  }
  await restart();
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  const request = (path, data, headers = {}) => fetch(base + path, data === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': Buffer.isBuffer(data) ? 'application/octet-stream' : 'application/json',
      'X-StackForge-Token': token, ...headers },
    body: Buffer.isBuffer(data) ? data : JSON.stringify(data)
  });
  const register = async () => {
    const imported = await request('/api/projects/import', { path: project });
    assert.equal(imported.status, 201);
    return '/api/projects/' + (await imported.json()).id;
  };
  return { root, project, request, register, restart };
}

test('archives reject changes, incorrect engines and incompatible versions', () => {
  const original = archiveBackup({ data: Buffer.from('PGDMPfixture'), engine: 'postgres', version: '17.4', project: 'fixture' });
  assert.equal(inspectArchive(original.data, 'postgres', '18.1').metadata.checksum, original.metadata.checksum);
  assert.throws(() => inspectArchive(original.data, 'postgres', '16.2'), /incompatible/);
  assert.throws(() => inspectArchive(original.data, 'mysql', '8.4'), /engine/);
  const changed = Buffer.from(original.data);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => inspectArchive(changed, 'postgres', '17.4'), /checksum/);
});

test('local MongoDB, Redis and SQL Server connection checks keep credentials out of args and responses', async t => {
  const password = 'native-probe-test-password';
  const command = async (client, args, { env }) => {
    assert.doesNotMatch(JSON.stringify(args), new RegExp(password));
    if (client === 'redis-cli') {
      assert.equal(env.REDISCLI_AUTH, password);
      assert.deepEqual(args.slice(-3), ['--user', 'cache', 'PING']);
      return 'PONG';
    }
    if (client === 'mongosh') {
      assert.equal(new URL(env.STACKFORGE_MONGO_URI).password, password);
      assert.equal(new URL(env.STACKFORGE_MONGO_URI).searchParams.get('directConnection'), 'true');
      return 'STACKFORGE_CONNECTED';
    }
    assert.equal(client, 'sqlcmd');
    assert.equal(env.SQLCMDPASSWORD, password);
    assert.ok(args.includes('tcp:127.0.0.1,1433'));
    return '16.0.3000.0\tportal';
  };
  const { project, request, register } = await fixture(t, { command });
  await writeFile(join(project, '.env'), [
    `MONGO_DATABASE_URL=mongodb://app:${password}@localhost:27017/portal`,
    `REDIS_URL=redis://cache:${password}@127.0.0.1:6379`
  ].join('\n'));
  await writeFile(join(project, 'appsettings.json'), JSON.stringify({ ConnectionStrings: {
    portal: `Server=localhost,1433;Database=portal;User Id=app;Password=${password}`
  } }));
  const route = await register();
  const data = await (await request(route + '/database-discovery')).json();
  assert.doesNotMatch(JSON.stringify(data), new RegExp(password));
  for (const engine of ['redis', 'mongodb', 'sqlserver']) {
    const binding = data.bindings.find(item => item.instance.engine === engine);
    const reply = await request(route + '/database-local-status', { bindingId: binding.id });
    assert.equal(reply.status, 200);
    assert.deepEqual((await reply.json()).capabilities, { connect: true, backup: false, restore: false });
  }
});

test('database discovery follows literal .NET project references and reads custom connection sections', async t => {
  const { project, request, register } = await fixture(t);
  const secret = 'db-fixture-password';
  const files = {
    'services/customer/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><ProjectReference Include="..\\..\\layers\\services\\Storage.csproj"/></ItemGroup></Project>',
    'layers/services/Storage.csproj': '<Project><ItemGroup><ProjectReference Include="../sql/Provider.csproj"/></ItemGroup></Project>',
    'layers/sql/Provider.csproj': '<Project><ItemGroup><PackageReference Version="8.0.0" Include="Microsoft.EntityFrameworkCore.SqlServer"/><!-- <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL"/> --><ProjectReference Include="../services/Storage.csproj"/></ItemGroup></Project>',
    'services/customer/appsettings.json': JSON.stringify({
      ConnectionStrings: { Main: null },
      Storage: { RelationalConnectionString: 'Database=customer;Password="' + secret + ';Server=203.0.113.9";Server=tcp:localhost,1433' },
      Blob: { ConnectionString: 'DefaultEndpointsProtocol=https;AccountName=test' }
    }),
    'tests/storage/Tests.csproj': '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk"/><PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite"/></ItemGroup></Project>',
    'tests/storage/appsettings.Testing.json': JSON.stringify({ ConnectionStrings: { Test: String.raw`Server=(localdb)\test;Database=customer_test` } })
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(project, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  const route = await register();
  const discovered = await request(route + '/database-discovery');
  assert.equal(discovered.status, 200);
  const data = await discovered.json();
  assert.equal(data.limited, false);
  assert.doesNotMatch(JSON.stringify(data), new RegExp(secret));
  assert.deepEqual(data.requirements.map(({ directory, key, status, engine }) => [directory, key, status, engine]).sort(), [
    ['layers/sql', 'sqlserver', 'declared', 'sqlserver'],
    ['services/customer', 'Main', 'missing', 'sqlserver'],
    ['services/customer', 'Storage.RelationalConnectionString', 'configured', 'sqlserver'],
    ['tests/storage', 'Test', 'unverified', 'sqlserver']
  ]);
  assert.equal(data.requirements.find(item => item.status === 'configured').host, 'localhost');
});

test('database discovery reads literal Compose service images after comments and recognizes registry-qualified images', async t => {
  const { project, request, register } = await fixture(t);
  await writeFile(join(project, 'compose.yaml'), [
    'services: # development services',
    '  worker:',
    '    image: example/worker:1',
    '    environment:',
    '      image: redis:7',
    '# Local services start below.',
    '  "sql": # SQL Server',
    '    image: "mcr.microsoft.com/mssql/server:2022-latest"',
    '    profiles: [dev]',
    '  pg:',
    '    image: docker.io/library/postgres:17 # PostgreSQL',
    '  dynamic:',
    '    image: "${CUSTOM_DB_IMAGE}"',
    'volumes:',
    '  pg:',
    '    image: mysql:8'
  ].join('\r\n'));
  const nested = join(project, 'infrastructure/development/databases');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'docker-compose.yml'), JSON.stringify({ services: { ledger: { image: 'library/mariadb:11' } } }));
  const route = await register();
  const data = await (await request(route + '/database-discovery')).json();
  assert.deepEqual(data.requirements.map(({ engine, key, kind, status }) => [engine, key, kind, status]).sort(), [
    ['mysql', 'ledger', 'compose', 'unverified'], ['postgres', 'pg', 'compose', 'unverified'], ['sqlserver', 'sql', 'compose', 'unverified']
  ]);
  assert.equal(data.requirements.find(item => item.key === 'ledger').variant, 'mariadb');
});

test('SQLite inspects real schema, backs up WAL data, previews a restore and creates only absent files', { timeout: 45000 }, async t => {
  const { root, project, request, register } = await fixture(t);
  await mkdir(join(project, 'prisma'));
  await writeFile(join(project, '.env'), 'DATABASE_URL=file:./ restored.sqlite\n');
  await writeFile(join(project, 'prisma', 'schema.prisma'), [
    'datasource main { provider = "sqlite" url = "file:./restored.sqlite" }',
    'datasource empty { provider = "sqlite" url = "file:./new.sqlite" }'
  ].join('\n'));
  const file = join(project, 'prisma', 'live.sqlite');
  const writer = join(root, 'writer.cjs');
  await writeFile(writer, `const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(value); INSERT INTO notes VALUES(41);');
process.stdout.write('ready\\n'); setInterval(()=>{},1000);`);
  const controller = new AbortController();
  let mark;
  const ready = new Promise(resolve => { mark = resolve; });
  const running = run(process.execPath, ['--experimental-sqlite', writer, file], {
    signal: controller.signal, timeout: 45000, log: text => { if (text.includes('ready')) mark(); }
  });
  running.catch(() => {});
  t.after(() => controller.abort());
  try {
    await Promise.race([ready, running]);
    assert.ok((await readFile(file + '-wal')).length);
    const route = await register();
    const discovery = await (await request(route + '/database-discovery')).json();
    const binding = name => discovery.bindings.find(item => item.instance.path === 'prisma/' + name).id;
    const source = binding('live.sqlite'), target = binding('restored.sqlite'), empty = binding('new.sqlite');
    const inspect = async id => (await request(route + '/database-sqlite-inspect', { bindingId: id })).json();
    assert.equal((await inspect(source)).details.objects[0].name, 'notes');
    assert.equal((await inspect(target)).capabilities.create, true);
    const endpoint = route + '/database-archive';
    const backup = await request(endpoint, {}, { 'X-StackForge-Binding': source });
    assert.equal(backup.status, 200, backup.status === 200 ? '' : JSON.stringify(await backup.clone().json()));
    const archive = Buffer.from(await backup.arrayBuffer());
    const preview = await request(endpoint + '/preview', archive, { 'X-StackForge-Binding': target });
    assert.equal(preview.status, 200, preview.status === 200 ? '' : JSON.stringify(await preview.clone().json()));
    const result = await preview.json();
    assert.equal(result.name, 'prisma/restored.sqlite');
    assert.equal(result.objects, 1);
    const restore = data => request(endpoint + '/restore', data, { 'X-StackForge-Binding': target,
      'X-StackForge-Preview': result.id, 'X-StackForge-Target': Buffer.from(result.name).toString('base64') });
    const changed = Buffer.from(archive);
    changed[changed.length - 1] ^= 1;
    assert.equal((await restore(changed)).status, 409);
    assert.deepEqual(await (await restore(archive)).json(), { restored: true, objects: 1, limited: false });
    assert.equal((await restore(archive)).status, 409);
    const output = await run(process.execPath, ['--experimental-sqlite', '-e',
      "console.log(new (require('node:sqlite').DatabaseSync)(process.argv[1]).prepare('SELECT value FROM notes').get().value)",
      join(project, result.name)], { stdoutOnly: true });
    assert.equal(output.trim(), '41');
    assert.equal((await request(route + '/database-sqlite-create', { bindingId: empty, confirmPath: 'wrong' })).status, 409);
    const create = () => request(route + '/database-sqlite-create', { bindingId: empty, confirmPath: 'prisma/new.sqlite' });
    assert.equal((await create()).status, 200);
    assert.equal((await create()).status, 409);
    assert.equal((await inspect(empty)).details.count, 0);
    const log = JSON.parse(await readFile(join(root, 'state', 'databases.json'), 'utf8'));
    assert.equal(log.backups[0].checksum, result.metadata.checksum);
  } finally { controller.abort(); await running.catch(() => {}); }
});

test('Drizzle SQLite binds approval to the file and SQL, rolls back failures, and recognizes restored history', {
  timeout: 45000, skip: !sqlite?.DatabaseSync.prototype.setAuthorizer
}, async t => {
  const { DatabaseSync } = sqlite;
  const { project, request, register } = await fixture(t);
  const file = join(project, 'notes.sqlite');
  const config = async filename => writeFile(join(project, 'drizzle.config.ts'), `export default { dialect: 'sqlite',
    dbCredentials: { url: 'file:${filename}' }, migrations: { table: 'drizzle_log' } }`);
  await config('notes.sqlite');
  await writeFile(join(project, 'package.json'), JSON.stringify({ devDependencies: { 'drizzle-kit': '0.31.8' } }));
  const folders = ['20261101100000_create', '20261101100100_update'];
  const migrations = folders.map(folder => join(project, 'drizzle', folder));
  await mkdir(migrations[0], { recursive: true });
  await writeFile(join(migrations[0], 'migration.sql'), 'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO notes VALUES (1, \'first note\');');
  const route = await register();
  const discovery = () => request(route + '/database-discovery').then(response => response.json());
  const requirementId = (await discovery()).requirements.find(item => item.migrationAdapter === 'drizzle').id;
  const endpoint = route + '/database-drizzle-';
  const preview = (extra = {}) => request(endpoint + 'preview', { requirementId, ...extra }).then(response => response.json());
  const apply = (planId, confirmName = 'notes.sqlite') => request(endpoint + 'apply', { requirementId, planId, confirmName });
  const check = async (planId, status) => {
    const response = await apply(planId);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, status, JSON.stringify(result));
  };
  assert.equal((await preview({ databaseFile: 'wrong.sqlite' })).status, 'configuration-needed');
  const initial = await preview();
  assert.equal(initial.status, 'pending');
  assert.equal((await apply(initial.planId, 'wrong.sqlite')).status, 409);
  await check(initial.planId, 'applied');
  const query = sql => {
    const database = new DatabaseSync(file, { readOnly: true });
    try { return database.prepare(sql).get(); }
    finally { database.close(); }
  };
  assert.equal(query('SELECT title FROM notes').title, 'first note');
  assert.equal((await preview()).status, 'current');
  const archiveEndpoint = route + '/database-archive';
  const source = (await discovery()).bindings.find(item => item.instance.path === 'notes.sqlite').id;
  const backup = await request(archiveEndpoint, {}, { 'X-StackForge-Binding': source });
  assert.equal(backup.status, 200);
  const archive = Buffer.from(await backup.arrayBuffer());
  await config('restored.sqlite');
  const restored = (await discovery()).bindings.find(item => item.instance.path === 'restored.sqlite').id;
  const restoreHeaders = { 'X-StackForge-Binding': restored };
  const restorePreview = await request(archiveEndpoint + '/preview', archive, restoreHeaders);
  assert.equal(restorePreview.status, 200);
  const restorePlan = await restorePreview.json();
  assert.equal((await request(archiveEndpoint + '/restore', archive, { ...restoreHeaders,
    'X-StackForge-Preview': restorePlan.id, 'X-StackForge-Target': Buffer.from(restorePlan.name).toString('base64') })).status, 200);
  assert.equal((await preview()).status, 'current');
  await config('notes.sqlite');
  await mkdir(migrations[1]);
  const second = join(migrations[1], 'migration.sql');
  const additive = 'ALTER TABLE notes ADD pinned INTEGER NOT NULL DEFAULT 0;';
  await writeFile(second, additive);
  const plan = await preview();
  await writeFile(second, additive + '\n');
  assert.equal((await apply(plan.planId)).status, 409);
  await writeFile(second, additive);
  const replacementPlan = await preview();
  const old = join(project, 'original.sqlite');
  await rename(file, old);
  await writeFile(file, await readFile(old));
  assert.equal((await apply(replacementPlan.planId)).status, 409);
  const alias = join(project, 'alias.sqlite');
  await link(file, alias);
  assert.equal((await preview()).status, 'sqlite-file-invalid');
  await rm(alias);
  for (const sql of ["ATTACH DATABASE 'out.sqlite' AS outside;", 'COMMIT;', 'DROP TABLE drizzle_log;', 'PRAGMA writable_schema=ON;']) {
    await writeFile(second, additive + sql);
    await check((await preview()).planId, 'sqlite-sql-blocked');
    assert.equal(query("SELECT count(*) AS total FROM pragma_table_info('notes') WHERE name='pinned'").total, 0);
    assert.equal(query('SELECT count(*) AS total FROM drizzle_log').total, 1);
  }
  await writeFile(second, additive + 'INSERT INTO nonexistent VALUES (1);');
  await check((await preview()).planId, 'apply-failed');
  assert.equal(query("SELECT count(*) AS total FROM pragma_table_info('notes') WHERE name='pinned'").total, 0);
  await writeFile(second, additive);
  const wal = new DatabaseSync(file);
  try {
    wal.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE notes SET title='kept from WAL';");
    await check((await preview()).planId, 'applied');
    assert.deepEqual({ ...query('SELECT title, pinned FROM notes') }, { title: 'kept from WAL', pinned: 0 });
  } finally { wal.close(); }
  assert.equal((await preview()).status, 'current');
  const third = join(project, 'drizzle', '20261101100200_shared');
  await mkdir(third);
  await writeFile(join(third, 'migration.sql'), 'CREATE TABLE another (id INTEGER);');
  const locked = new DatabaseSync(file);
  try {
    locked.exec('BEGIN IMMEDIATE;');
    await check((await preview()).planId, 'sqlite-locked');
  } finally { locked.close(); }
  const child = join(project, 'child');
  await mkdir(child);
  await rename(file, join(child, 'notes.sqlite'));
  await config('child/notes.sqlite');
  await writeFile(join(child, 'package.json'), '{}');
  assert.equal((await request('/api/projects/import', { path: child })).status, 201);
  const shared = await preview();
  assert.equal(shared.status, 'pending');
  const denied = await apply(shared.planId);
  assert.equal(denied.status, 409);
  assert.match((await denied.json()).error, /Another project uses this SQLite database file/);
});

test('remote profile testing pins TLS and saves an opaque credential reference', async t => {
  const values = new Map();
  const vault = {
    async save(secret) { const id = randomUUID(); values.set(id, secret); return id; },
    async read(id) { return values.get(id); },
    async remove(id) { values.delete(id); }
  };
  const password = 'isolated-remote-secret';
  let tested = 0;
  const command = async (program, args, options) => {
    assert.equal(program, 'psql');
    assert.equal(args.includes(password), false);
    assert.equal(options.env.PGSSLMODE, 'verify-full');
    assert.equal(options.env.PGPASSWORD, password);
    tested++;
    return '17.4\tapp\tt\tt\tt\t123456789\tf\tt\tt\t16384\n';
  };
  const { project, root, request, register } = await fixture(t, { vault, command });
  const ca = join(root, 'ca.pem');
  await writeFile(ca, 'test fixture');
  await writeFile(join(project, '.env'), 'DATABASE_URL=postgresql://operator@db.example.net:5432/app');
  const route = await register();
  assert.equal(tested, 0);
  const discovery = await (await request(route + '/database-discovery')).json();
  const bindingId = discovery.bindings[0].id;
  const profile = payload => request(route + '/database-remote-profile', { bindingId, ...payload });
  const result = await (await profile({ mode: 'save', ca, user: 'operator', password })).json();
  assert.deepEqual(result.providerPermissions, { start: false, stop: false, delete: false });
  assert.equal(result.capabilities.restore, true);
  const persisted = await readFile(join(root, 'state', 'databases.json'), 'utf8');
  assert.equal(persisted.includes(password), false);
  assert.equal((await profile({ mode: 'test' })).status, 200);
  assert.equal(tested, 2);
  assert.equal((await profile({ mode: 'remove' })).status, 200);
  assert.equal(values.size, 0);
});

test('unregistering a project blocks concurrent writes and can retry a failed credential cleanup', { timeout: 15000 }, async t => {
  const cleanupStarted = Promise.withResolvers();
  const releaseCleanup = Promise.withResolvers();
  let attempts = 0;
  let credential;
  const vault = {
    async save(secret) { credential = secret; return randomUUID(); },
    async read() { return credential; },
    async remove() {
      if (++attempts === 1) {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        throw new Error('Credential store is temporarily unavailable.');
      }
      credential = undefined;
    }
  };
  const { project, root, request, register } = await fixture(t, {
    vault, command: async () => '17.4\tapp\tt\tt\tt\t123456789\tf\tt\tt\t16384\n'
  });
  const ca = join(root, 'ca.pem');
  const env = 'DATABASE_URL=postgresql://operator@db.example.net:5432/app';
  await writeFile(ca, 'test fixture');
  await writeFile(join(project, '.env'), env);
  const route = await register();
  const { bindings: [binding] } = await (await request(route + '/database-discovery')).json();
  const profile = payload => request(route + '/database-remote-profile', { bindingId: binding.id, ...payload });
  assert.equal((await profile({ mode: 'save', ca, user: 'operator', password: 'test-secret' })).status, 200);
  const name = { confirmName: 'project' };
  const remove = () => request(route + '/remove', name);
  const first = remove();
  try {
    await Promise.race([cleanupStarted.promise, first.then(response => assert.fail('Removal finished before cleanup with status ' + response.status))]);
    assert.equal((await request(route + '/check-config', { commands: [] })).status, 409);
    const { projects: [pending] } = await (await request('/api/projects')).json();
    assert.equal(pending.operation, 'projectRemoval');
    assert.equal(pending.deleting, false);
    assert.equal((await remove()).status, 409);
    assert.equal((await profile({ mode: 'remove' })).status, 409);
  } finally {
    releaseCleanup.resolve();
    await first;
  }
  assert.equal((await first).status, 500);
  const { projects: [registered] } = await (await request('/api/projects')).json();
  assert.equal(registered.operation, undefined);
  assert.deepEqual(await (await remove()).json(), { removed: true });
  assert.equal(credential, undefined);
  assert.equal(attempts, 2);
  assert.equal((await request(route + '/database-discovery')).status, 404);
  assert.equal(await readFile(join(project, '.env'), 'utf8'), env);
});

test('a replaced clone keeps failed credential cleanup until restart and preserves other profiles', async t => {
  const credentials = new Map();
  let keyringAvailable = false;
  const vault = {
    async save(secret) { const id = randomUUID(); credentials.set(id, secret); return id; },
    async read(id) { return credentials.get(id); },
    async remove(id) {
      if (!keyringAvailable) throw new Error('Credential store is temporarily unavailable.');
      credentials.delete(id);
    }
  };
  const env = 'DATABASE_URL=postgresql://operator@db.example.net:5432/app';
  const git = async (_command, args) => {
    const checkout = args.at(-1);
    await mkdir(join(checkout, '.git'), { recursive: true });
    await writeFile(join(checkout, '.env'), env);
  };
  const options = { clone: (repo, parent, settings) => cloneGithub(repo, parent, { ...settings, command: git }) };
  const { root, project, request, register, restart } = await fixture(t, {
    vault, command: async () => '17.4\tapp\tt\tt\tt\t123456789\tf\tt\tt\t16384\n'
  }, options);
  const ca = join(root, 'ca.pem');
  await writeFile(ca, 'test fixture');
  await writeFile(join(project, '.env'), env);
  const clone = async () => {
    const response = await request('/api/projects/clone', { repository: 'https://github.com/owner/demo', parentDir: root });
    assert.equal(response.status, 201);
    return response.json();
  };
  const save = async (route, password) => {
    const { bindings: [binding] } = await (await request(route + '/database-discovery')).json();
    const response = await request(route + '/database-remote-profile', { mode: 'save', bindingId: binding.id, ca, user: 'operator', password });
    assert.equal(response.status, 200);
  };
  const first = await clone();
  const other = await register();
  await save('/api/projects/' + first.id, 'old-clone-secret');
  await save(other, 'shared-project-secret');
  const parked = join(root, 'original-clone');
  await rename(first.path, parked);
  const replacement = await clone();
  assert.notEqual(replacement.id, first.id);
  assert.equal(replacement.cloneCleanupPending, true);
  await save('/api/projects/' + replacement.id, 'replacement-secret');
  const readState = async name => JSON.parse(await readFile(join(root, 'state', name + '.json'), 'utf8'));
  assert.deepEqual((await readState('projects')).replacedClones, [first.id]);
  assert.equal(credentials.size, 3);
  keyringAvailable = true;
  await restart();
  for (let attempt = 0; attempt < 100 && (await readState('projects')).replacedClones.length; attempt++) await sleep(20);
  assert.deepEqual((await readState('projects')).replacedClones, []);
  assert.deepEqual([...credentials.values()].sort(), ['replacement-secret', 'shared-project-secret']);
  const state = await readState('databases');
  assert.equal(state.requirements[first.id], undefined);
  assert.equal(Object.values(state.profiles).some(profile => profile.projectId === first.id), false);
  assert.equal(Object.values(state.bindings).filter(binding => binding.projectId === first.id).length, 0);
  assert.equal(await readFile(join(parked, '.env'), 'utf8'), env);
});

test('Windows saves and reads a real user-bound DPAPI credential', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'stackforge-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = databaseVault(root);
  const value = 'test-secret-' + randomUUID();
  const key = await vault.save(value);
  assert.equal((await readFile(join(root, key), 'utf8')).includes(value), false);
  assert.equal(await vault.read(key), value);
  await vault.remove(key);
  await assert.rejects(vault.read(key), /credential store/);
});
