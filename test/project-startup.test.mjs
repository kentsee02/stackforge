import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';

async function reservePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

async function until(read, accepts) {
  const deadline = Date.now() + 9000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accepts(value)) return value;
    await delay(50);
  }
  assert.fail('Expected runtime state was not reached. Last state: ' + JSON.stringify(value));
}

test('custom startup persists and safely runs a monorepo with independent working directories and ports', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stackforge-startup-'));
  const root = join(directory, '测试 workspace');
  const web = join(root, 'apps', 'web');
  const api = join(root, 'apps', 'api');
  const external = join(directory, 'outside');
  const command = name => [
    "import { createServer } from 'node:http';",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('started.txt', process.cwd());",
    "createServer((req, res) => { res.writeHead(404); res.end(); })",
    ".listen(Number(process.env.PORT), '127.0.0.1', () => console.log('" + name + " listening'));"
  ].join('\n');
  await Promise.all([mkdir(web, { recursive: true }), mkdir(api, { recursive: true }), mkdir(external)]);
  await Promise.all([writeFile(join(web, 'serve.mjs'), command('Web')), writeFile(join(api, 'serve.mjs'), command('API'))]);
  await symlink(external, join(root, 'escape'), 'junction');
  const webPort = await reservePort();
  const apiPort = await reservePort();
  await apiPort.close();

  let app, url, token;
  async function get(path) {
    const response = await fetch(url + path, { headers: { Connection: 'close' } });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function post(path, payload, expected, auth = token) {
    const response = await fetch(url + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': auth, Connection: 'close' }, body: JSON.stringify(payload) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  async function open() {
    app = createApp({ stateDir: join(directory, 'state', 'jobs') });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    url = 'http://127.0.0.1:' + app.address().port;
    ({ token } = await get('/api/state'));
  }
  async function close() {
    if (!app) return;
    await app.shutdownTasks();
    await new Promise(resolve => app.close(resolve));
    app = undefined;
  }
  t.after(async () => {
    await close();
    await webPort.close();
    await rm(directory, { recursive: true, force: true });
  });

  await open();
  const project = await post('/api/projects/import', { path: root }, 201);
  const action = (name, body, expected, auth) => post('/api/projects/' + project.id + '/' + name, body, expected, auth);
  const detail = async () => (await get('/api/projects?logs=' + project.id)).projects[0];
  const services = [
    { name: 'Web', directory: 'apps/web', command: 'node serve.mjs', port: webPort.port },
    { name: 'API', directory: 'apps/api', command: 'node serve.mjs', port: apiPort.port }
  ];
  await action('start', {}, 409);
  await action('startup', { services }, 403, 'invalid-token');
  for (const service of [
    { ...services[1], directory: '../outside' },
    { ...services[1], directory: 'escape' },
    { ...services[1], directory: 'C:outside' },
    { ...services[1], directory: 'missing' },
    { ...services[1], name: 'web' },
    { ...services[1], port: webPort.port }
  ]) await action('startup', { services: [services[0], service] }, 400);
  assert.deepEqual(await action('startup', { services }, 200), { services });
  await assert.rejects(stat(join(web, 'started.txt')), { code: 'ENOENT' });
  await close();
  await open();
  assert.deepEqual((await detail()).startupServices, services);
  assert.equal((await get('/api/projects')).projects[0].startupServices, undefined);
  await action('start', {}, 202);
  assert.match((await until(detail, project => project.status === 'failed')).error, /already in use/);
  await assert.rejects(stat(join(api, 'started.txt')), { code: 'ENOENT' });
  await webPort.close();

  await action('start', {}, 202);
  const running = await until(detail, project => project.ready === true);
  assert.deepEqual(Object.values(running.services).map(service => service.name), ['Web', 'API']);
  assert.match(running.log, /\[Web\] Web listening/);
  assert.match(running.log, /\[API\] API listening/);
  await action('startup', { services: [] }, 409);
  await action('trash', { confirmName: project.name }, 409);
  await action('stop', {}, 202);
  await until(detail, project => project.status === 'stopped');
  for (const service of services) await assert.rejects(fetch('http://127.0.0.1:' + service.port, { signal: AbortSignal.timeout(1000) }));

  const broken = { ...services[1], command: 'node -e "process.exit(7)"' };
  await action('startup', { services: [services[0], broken] }, 200);
  await action('start', {}, 202);
  const failed = await until(detail, project => project.status === 'failed');
  assert.match(failed.log, /\[API\].*7/);
  await assert.rejects(fetch('http://127.0.0.1:' + webPort.port, { signal: AbortSignal.timeout(1000) }));

  await rename(root, root + '-original');
  await mkdir(web, { recursive: true });
  await mkdir(api, { recursive: true });
  await action('start', {}, 202);
  assert.match((await until(detail, project => project.status === 'failed')).error, /moved or replaced/);
  await action('startup', { services: [] }, 200);
  await action('start', {}, 409);
});
