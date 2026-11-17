import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../src/http/server.mjs';
import { run } from '../../src/platform/process.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-development-postgres-')));
const path = join(root, 'portal');
const shared = join(root, 'another-project');
const stateDir = join(root, 'state', 'jobs');
const stateFile = join(root, 'state', 'databases.json');
const docker = (args, options = {}) => run('docker', args, { stdoutOnly: true, timeout: 60000, ...options });
let app, origin, token, listener, id, movedContainer;

async function startApp() {
  const missingHostClient = async () => { throw new Error('ENOENT'); };
  app = createApp({ stateDir, localDatabase: { command: missingHostClient }, databaseAdapters: { command: missingHostClient } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  origin = 'http://127.0.0.1:' + app.address().port;
  token = (await fetch(origin + '/api/state').then(result => result.json())).token;
}

async function stopApp() {
  if (!app) return;
  await app.shutdownTasks();
  await new Promise((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  app = undefined;
}

async function api(path, body, expected = 200, authorized = true) {
  const response = await fetch(origin + '/api/projects/' + path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': authorized ? token : '' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.status, expected, data.error);
  return data;
}

const definition = 'import "dotenv/config";\nexport default { datasource: { url: env("DATABASE_URL") } };\n';
try {
  await mkdir(join(path, 'prisma'), { recursive: true });
  await writeFile(join(path, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" }');
  await writeFile(join(path, 'prisma.config.ts'), definition);
  await writeFile(join(path, '.gitignore'), '.env\n');
  await run('git', ['init'], { cwd: path });
  await startApp();
  ({ id } = await api('import', { path }, 201));
  const endpoint = id + '/database-development';
  const read = () => api(endpoint);
  const action = (body, status) => api(endpoint, body, status);
  assert.equal((await read()).status, 'absent');
  listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  const options = { name: 'portal', port };
  await api(endpoint, { mode: 'preview', ...options }, 403, false);
  assert.match((await action({ mode: 'preview', ...options }, 409)).error, /free port/);
  await new Promise(resolve => listener.close(resolve));
  listener = undefined;
  const { plan } = await action({ mode: 'preview', ...options });
  assert.equal((await read()).status, 'absent');
  await action({ mode: 'create', plan, ...options, confirm: 'wrong' }, 409);
  await action({ mode: 'create', plan, ...options, confirm: 'portal' });
  let status;
  for (let i = 0; i < 30; i++) {
    status = await read();
    if (status.status === 'ready') break;
    await delay(1000);
  }
  assert.equal(status.status, 'ready');
  const { volume, connections } = status;
  const container = volume.slice(0, -'-data'.length);
  assert.equal(await docker(['port', container, '5432']).then(value => value.trim()), '127.0.0.1:' + port);
  assert.equal(connections[0].variable, 'DATABASE_URL');
  const { key, container: identity } = JSON.parse(await readFile(stateFile, 'utf8')).development[id];
  const query = statement => docker(['exec', identity, 'psql', '-XAtw', '-U', 'stackforge', '-d', 'portal', '-c', statement]);
  await query('CREATE TABLE proof (value integer); INSERT INTO proof VALUES (42)');
  const result = await action({ mode: 'save', requirementId: connections[0].id });
  assert.deepEqual(result, { saved: true, file: '.env' });
  const stored = await readFile(join(path, '.env'), 'utf8');
  const password = /stackforge:([a-f\d]{48})@/.exec(stored)?.[1];
  assert.ok(password);
  assert.equal(JSON.stringify(await read()).includes(password), false);
  assert.equal((await readFile(stateFile, 'utf8')).includes(password), false);
  const discovery = await api(id + '/database-discovery');
  const requirement = discovery.requirements.find(item => item.guidedSetup);
  const binding = discovery.bindings.find(item => item.requirementId === requirement.id);
  const local = () => api(id + '/database-local-check', { bindingId: binding.id }).then(result => result.installation);
  const prisma = () => api(id + '/database-postgres-setup', { mode: 'inspect', requirementId: requirement.id });
  assert.deepEqual(await local(), { kind: 'project-docker', serviceStatus: 'running', portOpen: true,
    clientVersion: (await docker(['exec', identity, 'psql', '--version'])).match(/\b17\.\d+\b/)[0] });
  const schema = await prisma();
  assert.equal(schema.status, 'migrations-unavailable');
  assert.equal(schema.tables, 1);
  assert.equal(JSON.stringify(schema).includes(password), false);

  const transferStatus = (status = 200) => api(id + '/database-local-status', { bindingId: binding.id }, status);
  const source = await transferStatus();
  assert.deepEqual(source.capabilities, { connect: true, backup: true, restore: false });
  assert.equal(source.restoreHint, 'Restore requires an empty database.');
  assert.equal(JSON.stringify(source).includes(password), false);
  const archive = (action = '', body = '{}', extra = {}) => fetch(origin + '/api/projects/' + id + '/database-archive' + action, {
    method: 'POST', headers: { 'X-StackForge-Token': token, 'X-StackForge-Binding': binding.id,
      'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream', ...extra }, body
  });
  const downloaded = await archive();
  assert.equal(downloaded.status, 200, downloaded.ok ? '' : await downloaded.text());
  const backup = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(backup.subarray(0, 16).toString(), 'STACKFORGE-DB-1\n');
  await query('DROP TABLE proof');
  assert.equal((await transferStatus()).restoreHint, 'Restore requires a non-superuser account with permission on the target database.');
  const restorePassword = randomBytes(24).toString('hex');
  await query(`CREATE ROLE restore_user LOGIN PASSWORD '${restorePassword}';
    GRANT CREATE ON SCHEMA public TO restore_user;
    GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO restore_user;`);
  await writeFile(join(path, '.env'), 'DATABASE_URL=postgresql://restore_user:' + restorePassword + '@127.0.0.1:' + port + '/portal\n');
  try {
    assert.equal((await transferStatus()).capabilities.restore, true);
    const previewResponse = await archive('/preview', backup);
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200, preview.error);
    const restoreResponse = await archive('/restore', backup, { 'X-StackForge-Preview': preview.id,
      'X-StackForge-Target': Buffer.from(preview.name).toString('base64') });
    assert.deepEqual(await restoreResponse.json(), { restored: true, objects: preview.objects, limited: false });
    assert.equal((await query('SELECT value FROM proof')).trim(), '42');
  } finally {
    await writeFile(join(path, '.env'), stored);
  }
  await action({ mode: 'delete', confirm: volume }, 409);
  assert.match((await api(id + '/remove', { confirmName: 'portal' }, 409)).error, /dedicated PostgreSQL volume/);
  await action({ mode: 'stop' });
  assert.equal((await read()).status, 'stopped');
  assert.deepEqual(await local(), { kind: 'project-docker', serviceStatus: 'stopped', portOpen: false });
  assert.equal((await prisma()).status, 'docker-stopped');
  assert.match((await transferStatus(409)).error, /Open Project PostgreSQL/);
  await stopApp();
  await startApp();
  assert.equal((await read()).status, 'stopped');
  await action({ mode: 'start' });
  for (let i = 0; i < 30 && (await read()).status !== 'ready'; i++) await delay(1000);
  assert.equal((await query('SELECT value FROM proof')).trim(), '42');
  await action({ mode: 'stop' });
  await mkdir(shared);
  await writeFile(join(shared, '.env'), 'DATABASE_URL=postgresql://user:password@127.0.0.1:' + port + '/other_database\n');
  const other = await api('import', { path: shared }, 201);
  assert.match((await action({ mode: 'delete', confirm: volume }, 409)).error, /Another project/);
  await api(other.id + '/remove', { confirmName: other.name });
  await action({ mode: 'delete', confirm: 'wrong' }, 409);

  movedContainer = container + '-fixture-original';
  await docker(['container', 'rename', identity, movedContainer]);
  let replacement;
  try {
    replacement = (await docker(['container', 'create', '--name', container, '--label', 'stackforge.integration=' + key,
      'docker.io/library/postgres:17'])).trim();
    assert.match((await transferStatus(409)).error, /could not be verified/);
    assert.match((await action({ mode: 'delete', confirm: volume }, 409)).error, /could not be verified/);
    await docker(['container', 'inspect', replacement]);
  } finally {
    if (replacement) await docker(['container', 'rm', '-v', replacement]);
    await docker(['container', 'rename', identity, container]);
    movedContainer = undefined;
  }
  await action({ mode: 'delete', confirm: volume });
  assert.equal((await read()).status, 'absent');
  await assert.rejects(docker(['volume', 'inspect', volume]), /no such volume/i);
  assert.ok((await readFile(join(path, '.env'), 'utf8')).includes(password));

  const nextPlan = await action({ mode: 'preview', ...options });
  await action({ mode: 'create', plan: nextPlan.plan, ...options, confirm: 'portal' });
  await action({ mode: 'stop' });
  const second = JSON.parse(await readFile(stateFile, 'utf8')).development[id];
  const secondVolume = 'stackforge-pg-' + second.key + '-data';
  await docker(['container', 'rm', second.container]);
  await docker(['volume', 'rm', secondVolume]);
  await docker(['volume', 'create', '--label', 'stackforge.integration=' + second.key, secondVolume]);
  try {
    assert.match((await action({ mode: 'delete', confirm: secondVolume }, 409)).error, /could not be verified/);
    await docker(['volume', 'inspect', secondVolume]);
  } finally { await docker(['volume', 'rm', secondVolume]); }
  await action({ mode: 'delete', confirm: secondVolume });
  await api(id + '/remove', { confirmName: 'portal' });
  console.log('Verified dedicated PostgreSQL, including local connection checks, backup and scoped restore without host clients.');
} finally {
  if (listener) await new Promise(resolve => listener.close(resolve));
  await stopApp();
  const record = await readFile(stateFile, 'utf8').then(text => JSON.parse(text).development[id], () => undefined);
  if (record && /^[a-f\d]{32}$/.test(record.key)) {
    const name = 'stackforge-pg-' + record.key;
    for (const container of [name, movedContainer].filter(Boolean)) {
      const owner = await docker(['container', 'inspect', '--format', '{{index .Config.Labels "io.stackforge.development-postgres"}}', container]).catch(() => '');
      if (owner.trim() === record.key) await docker(['container', 'rm', '-f', container]);
    }
    const volume = name + '-data';
    const owner = await docker(['volume', 'inspect', '--format', '{{index .Labels "io.stackforge.development-postgres"}}', volume]).catch(() => '');
    if (owner.trim() === record.key) await docker(['volume', 'rm', volume]);
  }
  await rm(root, { recursive: true, force: true });
}
