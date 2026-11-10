import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { cp, mkdtemp, mkdir, writeFile, rm, rename, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { ProjectRuntime, startupDiagnostic } from '../src/project-runtime.mjs';
import { createApp } from '../src/server.mjs';
import { createDesktop } from '../src/desktop.mjs';
import { ProjectConfig, validatePorts } from '../src/project-config.mjs';
import { ProjectOperations } from '../src/project-operations.mjs';
import { generateProject } from '../src/generator.mjs';

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

test('generated and imported managed projects reject a replacement folder with a copied manifest', { timeout: 15000 }, async t => {
  const parentDir = await workspace(t);
  let recycled = 0;
  const desktop = { ...createDesktop(), trashProject: async path => { recycled++; await rename(path, path + '-recycled'); } };
  const options = { stateDir: join(parentDir, 'jobs'), desktop, check: async () => ({ canCreate: true }),
    generate: (options, report, services) => generateProject(options, report, {
      ...services, fetchImpl: async () => new Response('{"version":"1.2.3"}')
    }) };
  let app, url, token;
  const open = async () => {
    app = createApp(options);
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${app.address().port}`;
    ({ token } = await (await fetch(url + '/api/state')).json());
  };
  const close = async () => { await app.shutdownTasks(); await new Promise(resolve => app.close(resolve)); };
  await open();
  t.after(close);
  const post = (route, body) => fetch(url + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body) });
  const creation = await post('/api/projects', { name: 'generated-project', parentDir, frontend: 'vue', backend: 'none', database: 'none', install: false, git: false });
  assert.equal(creation.status, 202);
  const { id } = await creation.json();
  const generated = await until(async () => {
    const job = await (await fetch(url + '/api/jobs/' + id)).json();
    return job.status === 'complete' && { ...job.result, id };
  });
  const local = await createProject(parentDir, 'imported-project', '');
  const imported = await post('/api/projects/import', { path: local.path });
  assert.equal(imported.status, 201);
  await close();
  await open();
  for (const { id, path, name } of [generated, await imported.json()]) {
    const original = path + '-original';
    await rename(path, original);
    await cp(original, path, { recursive: true });
    const trash = () => post(`/api/projects/${id}/trash`, { confirmName: name });
    const refused = await trash();
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /no longer matches its record/);
    await rename(path, path + '-replacement');
    await rename(original, path);
    assert.equal((await trash()).status, 200);
  }
  assert.equal(recycled, 2);
});

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
  const imported = { unmanaged: true, backend: 'none', database: 'none', frameworks: ['Spring Boot'] };
  assert.equal(startupDiagnostic(imported, 'Error: JAVA_HOME is set to an invalid directory: local/jdk'), 'java');
  assert.equal(startupDiagnostic(imported, 'No compiler is provided in this environment. Perhaps you are running on a JRE rather than a JDK?'), 'java');
  assert.equal(startupDiagnostic(imported, 'PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.'), 'databaseUrl');
  assert.equal(startupDiagnostic(imported, 'Error: P1001: Can\'t reach database server'), 'databaseConnection');
  assert.equal(startupDiagnostic(imported, 'NETSDK1045: The current .NET SDK does not support this target.'), 'dotnetSdk');
  assert.equal(startupDiagnostic(imported, 'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile'), 'lockfile');
  assert.equal(startupDiagnostic(imported, 'python.exe: No module named uvicorn'), 'pythonDependencies');
  assert.equal(startupDiagnostic(imported, '无法执行 dotnet：spawn dotnet ENOENT'), 'toolMissing');
  assert.equal(startupDiagnostic(imported, 'Configuration includes a DATABASE_URL setting.'), undefined);
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
  assert.equal((await app.post('/api/projects/import', { path: join(parent, 'missing') })).status, 400);
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
  assert.deepEqual([restored.id, restored.path, restored.name, restored.imported], [id, await realpath(path), original.name, true]);
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
  const confirmation = { confirmName: project.name };
  assert.equal((await post(start, {}, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post(stop, {}, { 'X-StackForge-Token': 'invalid' })).status, 403);
  assert.equal((await post('/api/projects/unknown/start')).status, 404);
  assert.equal((await post(start, { path: join(parent, 'spoofed'), command: 'ignored' })).status, 202);
  const detail = () => get(`/api/projects?logs=${id}`).then(data => data.projects[0]);
  await until(async () => (await detail()).log.includes('recorded launcher'));
  assert.equal((await get('/api/projects')).projects[0].log, undefined);
  assert.equal((await post(remove, confirmation)).status, 409);
  assert.equal((await post(stop)).status, 202);
  await until(async () => (await detail()).status === 'stopped');
  assert.equal((await post(remove, confirmation, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post(remove)).status, 400);
  assert.equal((await post(remove, { confirm: true })).status, 400);
  assert.equal((await post(remove, { confirmName: project.name.toUpperCase() })).status, 400);
  assert.equal((await post(remove, { confirmName: project.name + ' ' })).status, 400);
  const manifest = join(project.path, 'stackforge.json');
  const original = await readFile(manifest, 'utf8');
  await writeFile(manifest, '{}');
  assert.equal((await post(remove, confirmation)).status, 409);
  await writeFile(manifest, original);
  const removal = post(remove, { ...confirmation, path: join(parent, 'spoofed') });
  assert.equal(await Promise.race([moving.then(() => true), removal.then(() => false)]), true);
  try {
    assert.equal((await detail()).deleting, true);
    assert.equal((await post(start)).status, 409);
    assert.equal((await post(remove, confirmation)).status, 409);
  } finally { allowMove(); }
  assert.equal((await removal).status, 200);
  assert.deepEqual((await get('/api/projects')).projects, []);
  assert.equal((await get(`/api/jobs/${id}`)).status, 'complete');
  assert.equal(await readFile(join(trash, 'stackforge.json'), 'utf8'), original);
  await rename(trash, project.path);
  assert.equal((await detail()).id, id);
});

test('project operations cancel and retry installation, manage the configured database, and reject foreign containers', { timeout: 15000 }, async t => {
  const parent = await workspace(t);
  const project = await createProject(parent, 'operations-app', '', { backend: 'spring', database: 'postgres' });
  const directory = await realpath(project.path);
  await mkdir(join(directory, 'backend'));
  await Promise.all([
    writeFile(join(directory, 'stackforge.json'), JSON.stringify({ generator: 'StackForge', portConfig: 1, options: project })),
    writeFile(join(directory, 'package.json'), '{}'),
    writeFile(join(directory, 'compose.yaml'), 'services: {}'),
    writeFile(join(directory, '.env'), 'DB_PORT=5432\n'),
    writeFile(join(directory, 'backend', process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'), '')
  ]);
  let attempts = 0;
  let owner = directory;
  let container = '';
  let mavenFolder;
  let sqlReady = false;
  let minimumDockerProbeTime = 0;
  const databaseWrites = [];
  const operations = new ProjectOperations({
    install: async (args, { log, signal }) => {
      assert.equal(args[0], 'install');
      log('npm output\n');
      if (++attempts === 1) await sleep(5000, undefined, { signal });
    },
    command: async (command, args, config) => {
      if (command !== 'docker') {
        mavenFolder = config.cwd;
        assert.match(args.join(' '), /dependency:go-offline/);
        config.log('Maven output\n');
        return;
      }
      assert.equal(config.env.DB_PORT, '15432');
      if ((args[0] === 'inspect' || args[1] === 'ps') && config.timeout < minimumDockerProbeTime) throw new Error('Docker status probe timed out.');
      if (args[0] === 'inspect') return `${JSON.stringify(owner)}\tdb\t${container}\thealthy\n`;
      if (args[0] === 'exec') return sqlReady ? '1' : '';
      if (args[1] === 'ps') return container ? 'abcdef123456\n' : '';
      if (args[1] === 'logs') { config.log('ready to accept connections\n'); return; }
      databaseWrites.push(args);
      container = args[1] === 'up' ? 'running' : 'exited';
    }
  });
  const server = createApp({ stateDir: false, operations });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await server.shutdownTasks(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async route => (await fetch(base + route)).json();
  const { token } = await get('/api/state');
  const post = (route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body) });
  const imported = await post('/api/projects/import', { path: directory });
  assert.equal(imported.status, 201);
  const { id } = await imported.json();
  const route = `/api/projects/${id}`;
  const detail = async () => (await get(`/api/projects?logs=${id}`)).projects[0];
  assert.equal((await post(`${route}/ports`, { ports: { database: 15432 } })).status, 200);
  assert.equal((await post(`${route}/install`)).status, 202);
  await until(() => attempts === 1);
  assert.equal((await post(`${route}/start`)).status, 409);
  assert.equal((await post(`${route}/install-cancel`)).status, 202);
  await until(async () => (await detail()).dependencies.status === 'cancelled');
  assert.equal((await post(`${route}/install`)).status, 202);
  await until(async () => (await detail()).dependencies.status === 'succeeded');
  assert.equal(mavenFolder, join(directory, 'backend'));
  assert.match((await detail()).dependencies.log, /npm output\nMaven output/);

  assert.equal((await get(`${route}/database`)).status, 'absent');
  minimumDockerProbeTime = 4000;
  assert.equal((await post(`${route}/database-start`)).status, 202);
  const started = await until(async () => {
    const { databaseTask } = await detail();
    return databaseTask.status !== 'running' && databaseTask;
  });
  assert.equal(started.status, 'succeeded', started.error);
  assert.equal((await get(`${route}/database`)).status, 'starting');
  sqlReady = true;
  assert.deepEqual(await get(`${route}/database?logs=1`), { status: 'running', log: 'ready to accept connections\n' });
  owner = parent;
  assert.equal((await post(`${route}/database-stop`)).status, 202);
  await until(async () => (await detail()).databaseTask.status === 'failed');
  assert.match((await detail()).databaseTask.error, /another project folder/);
  assert.equal(databaseWrites.length, 1);
  owner = directory;
  assert.equal((await post(`${route}/database-stop`)).status, 202);
  await until(async () => (await detail()).databaseTask.status === 'succeeded');
  assert.equal((await get(`${route}/database`)).status, 'stopped');
  assert.deepEqual(databaseWrites, [['compose', 'up', '-d', '--wait', '--no-deps', 'db'], ['compose', 'stop', 'db']]);
});

test('recycling a project preserves its volume and database deletion separately verifies the stopped target', async t => {
  const parent = await workspace(t);
  const project = await createProject(parent, 'database-app', '', { backend: 'express', database: 'postgres' });
  const directory = await realpath(project.path);
  const databaseId = '1234567890abcdef12345678';
  const name = 'database-app_db_data';
  const target = '/var/lib/postgresql/data';
  const containerId = 'a'.repeat(64);
  const manifestPath = join(directory, 'stackforge.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.createdAt = '2026-01-02T00:00:00.001Z';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const model = { name: project.name, services: { db: { volumes: [{ type: 'volume', source: 'db_data', target }] } }, volumes: { db_data: { name } } };
  await writeFile(join(directory, 'compose.yaml'), '');
  let attached = false, volumeExists = true, shared = false, rejectRecycle = true, containerStatus = 'exited';
  let volumeCreated = '2026-01-02T00:00:00Z';
  let dockerCalls = 0;
  const writes = [];
  const operations = new ProjectOperations({ command: async (_, args) => {
    dockerCalls++;
    const [resource, action] = args;
    if (resource === 'compose' && action === 'config') return JSON.stringify(model);
    if (resource === 'compose' && action === 'ps') return attached ? containerId : '';
    if (resource === 'inspect') return `${JSON.stringify(directory)}\tdb\t${containerStatus}\t\t${JSON.stringify([{ Type: 'volume', Name: name, Destination: target, RW: true }])}`;
    if (resource === 'volume' && action === 'ls') return volumeExists ? name : '';
    if (resource === 'volume' && action === 'inspect') {
      const labels = { 'com.docker.compose.project': project.name, 'com.docker.compose.volume': 'db_data', 'io.stackforge.database-id': manifest.databaseId };
      return `${JSON.stringify(volumeCreated)}\t${JSON.stringify(labels)}\t"local"\tnull`;
    }
    if (resource === 'ps') return [attached && containerId, shared && 'b'.repeat(64)].filter(Boolean).join('\n');
    writes.push(args);
    if (resource === 'container') attached = false;
    if (resource === 'volume') volumeExists = false;
    return '';
  } });
  const desktop = { ...createDesktop(), async trashProject(path) {
    assert.equal(path, directory);
    if (rejectRecycle) throw new Error('Recycle failed');
    await rename(path, join(parent, 'recycled'));
  } };
  const server = createApp({ stateDir: false, operations, desktop });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await server.shutdownTasks(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(base + '/api/state').then(response => response.json());
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body) });
  const { id } = await post('/api/projects/import', { path: directory }).then(response => response.json());
  const route = `/api/projects/${id}`;
  const remove = () => post(route + '/trash', { confirmName: project.name });
  const preview = () => fetch(base + route + '/database-delete');
  const deleteVolume = async confirmVolume => {
    assert.equal((await post(route + '/database-delete', { confirmVolume })).status, 202);
    return until(async () => {
      const { projects } = await fetch(base + '/api/projects?logs=' + id).then(response => response.json());
      const task = projects[0].databaseTask;
      return ['failed', 'succeeded'].includes(task?.status) && task;
    });
  };
  const conflict = async pattern => {
    const response = await preview();
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, pattern);
  };
  await conflict(/could not be verified/);
  attached = true;
  volumeCreated = '2026-01-01T00:00:00Z';
  await conflict(/could not be verified/);
  volumeCreated = '2026-01-02T00:00:00Z';
  attached = shared = true;
  await conflict(/shared with another container/);
  model.volumes.db_data.external = true;
  await conflict(/dedicated, Compose-managed/);
  delete model.volumes.db_data.external;
  shared = false;
  assert.deepEqual(await (await preview()).json(), { volume: name });
  assert.equal((await post(route + '/database-delete', {})).status, 400);
  assert.match((await deleteVolume('wrong-volume')).error, /exact volume name/);
  containerStatus = 'running';
  assert.match((await deleteVolume(name)).error, /Stop the database/);
  containerStatus = 'exited';
  shared = true;
  assert.match((await deleteVolume(name)).error, /shared with another container/);
  shared = false;
  assert.deepEqual(writes, []);

  const beforeRecycle = dockerCalls;
  const failedRecycle = await remove();
  assert.equal(failedRecycle.status, 409);
  assert.match((await failedRecycle.json()).error, /Recycle failed/);
  assert.ok(await readFile(manifestPath, 'utf8'));

  rejectRecycle = false;
  const retried = await remove();
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { trashed: true, databaseDeleted: false });
  assert.equal(dockerCalls, beforeRecycle);
  assert.equal(volumeExists, true);
  await rename(join(parent, 'recycled'), directory);
  assert.equal((await deleteVolume(name)).status, 'succeeded');
  assert.deepEqual(writes, [['container', 'rm', containerId], ['volume', 'rm', name]]);
  assert.ok(await readFile(manifestPath, 'utf8'));
  await conflict(/no project database volume/);

  manifest.databaseId = databaseId;
  await writeFile(manifestPath, JSON.stringify(manifest));
  volumeExists = true;
  assert.equal((await deleteVolume(name)).status, 'succeeded');
  assert.deepEqual(writes.slice(2), [['volume', 'rm', name]]);
});
