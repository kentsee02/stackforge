import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { developmentOptions } from '../../src/database/development-setup.mjs';
import { discoverDatabases } from '../../src/database/discovery.mjs';
import { mysqlEnvironmentOption, saveMysqlEnvironment } from '../../src/database/environment.mjs';

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
