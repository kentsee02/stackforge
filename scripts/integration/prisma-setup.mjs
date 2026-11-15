import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../src/http/server.mjs';
import { npm, run } from '../../src/platform/process.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-prisma-')));
const project = join(root, 'portal');
const migration = join(project, 'prisma', 'migrations', '20260117051151_init', 'migration.sql');
const password = randomBytes(24).toString('base64url') + '#$';
const container = 'stackforge-prisma-' + randomUUID();
const docker = (args, options) => run('docker', args, { timeout: 30000, stdoutOnly: true, ...options });
let app;
let created = false;

try {
  await mkdir(join(migration, '..'), { recursive: true });
  await writeFile(migration, 'CREATE TABLE "player" ("id" SERIAL PRIMARY KEY);\n');
  await writeFile(join(migration, '..', '..', 'migration_lock.toml'), 'provider = "postgresql"\n');
  await writeFile(join(project, 'prisma', 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n}\n');
  await writeFile(join(project, 'prisma.config.ts'), [
    "import 'dotenv/config';",
    "import { defineConfig, env } from 'prisma/config';",
    "export default defineConfig({ schema: 'prisma/schema.prisma', migrations: { path: 'prisma/migrations' }, datasource: { url: env('DATABASE_URL') } });"
  ].join('\n'));
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'portal', private: true, devDependencies: { prisma: '7.2.0' } }));
  await docker(['run', '-d', '--pull=never', '--name', container, '--tmpfs', '/var/lib/postgresql/data',
    '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256', 'postgres:17'],
  { env: { ...process.env, POSTGRES_PASSWORD: password } });
  created = true;
  for (let attempt = 0; ; attempt++) {
    assert.equal((await docker(['inspect', '--format', '{{.State.Running}}', container])).trim(), 'true');
    try {
      await docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-q']);
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await delay(1000);
    }
  }
  const port = Number((await docker(['port', container, '5432/tcp'])).trim().split(':').at(-1));
  assert.ok(Number.isInteger(port) && port > 0);
  const command = (program, args, options = {}) => {
    if (!['psql', 'pg_dump', 'pg_restore'].includes(program)) throw new Error('ENOENT');
    const argsInContainer = [...args];
    if (args.includes('-p')) argsInContainer[args.indexOf('-p') + 1] = '5432';
    const keys = Object.keys(options.env ?? {}).filter(key => /^PG(?:PASSWORD|CONNECT_TIMEOUT|OPTIONS|SSLMODE)$/.test(key));
    return docker(['exec', '-i', ...keys.flatMap(key => ['-e', key]), container, program, ...argsInContainer], options);
  };
  app = createApp({ stateDir: join(root, 'state', 'jobs'), localDatabase: { command }, databaseAdapters: { command } }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  const host = 'http://127.0.0.1:' + app.address().port;
  const { token } = await (await fetch(host + '/api/state')).json();
  async function request(path, body) {
    const response = await fetch(host + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body)
    });
    const data = await response.json();
    assert.ok(!JSON.stringify(data).includes(password));
    return { status: response.status, data };
  }
  const registration = await request('/api/projects/import', { path: project });
  assert.equal(registration.status, 201, JSON.stringify(registration.data));
  const endpoint = '/api/projects/' + registration.data.id;
  const discovery = await request(endpoint + '/database-discovery');
  const requirementId = discovery.data.requirements.find(item => item.guidedSetup)?.id;
  assert.ok(requirementId, JSON.stringify(discovery.data));
  const credentials = { name: 'portal', host: '127.0.0.1', port, user: 'postgres', password };
  const setup = (mode, fields) => request(endpoint + '/database-postgres-setup', { requirementId, mode, ...fields });
  assert.equal((await setup('probe', { ...credentials, port: 1 })).data.status, 'server');
  assert.equal((await setup('probe', credentials)).data.status, 'credentials');
  assert.equal((await setup('inspect', { ...credentials, password: 'incorrect' })).data.status, 'authentication');
  const missing = await setup('inspect', credentials);
  assert.equal(missing.data.status, 'database', JSON.stringify(missing.data));
  assert.ok(missing.data.planId);
  const approval = { ...credentials, planId: missing.data.planId, confirmName: 'portal' };
  assert.equal((await setup('create', { ...approval, confirmName: 'wrong' })).status, 409);
  assert.equal((await setup('create', approval)).data.status, 'configure');
  assert.equal((await setup('inspect', credentials)).data.status, 'configure');
  assert.equal((await setup('save', credentials)).data.status, 'check');
  assert.match(await readFile(join(project, '.env'), 'utf8'), /DATABASE_URL="postgresql:\/\/postgres:.+%23%24@127\.0\.0\.1:\d+\/portal"/);
  assert.equal((await setup('inspect')).data.status, 'prisma-client');
  await npm(['install', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: project, timeout: 180000 });
  const pending = await setup('inspect');
  assert.deepEqual(pending.data.pending, ['20260117051151_init']);
  const migrate = { planId: pending.data.planId, confirmName: 'portal' };
  assert.equal((await setup('migrate', { ...migrate, planId: 'wrong' })).status, 409);
  const applied = await setup('migrate', migrate);
  assert.equal(applied.data.status, 'ready', JSON.stringify(applied.data));
  assert.equal(applied.data.tables, 1);
  assert.equal((await setup('inspect')).data.status, 'ready');
  const query = (sql, database = 'portal') => command('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', database, '-qAt', '-v', 'ON_ERROR_STOP=1'],
    { env: { ...process.env, PGPASSWORD: password }, input: Buffer.from(sql) }).then(output => output.trim());
  assert.equal(await query('INSERT INTO player DEFAULT VALUES RETURNING id;'), '1');
  await writeFile(migration, 'CREATE TABLE "different" ("id" SERIAL PRIMARY KEY);\n');
  assert.equal((await setup('inspect')).data.status, 'migration-conflict');
  console.log('Verified guided PostgreSQL creation, URL setup, real Prisma deployment, and migration history checks.');
  if (process.argv.includes('--large')) {
    const restorePassword = randomBytes(24).toString('hex');
    await query(`CREATE ROLE "restore_user" LOGIN PASSWORD '${restorePassword}'; GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO restore_user;`);
    await query('CREATE DATABASE portal_restore;');
    await query('GRANT CREATE ON SCHEMA public TO restore_user;', 'portal_restore');
    await query(`CREATE TABLE samples AS
      SELECT batch AS id, string_agg(decode(md5(random()::text), 'hex'), ''::bytea) AS content
      FROM generate_series(1, 81920) AS batch CROSS JOIN generate_series(1, 64) GROUP BY batch;`);
    const env = join(project, '.env');
    await writeFile(env, await readFile(env, 'utf8') + `RESTORE_DATABASE_URL=postgresql://restore_user:${restorePassword}@127.0.0.1:${port}/portal_restore\n`);
    const { data: { bindings } } = await request(endpoint + '/database-discovery');
    const idFor = name => bindings.find(binding => binding.instance.name === name).id;
    const archive = endpoint + '/database-archive';
    const archiveFile = join(root, 'portal.sfdb');
    const post = (path, name, body, extra = {}) => fetch(host + path, { method: 'POST',
      headers: { 'X-StackForge-Token': token, 'X-StackForge-Binding': idFor(name),
        'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream', ...extra }, body });
    const backup = await post(archive, 'portal', '{}');
    assert.equal(backup.status, 200, backup.ok ? '' : await backup.text());
    assert.ok(Number(backup.headers.get('Content-Length')) > 64 * 1024 * 1024 + 4096);
    await pipeline(backup.body, createWriteStream(archiveFile));
    const previewResponse = await post(archive + '/preview', 'portal_restore', await openAsBlob(archiveFile));
    assert.equal(previewResponse.status, 200, previewResponse.ok ? '' : await previewResponse.text());
    const preview = await previewResponse.json();
    const restored = await post(archive + '/restore', 'portal_restore', await openAsBlob(archiveFile), {
      'X-StackForge-Preview': preview.id, 'X-StackForge-Target': Buffer.from(preview.name).toString('base64')
    });
    assert.deepEqual(await restored.json(), { restored: true, objects: preview.objects, limited: false });
    const check = 'SELECT count(*), sum(octet_length(content)), min(md5(content)) FROM samples;';
    assert.equal(await query(check, 'portal_restore'), await query(check));
    console.log('Verified a PostgreSQL archive above 64 MiB through streaming download, upload, preview, and restore.');
  }
} finally {
  if (app) {
    await app.shutdownTasks();
    await new Promise(resolve => app.close(resolve));
  }
  try { if (created) await docker(['rm', '-f', container]); }
  finally { await rm(root, { recursive: true, force: true }); }
}
