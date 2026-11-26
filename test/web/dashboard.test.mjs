import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../src/http/server.mjs';
import { dashboardSnapshot } from '../../src/http/dashboard.mjs';

test('dashboard reads project, runtime, database and task records without probing databases or exposing credentials', { timeout: 20000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-dashboard-')));
  const runtime = { status(project) {
    if (project.name === 'api-project') return { status: 'running', ready: true, log: 'runtime-private-canary', services: {
      frontend: { url: 'http://127.0.0.1:5185/', ready: true },
      custom: { name: 'Protected API', kind: 'api', url: 'http://localhost:4115/', openUrl: 'http://localhost:4115/api?key=private-url-canary', ready: true },
      pending: { name: 'Pending service', url: 'http://localhost:4225/', ready: false }
    } };
    return { status: 'stopped' };
  }, async shutdown() {} };
  const app = createApp({ stateDir: join(root, 'state', 'jobs'), runtime, databaseAdapters: {
    developmentPostgres: { command: () => assert.fail('Dashboard must not run Docker') }
  }, localDatabase: { command: () => assert.fail('Dashboard must not run a database client') } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    await app.shutdownTasks();
    await new Promise(resolve => app.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.address().port + '/api/';
  const read = async () => {
    const res = await fetch(base + 'dashboard');
    assert.equal(res.status, 200);
    return res.json();
  };
  const { token } = await (await fetch(base + 'state')).json();
  const empty = await read();
  assert.equal(empty.projects.running, 0);
  assert.equal(empty.databases.attention, 0);
  assert.equal(empty.tasks.active, 0);
  async function add(name, environment) {
    const path = join(root, name);
    await mkdir(join(path, 'prisma'), { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, dependencies: { pg: '^8.0.0' } }));
    await writeFile(join(path, 'prisma/schema.prisma'), 'datasource db { provider = "postgresql" }');
    await writeFile(join(path, 'prisma.config.ts'), 'import "dotenv/config";\nexport default { datasource: { url: env("DASHBOARD_DATABASE_URL") } };');
    await writeFile(join(path, '.env.example'), 'DASHBOARD_DATABASE_URL=postgresql://user:changeme@localhost:5432/example\n');
    if (environment) await writeFile(join(path, '.env'), environment);
    const response = await fetch(base + 'projects/import', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-stackforge-token': token
    }, body: JSON.stringify({ path }) });
    assert.equal(response.status, 201);
    return response.json();
  }
  const available = await add('api-project', 'DASHBOARD_DATABASE_URL=postgresql://operator:database-private-canary@localhost:55432/appdb\n');
  const incomplete = await add('needs-config');
  const missing = await add('missing-folder');
  await rm(missing.path, { recursive: true });
  const activity = { id: '0979c843-7c8e-44ce-b9c3-fd282c43ecd9', projectId: available.id,
    action: 'database-backup', status: 'succeeded', startedAt: '2025-01-01T00:00:00.000Z', finishedAt: '2025-01-01T00:00:01.000Z' };
  await appendFile(join(root, 'state', 'database-operations.jsonl'), JSON.stringify(activity) + '\n');
  const registry = join(root, 'state', 'databases.json');
  const before = await readFile(registry, 'utf8');
  const data = await read();
  assert.equal(data.projects.running, 1);
  assert.equal(data.projects.total, 3);
  assert.deepEqual(data.projects.rows.map(row => row.status), ['offline', 'ready', 'stopped']);
  assert.deepEqual(data.services.rows.map(row => [row.projectName, row.kind, row.url]), [
    ['api-project', 'web', 'http://127.0.0.1:5185/'], ['api-project', 'api', undefined]
  ]);
  assert.equal(data.databases.attention, 1);
  assert.deepEqual(data.databases.rows.map(row => [row.projectId, row.engine, row.status]), [
    [incomplete.id, 'PostgreSQL', 'attention'], [available.id, 'PostgreSQL', 'configured']
  ]);
  assert.equal(data.tasks.rows[0].action, 'database-backup');
  assert.equal(data.tasks.rows[0].name, 'api-project');
  assert.doesNotMatch(JSON.stringify(data), /private-canary|url-canary|Pending service|appdb|operator/);
  assert.equal(await readFile(registry, 'utf8'), before);
});

test('dashboard can display projects when task and database records fail independently', async () => {
  const data = await dashboardSnapshot({ projects: async () => [{ id: 'one', name: 'local', status: 'stopped', services: [] }],
    tasks: async () => { throw new Error('task read failed'); }, databases: async () => { throw new Error('database read failed'); } });
  assert.equal(data.projects.total, 1);
  assert.equal(data.databases.attention, undefined);
  assert.equal(data.databases.unavailable, true);
  assert.equal(data.tasks.active, undefined);
  assert.equal(data.tasks.unavailable, true);
});
