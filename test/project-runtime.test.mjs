import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { ProjectRuntime, startupDiagnostic } from '../src/project-runtime.mjs';
import { createApp } from '../src/server.mjs';
import { createDesktop } from '../src/desktop.mjs';
import { ProjectConfig, validatePorts } from '../src/project-config.mjs';

const childScript = `import { spawn } from 'node:child_process';
const program = "const server = require('node:net').createServer(); server.listen(0, '127.0.0.1', () => console.log('ready', server.address().port));";
const child = spawn(process.execPath, ['-e', program], { stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
process.on('SIGTERM', () => { process.kill(-child.pid, 'SIGTERM'); });
`;

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stackforge-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createProject(parent, name, script, stack = {}) {
  const path = join(parent, name);
  const options = { name, frontend: 'vue', backend: 'none', database: 'none', ...stack };
  await mkdir(join(path, 'scripts'), { recursive: true });
  await writeFile(join(path, 'stackforge.json'), JSON.stringify({ generator: 'StackForge', options }));
  await writeFile(join(path, 'scripts', 'dev.mjs'), script);
  return { ...options, path };
}

async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await check();
    if (value) return value;
    await sleep(35);
  }
  assert.fail('Expected runtime state was not reached');
}

test('a managed run streams logs, rejects overlapping ports, stops its children, and can restart', async t => {
  const parent = await workspace(t);
  const project = await createProject(parent, 'project & 中文', childScript);
  const other = { ...project, name: 'different', path: join(parent, 'different') };
  const runtime = new ProjectRuntime({ probePort: async () => true });
  t.after(() => runtime.shutdown());
  runtime.start(project);
  runtime.start(project);
  assert.throws(() => runtime.start(other), /5173 is already in use/);
  const waitForPort = () => until(() => runtime.status(project, true).log.match(/ready (\d+)/));
  const [, port] = await waitForPort();
  assert.equal(runtime.status(project).status, 'running');
  runtime.stop(project);
  runtime.stop(project);
  await until(() => runtime.status(project).status === 'stopped');
  const probe = createServer().listen(Number(port), '127.0.0.1');
  await once(probe, 'listening');
  await new Promise(resolve => probe.close(resolve));
  assert.match(runtime.status(project, true).log, /ready/);
  runtime.start(project);
  await waitForPort();
  await runtime.shutdown();
  assert.equal(runtime.status(project).status, 'stopped');
  assert.throws(() => runtime.start(project), /shutting down/);
});

test('stopping during startup prevents execution and a failed run retains bounded output', async t => {
  const parent = await workspace(t);
  const project = await createProject(parent, 'failed-app', "process.stderr.write('x'.repeat(100000) + ' END', () => process.exit(3));");
  const runtime = new ProjectRuntime({ probePort: async () => true });
  t.after(() => runtime.shutdown());
  runtime.start(project);
  runtime.stop(project);
  await until(() => runtime.status(project).status === 'stopped');
  assert.equal(runtime.status(project, true).log, '');
  runtime.start(project);
  await until(() => runtime.status(project).status === 'failed');
  const result = runtime.status(project, true);
  assert.match(result.error, /exited \(3\)/);
  assert.ok(result.truncated);
  assert.equal(result.log.length, 64 * 1024);
  assert.match(result.log, / END$/);
  runtime.start({ ...project, name: 'changed-name' });
  await until(() => runtime.status(project).status === 'failed');
  assert.match(runtime.status(project).error, /no longer matches its record/);
  assert.equal(runtime.status(project, true).log, '');
});

test('startup diagnostics distinguish missing packages, Java mismatch, Docker, and occupied ports', () => {
  const project = { backend: 'spring', database: 'postgres' };
  assert.equal(startupDiagnostic(project, 'Fatal error compiling: error: release version 21 not supported'), 'java');
  assert.equal(startupDiagnostic(project, 'Cannot connect to the Docker daemon. Is the docker daemon running?'), 'docker');
  assert.equal(startupDiagnostic(project, 'Ports are not available: bind: address already in use\nDatabase startup failed'), 'port');
  assert.equal(startupDiagnostic(project, 'Database startup failed. Ensure Docker Desktop is running, then check .env and ports.'), 'database');
  assert.equal(startupDiagnostic({ ...project, backend: 'express' }, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' imported from server.js"), 'dependencies');
  assert.equal(startupDiagnostic(project, 'The frontend plugin printed a custom message.'), undefined);
});

test('service links appear only after their readiness checks pass and disappear on stop', async t => {
  const parent = await workspace(t);
  const project = await createProject(parent, 'readiness-app', 'setInterval(() => {}, 1000);', { backend: 'express' });
  let apiReady = false;
  const runtime = new ProjectRuntime({ probePort: async () => true, probeEndpoint: async url => !url.endsWith('/api/health') || apiReady });
  t.after(() => runtime.shutdown());
  runtime.start(project);
  await until(() => runtime.status(project).services?.frontend.ready);
  assert.equal(runtime.status(project).ready, false);
  assert.deepEqual(runtime.status(project).services.backend, { url: 'http://127.0.0.1:8080/api/health', ready: false });
  apiReady = true;
  await until(() => runtime.status(project).ready);
  runtime.stop(project);
  assert.equal(runtime.status(project).services, undefined);
  await until(() => runtime.status(project).status === 'stopped');
});

test('configured ports persist per project, reject collisions, and are passed to the managed launcher', async t => {
  const parent = await workspace(t);
  const project = { ...await createProject(parent, 'configured-app', "console.log(process.env.STACKFORGE_FRONTEND_PORT, process.env.STACKFORGE_BACKEND_PORT); setInterval(() => {}, 1000);", { backend: 'express' }), id: 'configured' };
  await writeFile(join(project.path, 'stackforge.json'), JSON.stringify({ generator: 'StackForge', options: project, portConfig: 1 }));
  const config = new ProjectConfig(join(parent, 'projects.json'));
  assert.throws(() => validatePorts(project, { frontend: 8080 }), /different port/);
  assert.throws(() => validatePorts(project, { backend: 80 }), /1024 to 65535/);
  await config.savePorts(project, validatePorts(project, { frontend: 15173, backend: 18080 }));
  const restored = new ProjectConfig(config.file);
  await restored.ready;
  assert.deepEqual(restored.ports({ ...project, id: 'different' }), {});
  const probed = [];
  const runtime = new ProjectRuntime({ probePort: async port => { probed.push(port); return true; }, probeEndpoint: async () => true });
  t.after(() => runtime.shutdown());
  runtime.start(project, restored.ports(project));
  await until(() => runtime.status(project, true).log.includes('15173 18080'));
  assert.deepEqual(probed, [15173, 18080]);
  assert.equal(runtime.status(project).services.frontend.url, 'http://127.0.0.1:15173/');
  assert.equal(runtime.status(project).services.backend.url, 'http://127.0.0.1:18080/api/health');
  await runtime.shutdown();
});

test('import registers a renamed StackForge folder without running it and survives restart', async t => {
  const parent = await workspace(t);
  const original = await createProject(parent, 'original-name', "console.log('imported script started'); setInterval(() => {}, 1000);");
  const path = join(parent, 'moved & renamed');
  await rename(original.path, path);
  const stateDir = join(parent, 'state', 'jobs');
  async function startServer() {
    const server = createApp({ stateDir, runtime: new ProjectRuntime({ probePort: async () => true, probeEndpoint: async () => true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = route => fetch(base + route).then(response => response.json());
    const { token } = await get('/api/state');
    const post = (route, data, origin) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token, ...(origin && { Origin: origin }) }, body: JSON.stringify(data) });
    const close = async () => { await server.shutdownTasks(); await new Promise(resolve => server.close(resolve)); };
    return { get, post, close };
  }
  let app = await startServer();
  t.after(() => app.close());
  assert.equal((await app.post('/api/projects/import', { path }, 'https://example.com')).status, 403);
  assert.equal((await app.post('/api/projects/import', { path: parent })).status, 400);
  const imported = await app.post('/api/projects/import', { path, command: 'ignored' });
  assert.equal(imported.status, 201);
  const { id } = await imported.json();
  assert.equal((await app.post('/api/projects/import', { path })).status, 400);
  const getProject = async () => (await app.get(`/api/projects?logs=${id}`)).projects[0];
  assert.equal((await getProject()).status, 'stopped');
  assert.equal((await getProject()).log, '');
  await app.close();
  app = await startServer();
  const restored = await getProject();
  assert.deepEqual([restored.id, restored.path, restored.name, restored.imported], [id, path, original.name, true]);
  assert.equal((await app.post(`/api/projects/${id}/start`, {})).status, 202);
  await until(async () => (await getProject()).log.includes('imported script started'));
  assert.equal((await app.post(`/api/projects/${id}/stop`, {})).status, 202);
  await until(async () => (await getProject()).status === 'stopped');
});

test('project API protects runtime and recycling actions, locks moves, and rediscovers restored projects', { timeout: 15000 }, async t => {
  const parent = await workspace(t);
  const project = await createProject(parent, 'recorded-app', "console.log('recorded launcher'); setInterval(() => {}, 1000);");
  const trash = join(parent, 'recycled');
  let allowMove, moveStarted;
  const moving = new Promise(resolve => { moveStarted = resolve; });
  const canMove = new Promise(resolve => { allowMove = resolve; });
  const desktop = { ...createDesktop(), async trashProject(path) { moveStarted(); await canMove; await rename(path, trash); } };
  const server = createApp({ stateDir: false, desktop, runtime: new ProjectRuntime({ probePort: async () => true }),
    check: async () => ({ canCreate: true }), generate: async () => ({ path: project.path, commands: [] }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { allowMove(); await server.shutdownTasks(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(base + path).then(response => response.json());
  const { token } = await get('/api/state');
  const post = (path, body = {}, headers = {}) => fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token, ...headers } });
  assert.equal((await fetch(base + '/projects')).status, 200);
  assert.deepEqual((await get('/api/projects')).projects, []);
  const created = await post('/api/projects', { ...project, parentDir: parent, git: false, install: false });
  assert.equal(created.status, 202);
  const { id } = await created.json();
  const listed = await until(async () => (await get('/api/projects')).projects[0]);
  assert.equal(listed.id, id);
  assert.equal(listed.path, project.path);
  const start = `/api/projects/${id}/start`, stop = `/api/projects/${id}/stop`, remove = `/api/projects/${id}/trash`;
  assert.equal((await post(start, {}, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post(stop, {}, { 'X-StackForge-Token': 'invalid' })).status, 403);
  assert.equal((await post('/api/projects/unknown/start')).status, 404);
  assert.equal((await post(start, { path: join(parent, 'spoofed'), command: 'ignored' })).status, 202);
  const detail = () => get(`/api/projects?logs=${id}`).then(data => data.projects[0]);
  await until(async () => (await detail()).log.includes('recorded launcher'));
  assert.equal((await get('/api/projects')).projects[0].log, undefined);
  assert.equal((await post(remove, { confirm: true })).status, 409);
  assert.equal((await post(stop)).status, 202);
  await until(async () => (await detail()).status === 'stopped');
  assert.equal((await post(remove, { confirm: true }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post(remove)).status, 400);
  const manifest = join(project.path, 'stackforge.json');
  const original = await readFile(manifest, 'utf8');
  await writeFile(manifest, '{}');
  assert.equal((await post(remove, { confirm: true })).status, 409);
  await writeFile(manifest, original);
  const removal = post(remove, { confirm: true, path: join(parent, 'spoofed') });
  assert.equal(await Promise.race([moving.then(() => true), removal.then(() => false)]), true);
  try {
    assert.equal((await detail()).deleting, true);
    assert.equal((await post(start)).status, 409);
    assert.equal((await post(remove, { confirm: true })).status, 409);
  } finally { allowMove(); }
  assert.equal((await removal).status, 200);
  assert.deepEqual((await get('/api/projects')).projects, []);
  assert.equal((await get(`/api/jobs/${id}`)).status, 'complete');
  assert.equal(await readFile(join(trash, 'stackforge.json'), 'utf8'), original);
  await rename(trash, project.path);
  assert.equal((await detail()).id, id);
});
