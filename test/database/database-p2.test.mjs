import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/http/server.mjs';
import { archiveBackup, inspectArchive } from '../../src/database/backup/archive.mjs';
import { run } from '../../src/platform/process.mjs';
import { databaseVault } from '../../src/database/security/vault.mjs';

async function fixture(t, adapters) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-p2-')));
  const project = join(root, 'project');
  await mkdir(project);
  const app = createApp({ stateDir: join(root, 'state', 'jobs'), databaseAdapters: adapters }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    await app.shutdownTasks();
    await new Promise(resolve => app.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.address().port;
  const { token } = await (await fetch(base + '/api/state')).json();
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
  return { root, project, request, register };
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
