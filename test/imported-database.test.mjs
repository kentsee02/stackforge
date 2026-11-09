import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { transferDatabase } from '../src/database-backup.mjs';
import { ProjectOperations } from '../src/project-operations.mjs';
import { createApp } from '../src/server.mjs';

test('imported Compose controls verify the container and dedicated volume before any mutation or database transfer', async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-compose-')));
  const root = join(workspace, 'imported');
  await mkdir(root);
  const composeFile = join(root, 'docker-compose.yml');
  await writeFile(composeFile, 'services: {}');
  const model = {
    name: 'example', services: {
      postgres: { image: 'postgres:17', volumes: [{ type: 'volume', source: 'data', target: '/var/lib/postgresql/data' }],
        environment: { POSTGRES_PASSWORD: 'test$$literal' }, depends_on: { web: { condition: 'service_started' } } },
      web: { image: 'nginx' }
    }, volumes: { data: { name: 'example_data' } }
  };
  const id = 'a'.repeat(64), foreign = 'b'.repeat(64);
  const dump = Buffer.from('PGDMPfixture');
  const labels = {
    'com.docker.compose.project': 'example', 'com.docker.compose.service': 'postgres',
    'com.docker.compose.project.working_dir': root, 'com.docker.compose.project.config_files': composeFile
  };
  let owner, state = 'exited', container = true, volume = true, shared = false, volumeDriver = 'local';
  const mutations = [];
  const docker = async (name, args, options) => {
    assert.equal(name, 'docker');
    if (args.includes('config')) {
      assert.equal(args[args.indexOf('-f') + 1], composeFile);
      return JSON.stringify(model);
    }
    if (args[0] === 'ps') return args.at(-1).startsWith('volume=') && shared ? `${id}\n${foreign}` : container ? id : '';
    if (args[0] === 'inspect') return [id, JSON.stringify(labels), '"postgres:17"', JSON.stringify({ Status: state }),
      JSON.stringify([{ Type: 'volume', Name: 'example_data', Destination: '/var/lib/postgresql/data', RW: true }])].join('\t');
    if (args[0] === 'volume' && args[1] === 'ls') return volume ? 'example_data\n' : '';
    if (args[0] === 'volume' && args[1] === 'inspect') return [JSON.stringify(volumeDriver), '{}', JSON.stringify({
      'com.docker.compose.project': 'example', 'com.docker.compose.volume': 'data', ...(owner && { 'io.stackforge.imported-compose-id': owner })
    })].join('\t');
    if (args[0] === 'volume' && args[1] === 'create') {
      mutations.push(args);
      owner = args.find(arg => arg.startsWith('io.stackforge.imported-compose-id=')).split('=')[1];
      volume = true;
      return 'example_data';
    }
    if (args[0] === 'compose' && args.includes('up')) {
      mutations.push(args);
      assert.equal(args[args.indexOf('-f') + 1], '-');
      assert.ok(args.includes('--no-recreate'));
      const pinned = JSON.parse(options.input);
      assert.deepEqual(Object.keys(pinned.services), ['postgres']);
      assert.equal(pinned.services.postgres.depends_on, undefined);
      assert.equal(pinned.services.postgres.environment.POSTGRES_PASSWORD, 'test$$literal');
      assert.deepEqual(pinned.volumes.data, { external: true, name: 'example_data' });
      labels['io.stackforge.imported-compose-id'] = pinned.services.postgres.labels['io.stackforge.imported-compose-id'];
      labels['com.docker.compose.project.config_files'] = '-';
      container = true;
      state = 'running';
      return;
    }
    if (args[0] === 'container') {
      assert.equal(args.at(-1), id);
      mutations.push(args);
      state = args[1] === 'start' ? 'running' : 'exited';
      return;
    }
    if (args[0] === 'logs') {
      assert.equal(args.at(-1), id);
      options.log('postgres is ready');
      return;
    }
    if (args[0] === 'exec') {
      assert.ok(args.includes(id));
      if (args.at(-1).includes('pg_dump')) return dump;
      if (args.includes('stackforge')) return 't';
      assert.deepEqual(options.input, dump);
      mutations.push(args);
      return;
    }
    assert.fail(args.join(' '));
  };

  const app = createApp({ stateDir: false, operations: new ProjectOperations({ command: docker }) }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    await app.shutdownTasks();
    await new Promise(done => app.close(done));
    await rm(workspace, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.address().port;
  const { token } = await (await fetch(base + '/api/state')).json();
  const post = (path, body = {}, extra = {}) => fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-StackForge-Token': token, ...extra
  }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const imported = await (await post('/api/projects/import', { path: root })).json();
  assert.equal(imported.hasComposeDatabase, true);
  const route = '/api/projects/' + imported.id;
  const get = path => fetch(base + route + path);
  const task = async action => {
    assert.equal((await post(route + '/database-' + action)).status, 202);
    for (let i = 0; i < 80; i++) {
      const { projects } = await (await fetch(base + '/api/projects?logs=' + imported.id)).json();
      const current = projects[0].databaseTask;
      if (['succeeded', 'failed'].includes(current?.status)) return current;
      await delay(20);
    }
    assert.fail('Database task did not finish');
  };
  assert.deepEqual(await (await get('/database')).json(), { engine: 'postgres', status: 'stopped' });
  assert.equal((await task('start')).status, 'succeeded');
  assert.deepEqual(await (await get('/database?logs=1')).json(), { engine: 'postgres', status: 'running', log: 'postgres is ready' });
  assert.deepEqual(Buffer.from(await (await post(route + '/database-backup')).arrayBuffer()), dump);
  const restoreHeaders = { 'Content-Type': 'application/octet-stream', 'X-StackForge-Confirm-Name': imported.name };
  assert.equal((await post(route + '/database-restore', dump, restoreHeaders)).status, 200);

  const before = mutations.length;
  shared = true;
  assert.equal((await post(route + '/database-backup')).status, 409);
  assert.equal((await task('stop')).status, 'failed');
  shared = false;
  volumeDriver = 'nfs';
  assert.equal((await get('/database')).status, 409);
  volumeDriver = 'local';
  labels['com.docker.compose.project.working_dir'] = workspace;
  assert.equal((await get('/database?logs=1')).status, 409);
  labels['com.docker.compose.project.working_dir'] = root;
  model.volumes.data.external = true;
  assert.equal((await task('stop')).status, 'failed');
  delete model.volumes.data.external;
  container = false;
  assert.equal((await task('start')).status, 'failed');
  assert.equal(mutations.length, before);

  volume = false;
  assert.equal((await task('start')).status, 'succeeded');
  assert.equal((await task('stop')).status, 'succeeded');
  assert.deepEqual(mutations.at(-1), ['container', 'stop', id]);
  await rename(root, root + '-old');
  await mkdir(root);
  await writeFile(composeFile, 'services: {}');
  assert.equal((await get('/database')).status, 409);
});

test('MySQL dump includes routines and events and rebinds their definers without changing SQL data', async () => {
  const dump = Buffer.from([
    '-- MySQL dump 10.13',
    "INSERT INTO messages VALUES ('literal DEFINER=`root`@`localhost`', '你好');",
    'CREATE DEFINER=`root`@`localhost` PROCEDURE `p`() SELECT 1;',
    'CREATE DEFINER=`root`@`localhost` FUNCTION `f`() RETURNS INT DETERMINISTIC RETURN 1;',
    '/*!50117 DEFINER=`root`@`localhost`*/ /*!50106 EVENT `e` ON SCHEDULE EVERY 1 DAY DO SELECT 1 */;',
    '/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */'
  ].join('\n'));
  const calls = [];
  const command = async (_name, args, options) => {
    calls.push({ args, options });
    if (args.at(-1).includes('mysqldump')) return dump;
    if (args.includes('stackforge')) return '1';
  };
  const input = { engine: 'mysql', project: 'demo', container: 'id', config: {}, command };
  const { data } = await transferDatabase(input);
  assert.match(calls[0].args.at(-1), /--routines --events --triggers --user=root/);
  assert.match(calls[0].args.at(-1), /MYSQL_ROOT_PASSWORD_FILE/);
  const text = data.toString();
  assert.match(text, /literal DEFINER=`root`@`localhost`', '你好'/);
  assert.match(text, /CREATE\s+PROCEDURE/);
  assert.match(text, /CREATE\s+FUNCTION/);
  assert.match(text, /EVENT `e`/);
  assert.match(text, /SQL SECURITY DEFINER/);
  assert.doesNotMatch(text, /CREATE DEFINER|50013 DEFINER|50117 DEFINER/);
  await transferDatabase({ ...input, file: dump });
  assert.match(calls[1].args.join(' '), /information_schema\.routines/);
  assert.match(calls[2].args.at(-1), /--user="\$MYSQL_USER"/);
  assert.deepEqual(calls[2].options.input, data);
});
