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
    "createServer((req, res) => { if (req.url === '/unavailable') console.log('probed unavailable path'); res.writeHead(req.url === '/api/demo?view=local' ? 200 : 404); res.end(); })",
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
    { name: 'Web', directory: 'apps/web', command: 'node serve.mjs', port: webPort.port, kind: 'web' },
    { name: 'API', directory: 'apps/api', command: 'node serve.mjs', port: apiPort.port, kind: 'api', openPath: '/api/demo?view=local' }
  ];
  await action('start', {}, 409);
  await action('install', {}, 409);
  await action('startup', { services }, 403, 'invalid-token');
  for (const service of [
    { ...services[1], directory: '../outside' },
    { ...services[1], directory: 'escape' },
    { ...services[1], directory: 'C:outside' },
    { ...services[1], directory: 'missing' },
    { ...services[1], name: 'web' },
    { ...services[1], port: webPort.port },
    { ...services[1], kind: 'bad' },
    { ...services[1], openPath: '//example.com/path' },
    { ...services[1], openPath: '/\\example.com/path' },
    { ...services[1], openPath: 'https://example.com/path' }
  ]) await action('startup', { services: [services[0], service] }, 400);
  assert.deepEqual(await action('startup', { services }, 200), { services });
  await assert.rejects(stat(join(web, 'started.txt')), { code: 'ENOENT' });
  await close();
  await open();
  assert.deepEqual((await detail()).startupServices, services);
  assert.equal((await get('/api/projects')).projects[0].startupServices, undefined);
  await action('install', {}, 409);
  await action('startup', { services: [{ ...services[0], command: '', installCommand: 'node install.mjs' }] }, 400);
  await action('startup', { services: [{ ...services[0], installCommand: 'node\ninstall.mjs' }] }, 400);
  await writeFile(join(web, 'install.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('installed.txt', 'web'); console.log('web installed');");
  await writeFile(join(root, 'verify-install.mjs'), "import { readFileSync } from 'node:fs'; if (readFileSync('apps/web/installed.txt', 'utf8') !== 'web') process.exit(1); console.log('workspace verified');");
  const installOnly = { name: 'Workspace', directory: '.', installCommand: 'node verify-install.mjs' };
  await action('startup', { services: [{ ...services[0], installCommand: 'node install.mjs' }, services[1], installOnly] }, 200);
  await assert.rejects(stat(join(web, 'installed.txt')), { code: 'ENOENT' });
  await action('start', {}, 202);
  assert.match((await until(detail, project => project.status === 'failed')).error, /already in use/);
  await assert.rejects(stat(join(api, 'started.txt')), { code: 'ENOENT' });
  await webPort.close();

  await action('startup', { services: [services[0], { ...services[1], openPath: '/unavailable' }] }, 200);
  await action('start', {}, 202);
  const wrongPath = await until(detail, project => project.log.includes('probed unavailable path'));
  assert.equal(wrongPath.services[1].ready, false);
  assert.equal(wrongPath.ready, false);
  await action('stop', {}, 202);
  await until(detail, project => project.status === 'stopped');
  await action('startup', { services: [{ ...services[0], installCommand: 'node install.mjs' }, services[1], installOnly] }, 200);

  await action('start', {}, 202);
  const running = await until(detail, project => project.ready === true);
  assert.deepEqual(Object.values(running.services).map(service => service.name), ['Web', 'API']);
  assert.equal(running.services[0].kind, 'web');
  assert.equal(running.services[1].kind, 'api');
  assert.equal((await fetch(running.services[1].url)).status, 404);
  assert.equal((await fetch(running.services[1].openUrl)).status, 200);
  assert.match(running.log, /\[Web\] Web listening/);
  assert.match(running.log, /\[API\] API listening/);
  assert.equal(Object.values(running.services).length, 2);
  await assert.rejects(stat(join(web, 'installed.txt')), { code: 'ENOENT' });
  await action('install', {}, 409);
  await action('startup', { services: [] }, 409);
  await action('trash', { confirmName: project.name }, 409);
  await action('stop', {}, 202);
  await until(detail, project => project.status === 'stopped');
  for (const service of services) await assert.rejects(fetch('http://127.0.0.1:' + service.port, { signal: AbortSignal.timeout(1000) }));
  await action('install', {}, 202);
  const installed = await until(detail, project => !project.operation && project.dependencies?.status);
  assert.equal(installed.dependencies.status, 'succeeded', installed.dependencies.error);
  assert.match(installed.dependencies.log, /\[Web\][\s\S]*web installed[\s\S]*\[Workspace\][\s\S]*workspace verified/);
  assert.doesNotMatch(installed.dependencies.log, /\[API\]/);

  await action('startup', { services: [{ ...installOnly, installCommand: 'node -e "console.log(1234); setInterval(() => {}, 1000)"' }] }, 200);
  await action('start', {}, 409);
  assert.equal((await detail()).hasInstallCommands, true);
  await action('install', {}, 202);
  await until(detail, project => project.dependencies?.log.includes('1234'));
  await action('install-cancel', {}, 202);
  await until(detail, project => project.dependencies?.status === 'cancelled');

  await action('startup', { services: [
    { ...installOnly, installCommand: 'node -e "process.exit(5)"' },
    { name: 'API setup', directory: 'apps/api', installCommand: 'node -e "console.log(5678)"' }
  ] }, 200);
  await action('install', {}, 202);
  const rejectedInstall = await until(detail, project => project.dependencies?.status === 'failed');
  assert.match(rejectedInstall.dependencies.error, /5/);
  assert.doesNotMatch(rejectedInstall.dependencies.log, /API setup/);

  await writeFile(join(api, 'broken.mjs'), "console.error('JAVA_HOME is set to an invalid directory'); process.exit(7);");
  const broken = { ...services[1], command: 'node broken.mjs' };
  await action('startup', { services: [services[0], broken] }, 200);
  await action('start', {}, 202);
  const failed = await until(detail, project => project.status === 'failed');
  assert.match(failed.log, /\[API\].*7/);
  assert.equal(failed.diagnostic, 'java');
  await assert.rejects(fetch('http://127.0.0.1:' + webPort.port, { signal: AbortSignal.timeout(1000) }));

  await rename(root, root + '-original');
  await mkdir(web, { recursive: true });
  await mkdir(api, { recursive: true });
  await action('start', {}, 202);
  assert.match((await until(detail, project => project.status === 'failed')).error, /moved or replaced/);
  await action('startup', { services: [] }, 200);
  await action('start', {}, 409);
});
