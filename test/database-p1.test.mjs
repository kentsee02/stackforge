import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { localInstallation } from '../src/database-local.mjs';
import { ProjectOperations } from '../src/project-operations.mjs';

test('import and clone discover multiple databases, preserve shared bindings on relocation and initialize only reviewed plans', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-db-p1-')));
  const project = join(root, 'imported');
  const checkout = join(root, 'cloned');
  const relocated = join(root, 'relocated');
  const stateDir = join(root, 'state', 'jobs');
  const secret = 'synthetic-password-for-tests';
  const migration = join(project, 'database', 'migrations');
  await mkdir(join(project, 'prisma'), { recursive: true });
  await mkdir(migration, { recursive: true });
  await writeFile(join(project, '.env'), [
    `DATABASE_URL=postgresql://operator:${secret}@localhost:5432/shared`,
    `SECOND_DATABASE_URL=postgresql://operator:${secret}@127.0.0.1:5432/isolated`
  ].join('\n'));
  await writeFile(join(project, '.env.example'), 'DB_CONNECTION=mysql\nDB_HOST=example.com\nDB_DATABASE=app');
  await writeFile(join(project, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" url = env("MISSING_URL") }');
  await writeFile(join(project, 'compose.yaml'), 'services:\n  mysql:\n    image: mysql:8.4\n  cache:\n    image: redis:7\n');
  await writeFile(join(project, 'app.db'), '');
  const sql = 'CREATE TABLE items (id INT PRIMARY KEY, quantity DECIMAL(10, 2));';
  await writeFile(join(migration, '001.sql'), sql);
  let exists = false, empty = true;
  const writes = [];
  const command = async (program, args, options) => {
    assert.equal(program, 'psql');
    assert.equal(args.includes(secret), false);
    const statement = String(options.input);
    if (statement.includes('CREATE DATABASE')) { exists = true; writes.push(statement.trim()); return ''; }
    if (statement.startsWith('BEGIN')) { empty = false; writes.push(statement.trim()); return ''; }
    if (statement.includes('pg_control_system')) return `170002\t5432\tf\t${exists ? 't' : 'f'}\tt\t1123456789`;
    if (statement.includes('has_schema_privilege')) return empty ? 't\tt' : 'f\tt';
    if (statement.includes('COUNT(DISTINCT table_name)')) return '1';
    assert.fail(statement);
  };
  const app = createApp({ stateDir, localDatabase: { command }, clone: async () => {
    await mkdir(checkout);
    await writeFile(join(checkout, '.env'), 'DATABASE_URL=postgresql://operator@127.0.0.1:5432/shared');
    return { path: checkout };
  } }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    await app.shutdownTasks();
    await new Promise(done => app.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.address().port;
  const get = path => fetch(base + path).then(response => response.json());
  const { token } = await get('/api/state');
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-StackForge-Token': token
  }, body: JSON.stringify(body) });
  const imported = await post('/api/projects/import', { path: project });
  assert.equal(imported.status, 201);
  const { id } = await imported.json();
  const route = '/api/projects/' + id;
  const clone = await post('/api/projects/clone', { repository: 'https://github.com/example/demo', parentDir: root });
  assert.equal(clone.status, 201);
  const data = await get(route + '/database-discovery');
  for (const engine of ['postgres', 'mysql', 'sqlite', 'redis']) assert.ok(data.requirements.some(item => item.engine === engine));
  assert.ok(data.requirements.some(item => item.status === 'placeholder'));
  assert.ok(data.requirements.some(item => item.status === 'missing'));
  assert.ok(data.bindings.some(item => item.instance.name === 'shared' && item.shared));
  assert.doesNotMatch(JSON.stringify(data), new RegExp(secret));
  const binding = data.bindings.find(item => item.instance.name === 'isolated');
  const payload = { bindingId: binding.id, user: 'operator', password: secret, schema: true };
  const preview = () => post(route + '/database-initialization-plan', payload).then(response => response.json());
  const plan = await preview();
  assert.deepEqual(plan.steps, ['create', 'schema']);
  assert.equal(plan.migrations[0].table, 'items');
  assert.deepEqual(writes, []);
  assert.equal((await post(route + '/database-initialize', { ...payload, planId: plan.id, confirmName: 'wrong' })).status, 409);
  await writeFile(join(migration, '001.sql'), sql.replace('quantity', 'amount'));
  assert.equal((await post(route + '/database-initialize', { ...payload, planId: plan.id, confirmName: 'isolated' })).status, 409);
  assert.deepEqual(writes, []);
  const reviewed = await preview();
  assert.deepEqual(await (await post(route + '/database-initialize', { ...payload, planId: reviewed.id, confirmName: 'isolated' })).json(),
    { initialized: true, schema: 'verified' });
  assert.equal(writes.length, 2);
  assert.deepEqual((await preview()).steps, []);
  await rename(project, relocated);
  const moved = await (await post('/api/projects/import', { path: relocated })).json();
  assert.equal(moved.id, id);
  const after = await get(route + '/database-discovery');
  assert.equal(after.bindings.find(item => item.instance.name === 'isolated').id, binding.id);
  assert.equal(after.migrations[0].status, 'succeeded');
  const persisted = await readFile(join(root, 'state', 'databases.json'), 'utf8');
  const audit = await readFile(join(root, 'state', 'database-operations.jsonl'), 'utf8');
  assert.doesNotMatch(persisted + audit, new RegExp(secret));
});

test('Docker volume deletion rechecks registered database users and disables shared deletion in the UI capabilities', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-db-share-')));
  const managed = join(root, 'managed');
  const consumer = join(root, 'consumer');
  await mkdir(join(managed, 'scripts'), { recursive: true });
  await mkdir(consumer);
  await writeFile(join(managed, 'scripts', 'dev.mjs'), '');
  await writeFile(join(managed, 'stackforge.json'), JSON.stringify({ generator: 'StackForge',
    options: { name: 'managed', frontend: 'none', backend: 'express', database: 'postgres' } }));
  const volume = 'managed_db_data';
  const endpoints = [{ engine: 'postgres', host: '0.0.0.0', port: 16432 }];
  const operations = new ProjectOperations();
  const target = { volume, endpoints };
  operations.databaseDeletionTarget = async () => target;
  operations.database = async () => ({ status: 'stopped', capabilities: { delete: true }, endpoints });
  let mutations = 0;
  operations.removeDatabase = async (_project, _ports, confirmation, _signal, verify) => {
    assert.equal(confirmation, volume);
    await verify(target);
    mutations++;
  };
  const app = createApp({ stateDir: false, operations }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    await app.shutdownTasks();
    await new Promise(done => app.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.address().port;
  const get = path => fetch(base + path);
  const { token } = await (await get('/api/state')).json();
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-StackForge-Token': token
  }, body: JSON.stringify(body) });
  const add = async path => (await post('/api/projects/import', { path })).json();
  const { id } = await add(managed);
  const external = await add(consumer);
  const route = '/api/projects/' + id;
  assert.equal((await get(route + '/database-delete')).status, 200);
  await writeFile(join(consumer, '.env'), 'DATABASE_URL=postgresql://user@127.0.0.1:16432/another_schema');
  assert.equal((await get(route + '/database-delete')).status, 409);
  const status = await (await get(route + '/database?capabilities=1')).json();
  assert.equal(status.capabilities.delete, false);
  assert.equal(Object.hasOwn(status, 'endpoints'), false);
  assert.equal((await post(route + '/database-delete', { confirmVolume: volume })).status, 202);
  let task;
  for (let attempt = 0; attempt < 20; attempt++) {
    const { projects } = await (await get('/api/projects?logs=' + id)).json();
    task = projects.find(project => project.id === id).databaseTask;
    if (task.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(task.status, 'failed');
  assert.match(task.error, /Shared databases/);
  assert.equal(mutations, 0);
  assert.equal((await post('/api/projects/' + external.id + '/remove', { confirmName: external.name })).status, 200);
  assert.equal((await get(route + '/database-delete')).status, 200);
});

test('local installation checks recognize Windows and Linux services without installing them', async () => {
  const target = { engine: 'postgres', host: '127.0.0.1', port: 5432, name: 'app' };
  const command = async (program, args) => {
    if (program === 'powershell.exe') return 'Running\r\n';
    if (program === 'systemctl') return 'LoadState=loaded\nActiveState=inactive\n';
    assert.deepEqual(args, ['--version']);
    return 'PostgreSQL 17.8';
  };
  const windows = await localInstallation(target, { platform: 'win32', command, probe: async () => true });
  assert.equal(windows.serviceStatus, 'running');
  assert.equal(windows.clientVersion, '17.8');
  const linux = await localInstallation(target, { platform: 'linux', command, probe: async () => false });
  assert.equal(linux.serviceStatus, 'stopped');
  assert.equal(linux.portOpen, false);
});
