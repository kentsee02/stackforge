import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { databaseVault } from '../../src/database/security/vault.mjs';
import { createApp } from '../../src/http/server.mjs';
import { run } from '../../src/platform/process.mjs';

assert.equal(process.platform, 'linux', 'This integration test uses GNOME Keyring on Linux.');
const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-secret-service-')));
const runtime = join(root, 'runtime');
const socket = 'unix:path=' + join(runtime, 'bus');
const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: socket, XDG_RUNTIME_DIR: runtime,
  XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config') };
for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'GNOME_KEYRING_CONTROL', 'GNOME_KEYRING_PID']) delete env[name];

const shell = (program, args, options = {}) => run(program, args, { stdoutOnly: true, timeout: 10000, env, ...options });
const daemons = [];
let app;

function startDaemon(program, args, options = {}) {
  const controller = new AbortController();
  let failure;
  const task = shell(program, args, { ...options, timeout: 0, signal: controller.signal })
    .then(() => { failure = new Error(program + ' exited before the test finished.'); }, error => { failure = error; });
  const daemon = {
    check() { if (failure) throw failure; },
    async stop() { controller.abort(); await task; }
  };
  daemons.push(daemon);
  return daemon;
}

async function waitFor(verify, ensureRunning) {
  for (let attempt = 0; attempt < 60; attempt++) {
    ensureRunning();
    if (await verify().catch(() => false)) return;
    await delay(100);
  }
  assert.fail('The isolated D-Bus or Secret Service did not become ready.');
}

const service = '/org/freedesktop/secrets';
const busCall = (destination, path, method, ...args) => shell('gdbus',
  ['call', '--session', '--dest', destination, '--object-path', path, '--method', method, ...args], { timeout: 1500 });
const dbus = (...args) => busCall('org.freedesktop.DBus', '/org/freedesktop/DBus', ...args);
const keyring = (path, method, ...args) => busCall('org.freedesktop.secrets', path, method, ...args);
const keyringInput = { input: Buffer.from(randomUUID()) };
const startKeyring = control => startDaemon('gnome-keyring-daemon',
  ['--foreground', '--unlock', '--components=secrets', '--control-directory=' + join(runtime, control)], keyringInput);
const hasKeyring = async () => (await dbus('org.freedesktop.DBus.NameHasOwner', 'org.freedesktop.secrets')).trim() === '(true,)';
const unavailable = 'The operating system credential store is unavailable.';

try {
  await mkdir(runtime, { mode: 0o700 });
  const bus = startDaemon('dbus-daemon', ['--session', '--nofork', '--address=' + socket]);
  await waitFor(async () => Boolean(await dbus('org.freedesktop.DBus.ListNames')), bus.check);
  const firstKeyring = startKeyring('keyring');
  await waitFor(hasKeyring, firstKeyring.check);
  const alias = await keyring(service, 'org.freedesktop.Secret.Service.ReadAlias', 'default');
  const collection = /\/org\/freedesktop\/secrets\/collection\/\w+/.exec(alias)?.[0];
  assert.ok(collection, 'The isolated keyring has a default collection.');
  const lockState = () => keyring(collection, 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Locked');
  assert.match(await lockState(), /<false>/);

  const project = join(root, 'portal');
  const stateDir = join(root, 'state', 'jobs');
  const catalog = join(dirname(stateDir), 'databases.json');
  const ca = join(root, 'test-ca.pem');
  const password = 'StackForge test ' + randomUUID() + ' #$';
  await mkdir(project);
  await writeFile(join(project, '.env'), 'DATABASE_URL=postgresql://operator@db.example.net:5432/app');
  await writeFile(ca, 'opaque fixture CA');
  const vaultDir = join(root, 'credentials');
  const vault = databaseVault(vaultDir, { command: shell });
  // The SQL probe is a fixture. All keyring calls use the real Secret Service.
  const command = async (program, args, options) => {
    assert.equal(program, 'psql');
    assert.equal(options.env.PGPASSWORD === password, true);
    assert.equal(args.includes(password), false);
    return '17.4\tapp\tt\tt\tt\t123456789\tf\tt\tt\t16384\n';
  };
  app = createApp({ stateDir, databaseAdapters: { vault, command } }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = 'http://127.0.0.1:' + app.address().port;
  const { token } = await (await fetch(origin + '/api/state')).json();
  async function request(path, payload) {
    const response = await fetch(origin + path, payload === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    assert.equal(JSON.stringify(data).includes(password), false);
    return { status: response.status, data };
  }
  const registration = await request('/api/projects/import', { path: project });
  assert.equal(registration.status, 201);
  const route = '/api/projects/' + registration.data.id;
  const { data: { bindings: [binding] } } = await request(route + '/database-discovery');
  const profile = (mode, fields) => request(route + '/database-remote-profile', { bindingId: binding.id, mode, ...fields });
  assert.equal((await profile('save', { user: 'operator', password, ca })).status, 200);
  async function recordedProfile() {
    const stored = await readFile(catalog, 'utf8');
    assert.equal(stored.includes(password), false);
    return Object.values(JSON.parse(stored).profiles)[0];
  }
  const ref = (await recordedProfile()).credentialRef;
  assert.match(ref, /^[a-f0-9-]{36}$/);
  assert.equal((await profile('test')).status, 200);
  const offlineEnv = { ...env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(runtime, 'absent-bus') };
  const offline = databaseVault(vaultDir, { command: (program, args, options) => shell(program, args, { ...options, env: offlineEnv }) });
  await assert.rejects(offline.read(ref), { message: unavailable });

  await keyring(service, 'org.freedesktop.Secret.Service.Lock', "['" + collection + "']");
  assert.match(await lockState(), /<true>/);
  assert.deepEqual(await profile('test'), { status: 409, data: { error: unavailable } });
  assert.deepEqual(await profile('remove'), { status: 409, data: { error: unavailable } });
  assert.equal((await recordedProfile()).credentialRef, ref);

  await firstKeyring.stop();
  const reopened = startKeyring('reopened-keyring');
  await waitFor(async () => await hasKeyring() && /<false>/.test(await lockState()), reopened.check);
  assert.equal((await profile('test')).status, 200);
  assert.deepEqual(await profile('remove'), { status: 200, data: { saved: false } });
  assert.equal(await recordedProfile(), undefined);
  await assert.rejects(vault.read(ref), { message: unavailable });

  console.log('Verified Linux Secret Service profile persistence, lookup, locked and unavailable keyrings, and removal.');
} finally {
  try {
    if (app) {
      await app.shutdownTasks();
      await new Promise(resolve => app.close(resolve));
    }
  } finally {
    for (const daemon of daemons.reverse()) await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
}
