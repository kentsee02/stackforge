import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { archiveBackup, inspectArchive } from '../../src/database/backup/archive.mjs';
import { databaseInventory, databaseReady, transferDatabase } from '../../src/database/backup/docker-transfer.mjs';
import { verifySqlRestore } from '../../src/database/backup/restore-check.mjs';
import { executeInitialization, initializationPlan } from '../../src/database/initialization.mjs';
import { localSession } from '../../src/database/adapters/local.mjs';
import { remoteSession } from '../../src/database/adapters/remote.mjs';
import { localTransferSession } from '../../src/database/adapters/local-transfer.mjs';
import { discoverDatabases } from '../../src/database/discovery.mjs';
import { databaseResource } from '../../src/database/registry.mjs';
import { ProjectOperations } from '../../src/projects/project-operations.mjs';
import { directoryIdentity } from '../../src/platform/project-identity.mjs';
import { databaseResources } from '../../src/database/resources.mjs';
import { DatabaseRegistry } from '../../src/database/registry.mjs';
import { run } from '../../src/platform/process.mjs';

const fixtures = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-integration-')));
const token = randomBytes(10).toString('hex');
const docker = (args, options = {}) => run('docker', args, { stdoutOnly: true, timeout: 90000, ...options });
const containers = [];
const composeFixtures = [];

async function certificate() {
  const openssl = process.platform === 'win32' ? process.env.STACKFORGE_TEST_OPENSSL ?? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
  await run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(fixtures, 'sf-key.pem'), '-out', join(fixtures, 'sf-cert.pem')]);
}

async function start(engine, name) {
  const pg = engine === 'postgres';
  const image = pg ? 'postgres:17' : 'mysql:8.4';
  const mount = pg ? '/var/lib/postgresql/data' : '/var/lib/mysql';
  const tcp = pg ? 5432 : 3306;
  const password = randomBytes(14).toString('hex');
  const configureTls = pg ? 'chown postgres /tmp/sf-key.pem; chmod 600 /tmp/sf-key.pem;' : 'chown mysql /tmp/sf-key.pem; chmod 600 /tmp/sf-key.pem;';
  const tlsArgs = pg ? ['postgres', '-c', 'ssl=on', '-c', 'ssl_cert_file=/tmp/sf-cert.pem', '-c', 'ssl_key_file=/tmp/sf-key.pem'] :
    ['mysqld', '--ssl-ca=/tmp/sf-cert.pem', '--ssl-cert=/tmp/sf-cert.pem', '--ssl-key=/tmp/sf-key.pem', '--log-bin-trust-function-creators=ON'];
  const id = (await docker(['create', '--pull=never', '--label', 'io.stackforge.integration=' + token,
    '--name', 'stackforge-integration-' + token + '-' + name,
    '--mount', 'type=tmpfs,destination=' + mount, '--network', 'none', '--entrypoint', 'sh',
    ...(pg ? ['-e', 'POSTGRES_DB=app', '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD=' + password] :
      ['-e', 'MYSQL_DATABASE=app', '-e', 'MYSQL_USER=operator', '-e', 'MYSQL_PASSWORD=' + password, '-e', 'MYSQL_ROOT_PASSWORD=' + password]),
    image, '-ec', `${configureTls} chmod 644 /tmp/sf-cert.pem; exec docker-entrypoint.sh "$@"`, 'stackforge', ...tlsArgs])).trim();
  assert.match(id, /^[a-f0-9]{64}$/);
  containers.push(id);
  for (const file of ['sf-key.pem', 'sf-cert.pem']) await docker(['cp', join(fixtures, file), id + ':/tmp/' + file]);
  await docker(['start', id]);
  const options = { engine, container: id, command: run, config: {}, project: name };
  for (let attempt = 0; !await databaseReady(options); attempt++) {
    if (attempt > 100) throw new Error('Test database did not become ready.');
    await delay(500);
  }
  const exec = (program, args, options = {}) => {
    const env = Object.entries(options.env ?? {}).filter(([key]) => /^(?:PGPASSWORD|PGCONNECT_TIMEOUT|PGOPTIONS|PGSSLMODE|PGSSLROOTCERT|PGGSSENCMODE|MYSQL_PWD)$/.test(key));
    return docker(['exec', ...(options.input ? ['-i'] : []), ...env.flatMap(([key, value]) => ['-e', key + '=' + value]), id, program, ...args],
      { ...options, env: process.env });
  };
  const credentials = { user: pg ? 'operator' : 'root', password };
  const target = { engine, host: '127.0.0.1', port: tcp, name: pg ? 'isolated-db' : 'isolated' };
  return { options, exec, credentials, target };
}

async function initialize(session, engine) {
  const path = join(fixtures, engine);
  await mkdir(join(path, 'database', 'migrations'), { recursive: true });
  await writeFile(join(path, 'database', 'migrations', '001.sql'), 'CREATE TABLE items (id INT PRIMARY KEY, amount DECIMAL(10, 2));');
  const context = { project: { id: 'integration-' + engine, path }, binding: { instanceId: 'integration-' + engine },
    target: session.target, credentials: session.credentials, command: session.exec, schema: true,
    recordMigration: async () => {}, revalidate: async () => {} };
  const plan = await initializationPlan(context);
  assert.deepEqual(plan.steps, ['create', 'schema']);
  assert.deepEqual(await executeInitialization({ ...context, id: plan.id, confirmName: session.target.name }), { initialized: true, schema: 'verified' });
  assert.deepEqual((await initializationPlan(context)).steps, []);
}

async function remoteRoundTrip(engine) {
  const fixture = await start(engine, engine);
  await initialize(fixture, engine);
  const session = localSession(fixture.target, fixture.credentials, fixture.exec);
  const pg = engine === 'postgres';
  await session.query('CREATE TABLE notes (id INT PRIMARY KEY); INSERT INTO notes VALUES (41);', 'app');
  await session.query(pg ? `CREATE FUNCTION answer() RETURNS integer LANGUAGE SQL AS 'SELECT 42';` :
    `CREATE FUNCTION answer() RETURNS INT DETERMINISTIC RETURN 42;
     CREATE PROCEDURE read_notes() SELECT id FROM notes;
     CREATE TRIGGER before_notes BEFORE INSERT ON notes FOR EACH ROW SET @last_id = NEW.id;
     CREATE EVENT disabled_event ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1;`, 'app');
  const original = await databaseInventory(fixture.options);
  const dump = await transferDatabase(fixture.options);
  const { data } = archiveBackup({ data: dump.data, engine, version: original.version, project: engine });
  const verified = await verifySqlRestore({ engine, version: original.version, data: inspectArchive(data, engine, original.version).data });
  assert.deepEqual(verified.objects, original.objects);
  await assert.rejects(transferDatabase({ ...fixture.options, file: dump.data }), /requires an empty database/);
  assert.equal(await session.query('SELECT id FROM notes;', 'app'), '41');
  const legacy = await verifySqlRestore({ engine, version: original.version, data: dump.data, legacy: true });
  assert.equal(legacy.legacyMetadata.version, original.version);
  const password = randomBytes(18).toString('hex');
  await session.query(pg ? `CREATE ROLE limited LOGIN PASSWORD '${password}'; GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO limited;
    GRANT CREATE ON SCHEMA public TO limited;` : `CREATE USER 'limited'@'%' IDENTIFIED BY '${password}' REQUIRE SSL;
    GRANT ALL PRIVILEGES ON isolated.* TO 'limited'@'%';`, fixture.target.name);
  await session.query('DROP TABLE items;', fixture.target.name);
  const profile = { ...fixture.target, host: 'localhost', user: 'limited', ca: '/tmp/sf-cert.pem' };
  const remote = remoteSession(profile, password, { command: fixture.exec });
  const info = await remote.test();
  assert.equal(info.capabilities.restore, true);
  assert.deepEqual(info.providerPermissions, { start: false, stop: false, delete: false });
  await assert.rejects(remoteSession({ ...profile, host: '127.0.0.1' }, password, { command: fixture.exec }).test(), /remote database operation failed/);
  await remote.restore(dump.data, info.identity);
  assert.deepEqual((await remote.inventory()).objects, original.objects);
  assert.equal(await session.query('SELECT id FROM notes;', fixture.target.name), '41');
  assert.equal(await session.query('SELECT answer();', fixture.target.name), '42');
  assert.equal((await remote.test()).capabilities.restore, false);
  let backupAccount = remote;
  if (!pg) {
    assert.equal((await remote.test()).capabilities.backup, false);
    await session.query(`CREATE USER 'backup_reader'@'%' IDENTIFIED BY '${password}' REQUIRE SSL;
      GRANT SELECT ON *.* TO 'backup_reader'@'%';
      GRANT SHOW VIEW, TRIGGER, EVENT ON isolated.* TO 'backup_reader'@'%';`, 'isolated');
    backupAccount = remoteSession({ ...profile, user: 'backup_reader' }, password, { command: fixture.exec });
    assert.equal((await backupAccount.test()).capabilities.restore, false);
  }
  const backup = await backupAccount.backup();
  assert.deepEqual((await verifySqlRestore({ engine, version: original.version, data: backup.data })).objects, original.objects);
  const name = 'archived';
  await session.query('CREATE DATABASE archived;');
  await session.query(pg ? 'GRANT CREATE ON SCHEMA public TO limited;' :
    `CREATE USER 'local_target'@'%' IDENTIFIED BY '${password}';
      GRANT ALL PRIVILEGES ON archived.* TO 'local_target'@'%';`, name);
  const localProject = { id: 'local-' + engine, path: join(fixtures, engine) };
  const sourceUser = pg ? 'limited' : 'backup_reader';
  const scheme = pg ? 'postgresql' : 'mysql';
  const uri = (user, name) => `${scheme}://${user}:${password}@127.0.0.1:${fixture.target.port}/${name}`;
  const targetUser = pg ? 'limited' : 'local_target';
  await writeFile(join(localProject.path, '.env'), `SOURCE_DATABASE_URL=${uri(sourceUser, fixture.target.name)}\nDATABASE_URL=${uri(targetUser, name)}\n`);
  const { requirements } = await discoverDatabases(localProject);
  const transfer = async name => {
    const { binding, server, instance } = databaseResource(localProject, requirements.find(item => item.name === name));
    return (await localTransferSession(localProject, { ...binding, server, instance }, fixture.exec)).session;
  };
  const localSource = await transfer(fixture.target.name);
  const local = await transfer(name);
  const localTarget = await local.test();
  assert.equal(localTarget.capabilities.restore, true);
  await local.restore((await localSource.backup()).data, localTarget.identity);
  assert.deepEqual((await local.inventory()).objects, original.objects);
  assert.equal(await session.query('SELECT id FROM notes;', name), '41');
  console.log(engine + ' initialized, verified TLS identity, and completed remote and local backup and restore');
}

async function composeRoundTrip(engine) {
  const pg = engine === 'postgres';
  const root = join(fixtures, 'compose-' + engine);
  const name = 'sf-' + token + '-' + engine;
  const password = randomBytes(16).toString('hex');
  await mkdir(root);
  const file = join(root, 'compose.yml');
  const environment = pg ? `POSTGRES_PASSWORD: ${password}\n      POSTGRES_DB: app` :
    `MYSQL_ROOT_PASSWORD: ${password}\n      MYSQL_PASSWORD: ${password}\n      MYSQL_USER: app\n      MYSQL_DATABASE: app`;
  const service = (key, volume) => `  ${key}:\n    image: ${pg ? 'postgres:17' : 'mysql:8.4'}\n    environment:\n      ${environment}\n    volumes:\n      - ${volume}:${pg ? '/var/lib/postgresql/data' : '/var/lib/mysql'}\n`;
  await writeFile(file, `name: ${name}\nservices:\n${service('db', 'data')}${service('second', 'second_data')}volumes:\n  data:\n  second_data:\n`);
  composeFixtures.push({ name, root });
  const operations = new ProjectOperations();
  const project = { id: name, path: root, name, unmanaged: true, folderIdentity: directoryIdentity(await lstat(root, { bigint: true })) };
  const { requirements } = await discoverDatabases(project);
  const selection = requirements.find(item => item.key === 'db' && item.engine === engine);
  const second = requirements.find(item => item.key === 'second' && item.engine === engine);
  const { binding, instance } = databaseResource(project, selection);
  const selectedBinding = { ...binding, instance, selection };
  await assert.rejects(operations.databaseTarget(project), /Choose an official/);
  assert.equal((await operations.databaseTarget(project, undefined, undefined, selection)).container, undefined);
  await operations.changeDatabase(project, 'database-start', undefined, { databaseSelection: selection });
  const target = await operations.databaseTarget(project, undefined, undefined, selection);
  assert.equal((await operations.databaseTarget(project, undefined, undefined, second)).container, undefined);
  assert.equal(target.container.status, 'running');
  for (let attempt = 0; !await databaseReady({ ...target, command: run, container: target.container.id }); attempt++) {
    if (attempt > 100) throw new Error('Compose database did not become ready.');
    await delay(500);
  }
  const registry = new DatabaseRegistry();
  const resources = databaseResources({ registry, directory: fixtures, operations });
  const dump = await resources.backup(project, selectedBinding);
  assert.equal(registry.value.backups[0].checksum, dump.metadata.checksum);
  const preview = await resources.preview(project, selectedBinding, undefined, dump.data);
  assert.equal(preview.name, name + '/db');
  assert.equal((await resources.restore(project, selectedBinding, undefined, dump.data, preview.id, preview.name)).restored, true);
  await operations.changeDatabase(project, 'database-stop', undefined, { databaseSelection: selection });
  assert.equal((await operations.databaseTarget(project, undefined, undefined, selection)).container.status, 'exited');
  assert.equal((await operations.databaseTarget(project, undefined, undefined, second)).container, undefined);
  console.log(engine + ' Compose with two services verified target selection, volume, start, backup, restore and stop');
}

async function windowsNative() {
  const name = 'sf_' + token;
  const port = Number(process.env.STACKFORGE_TEST_PG_PORT ?? 5432);
  const password = process.env.STACKFORGE_TEST_PG_PASSWORD;
  if (!password) throw new Error('Missing Windows integration database credentials.');
  const engine = 'postgres';
  const project = { id: 'native-windows', path: fixtures };
  const target = { engine, host: '127.0.0.1', port, name };
  const credentials = { user: 'postgres', password };
  const session = localSession(target, credentials);
  const context = { project, target, credentials, binding: { instanceId: 'native-windows' }, schema: true,
    recordMigration: async () => {}, revalidate: async () => {} };
  await mkdir(join(fixtures, 'database', 'migrations'), { recursive: true });
  await writeFile(join(fixtures, 'database', 'migrations', '001.sql'), 'CREATE TABLE notes (id INT PRIMARY KEY);');
  const plan = await initializationPlan(context);
  assert.deepEqual(plan.steps, ['create', 'schema']);
  try {
    await executeInitialization({ ...context, id: plan.id, confirmName: name });
    await session.query('INSERT INTO notes VALUES (41);', name);
    assert.equal(await session.query('SELECT id FROM notes;', name), '41');
    assert.deepEqual((await initializationPlan(context)).steps, []);
    console.log('Native Windows PostgreSQL initialized and verified');
  } finally {
    await session.query('DROP DATABASE IF EXISTS ' + session.quote(name) + ';');
  }
}

try {
  if (process.argv.includes('--windows-native')) await windowsNative();
  else {
    await certificate();
    const outcomes = await Promise.allSettled(['postgres', 'mysql'].map(async engine => {
      await remoteRoundTrip(engine);
      await composeRoundTrip(engine);
    }));
    for (const outcome of outcomes) if (outcome.status === 'rejected') { console.error(outcome.reason); process.exitCode = 1; }
  }
} finally {
  for (const { name, root } of composeFixtures) {
    assert.match(name, new RegExp('^sf-' + token + '-(?:postgres|mysql)$'));
    await docker(['compose', '--project-directory', root, '-p', name, '-f', join(root, 'compose.yml'), 'down', '--volumes']);
  }
  for (const id of containers) {
    const actual = (await docker(['inspect', '--format', '{{index .Config.Labels "io.stackforge.integration"}}', id])).trim();
    assert.equal(actual, token);
    await docker(['rm', '-fv', id]);
  }
  const parent = await realpath(tmpdir());
  assert.ok(fixtures.toLowerCase().startsWith(join(parent, 'stackforge-integration-').toLowerCase()));
  await rm(fixtures, { recursive: true, force: true });
}
