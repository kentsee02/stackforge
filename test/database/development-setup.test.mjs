import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { developmentOptions } from '../../src/database/development-setup.mjs';
import { developmentDatabase } from '../../src/database/docker/development-database.mjs';
import { discoverDatabases } from '../../src/database/discovery.mjs';
import { mysqlEnvironmentOption, saveMysqlEnvironment } from '../../src/database/environment.mjs';
import { resolveStartup } from '../../src/projects/project-startup.mjs';

test('development database choices keep engines and evidence scoped to each service', async t => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-development-options-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  const project = { id: 'fixture', path, unmanaged: true };
  await mkdir(join(path, 'services/orders/app'), { recursive: true });
  await mkdir(join(path, 'services/metrics/prisma'), { recursive: true });
  await mkdir(join(path, 'services/review'), { recursive: true });
  await writeFile(join(path, 'services/orders/app/database.py'), 'from sqlalchemy import create_engine\nengine = create_engine(f"mysql+pymysql://{user}@{host}/{database}")\n');
  const schema = join(path, 'services/metrics/prisma/schema.prisma');
  await writeFile(schema, 'datasource db { provider = "postgresql"\n url = env("TEST_DATABASE_URL") }');
  await writeFile(join(path, 'services/review/package.json'), '{"dependencies":{"pg":"^8.0.0"}}');
  const read = () => developmentOptions(project, ['postgres']);
  const { options } = await read();
  const orders = options.find(item => item.directory === 'services/orders');
  const metrics = options.find(item => item.directory === 'services/metrics');
  assert.equal(orders.engine, 'mysql');
  assert.equal(orders.status, 'detected');
  assert.equal(orders.canCreate, false);
  assert.equal(metrics.canCreate, true);
  assert.equal(options.find(item => item.directory === 'services/review').status, 'review');
  await writeFile(join(path, 'services/metrics/.env'), 'TEST_DATABASE_URL=mysql://user:fixture@127.0.0.1/test\n');
  const conflicting = (await read()).options.filter(item => item.directory === 'services/metrics');
  assert.ok(conflicting.every(item => item.status === 'conflict' && !item.canCreate));
  assert.notEqual(conflicting.find(item => item.engine === 'postgres').id, metrics.id);
  assert.doesNotMatch(JSON.stringify(conflicting), /user:fixture/);
});

test('MySQL settings follow the environment variables used by a package rather than fixed names', async t => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-mysql-fields-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, 'src/store/infra'), { recursive: true });
  await writeFile(join(path, 'pyproject.toml'), '[project]\ndependencies = ["sqlalchemy"]\n');
  const settings = join(path, 'src/store/infra/connection.py');
  const code = `import os
from dotenv import load_dotenv
from sqlalchemy import create_engine
load_dotenv()
server = os.environ.get("STORE_DATABASE_HOST")
number = os.getenv("STORE_DATABASE_PORT")
catalog = os.getenv("STORE_DATABASE_NAME")
account = os.getenv("STORE_DATABASE_USER")
secret = os.getenv("STORE_DATABASE_PASSWORD")
engine = create_engine(f"mysql+pymysql://{account}:{secret}@{server}:{number}/{catalog}")
`;
  await writeFile(settings, code);
  const project = { id: 'custom-fields', path, unmanaged: true };
  const { requirements } = await discoverDatabases(project);
  const discovered = requirements.find(item => item.source.endsWith('/connection.py'));
  assert.equal(discovered.directory, '.');
  const option = await mysqlEnvironmentOption(path, discovered);
  assert.equal(option.variable, 'STORE_DATABASE_HOST, STORE_DATABASE_PORT, STORE_DATABASE_NAME, STORE_DATABASE_USER, STORE_DATABASE_PASSWORD');
  const payload = { requirementId: option.id, revision: option.revision, host: '127.0.0.1', port: 53306, name: 'store', user: 'stackforge', password: 'fixture' };
  await writeFile(settings, code.replace('STORE_DATABASE_HOST', 'NEW_DATABASE_HOST'));
  await assert.rejects(saveMysqlEnvironment(project, payload), /changed/);
  await writeFile(settings, code);
  await assert.doesNotReject(saveMysqlEnvironment(project, payload));
  const after = await discoverDatabases(project);
  assert.equal(after.requirements.find(item => item.id === option.id).status, 'configured');
});

test('dedicated database previews report the reason Docker is unavailable', async t => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-development-engine-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  for (const [directory, url] of [
    ['metrics', 'postgresql://localhost:5432/metrics'],
    ['sales', 'mysql://localhost:3306/sales'],
    ['inventory', 'sqlserver://localhost:1433/inventory']
  ]) {
    await mkdir(join(path, directory));
    await writeFile(join(path, directory, '.env'), 'DATABASE_URL=' + url);
  }
  const project = { id: randomUUID(), path, imported: true, unmanaged: true };
  project.folderIdentity = (await resolveStartup(project, [])).identity;
  const originalContext = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_CONTEXT = 'stackforge-test-local';
  t.after(() => {
    if (originalContext === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = originalContext;
  });
  const localHost = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
  const registry = { ready: Promise.resolve(), value: { development: {} } };
  const healthy = JSON.stringify(['test-daemon', '28.1.0', 'linux']);
  const calls = [];
  let scenario = {};
  const development = developmentDatabase({ registry, probePort: async () => true, async command(program, args, { env }) {
    assert.equal(program, 'docker');
    calls.push(args[0]);
    if (args[0] === 'context') {
      assert.equal(args[1], 'inspect');
      assert.equal(args.at(-1), 'stackforge-test-local');
      if (scenario.contextError) throw scenario.contextError;
      return JSON.stringify(scenario.endpoint ?? localHost);
    }
    assert.equal(env.DOCKER_CONTEXT, undefined);
    assert.deepEqual(args.slice(0, 3), ['--host', localHost, 'info']);
    if (scenario.infoError) throw scenario.infoError;
    return scenario.info ?? healthy;
  } });
  const { options } = await development.inspect(project);
  assert.deepEqual(options.filter(item => item.canCreate).map(item => item.engine).sort(), ['mysql', 'postgres']);
  const pg = options.find(item => item.engine === 'postgres');
  const preview = option => development.action(project, { mode: 'preview', name: 'stackforge_test', port: 55432, targetId: option.id });
  for (const [failure, message] of [
    [{ infoError: new Error('failed to connect to the Docker API') },
      'Could not reach the local Docker Engine. Start Docker Desktop or the Docker Engine, then retry.'],
    [{ info: JSON.stringify(['test-daemon', '27.5.0', 'linux']) }, 'Update the local Docker Engine to version 28 or newer, then retry.'],
    [{ info: JSON.stringify(['test-daemon', '28.1.0', 'windows']) }, 'Switch Docker to Linux containers, then retry.'],
    [{ info: 'partial response' }, 'Could not verify the local Docker Engine. Check its status and retry.'],
    [{ contextError: new Error('spawn docker ENOENT') }, 'Docker CLI was not found. Install Docker Desktop or Docker Engine first.']
  ]) {
    scenario = failure;
    await assert.rejects(preview(pg), { message });
  }
  scenario = { endpoint: 'tcp://another-host:2376' };
  calls.length = 0;
  await assert.rejects(preview(pg), { message: 'Select a local Docker context to manage the development database.' });
  assert.deepEqual(calls, ['context']);
  if (process.platform === 'win32') {
    scenario = { endpoint: 'npipe:////./pipe/dockerDesktopWindowsEngine' };
    await assert.rejects(preview(pg), { message: 'Switch Docker to Linux containers, then retry.' });
  }
  scenario = {};
  for (const option of options.filter(item => item.canCreate)) {
    assert.equal((await preview(option)).engine, option.engine);
  }
});
