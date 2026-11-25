import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../../src/http/server.mjs';
import { run } from '../../src/platform/process.mjs';

test('project checks run only supported commands, and Git compares the selected repository against its local upstream', { timeout: 60000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-tools-')));
  const options = { name: 'tools-app', frontend: 'vue', backend: 'spring', database: 'none' };
  await Promise.all(['scripts', 'frontend', 'backend'].map(folder => mkdir(join(directory, folder))));
  await Promise.all([
    writeFile(join(directory, 'stackforge.json'), JSON.stringify({ generator: 'StackForge', options })),
    writeFile(join(directory, 'scripts/dev.mjs'), ''),
    writeFile(join(directory, '.env'), 'DATABASE_URL=postgresql://operator:check-test-password@localhost/db\n'),
    writeFile(join(directory, 'scripts/check.mjs'), "console.log('fixture check output', 'check-test-password'); if (process.argv[2] === 'wait') setInterval(() => {}, 1000);"),
    writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node scripts/check.mjs', test: 'node scripts/check.mjs wait', deploy: 'exit 1' } })),
    writeFile(join(directory, 'frontend/package.json'), JSON.stringify({ scripts: { lint: 'node -e "console.error(12345); process.exit(7)"' } })),
    writeFile(join(directory, 'backend/pom.xml'), '<project/>'),
    writeFile(join(directory, process.platform === 'win32' ? 'backend/mvnw.cmd' : 'backend/mvnw'), process.platform === 'win32'
      ? '@echo off\r\necho fixture Maven %*\r\n' : '#!/bin/sh\necho fixture Maven "$@"\n', { mode: 0o755 })
  ]);

  const server = createApp({ stateDir: false });
  t.after(async () => {
    await server.shutdownTasks();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async path => (await fetch(base + path)).json();
  const { token } = await get('/api/state');
  const post = (path, body = {}, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stackforge-token': token, ...headers }, body: JSON.stringify(body) });
  const imported = await post('/api/projects/import', { path: directory });
  assert.equal(imported.status, 201);
  const { id } = await imported.json();
  const route = `/api/projects/${id}`;
  const state = async (phase, matches) => {
    const deadline = Date.now() + 15000;
    let task;
    while (Date.now() < deadline) {
      task = (await get(`/api/projects?logs=${id}`)).projects[0]?.checkTask;
      if (task?.phase === phase) {
        if (matches(task)) return task;
        if (['succeeded', 'failed', 'cancelled'].includes(task.status)) break;
      }
      await sleep(50);
    }
    assert.fail(`Expected check state for ${phase}, received ${JSON.stringify(task)}`);
  };
  assert.deepEqual((await get(route + '/checks')).checks.map(check => check.id), ['root:build', 'root:test', 'frontend:lint', 'maven:package', 'maven:test']);
  assert.equal((await post(route + '/run-check', { check: 'root:deploy' })).status, 409);
  assert.equal((await post(route + '/run-check', { check: 'root:build' }, { 'x-stackforge-token': 'invalid' })).status, 403);
  assert.equal((await post(route + '/run-check', { check: 'root:build' })).status, 202);
  const build = await state('root:build', task => task.status === 'succeeded');
  assert.match(build.log, /fixture check output \[redacted\]/);
  assert.doesNotMatch(build.log, /check-test-password/);
  assert.equal((await post(route + '/run-check', { check: 'frontend:lint' })).status, 202);
  const failed = await state('frontend:lint', task => task.status === 'failed');
  assert.match(failed.log, /12345/);
  assert.match(failed.error, /7/);
  assert.equal((await post(route + '/run-check', { check: 'maven:package' })).status, 202);
  assert.match((await state('maven:package', task => task.status === 'succeeded')).log, /fixture Maven -B package/);
  assert.equal((await post(route + '/run-check', { check: 'root:test' })).status, 202);
  await state('root:test', task => task.log.includes('fixture check output'));
  assert.equal((await post(route + '/trash', { confirmName: options.name })).status, 409);
  assert.equal((await post(route + '/check-cancel')).status, 202);
  await state('root:test', task => task.status === 'cancelled');

  assert.deepEqual(await get(route + '/git'), { status: 'absent' });
  const git = args => run('git', args, { cwd: directory, stdoutOnly: true });
  const commit = message => git(['-c', 'user.name=StackForge QA', '-c', 'user.email=qa@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', message]);
  await git(['init', '-b', 'upstream-branch']);
  assert.equal((await get(route + '/git')).initial, true);
  await git(['add', '.']);
  await commit('Base');
  const first = (await git(['rev-parse', 'HEAD'])).trim();
  await commit('Upstream commit');
  const remote = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['switch', '-c', 'local-work', first]);
  await commit('Local commit');
  await git(['remote', 'add', 'origin', 'https://example.invalid/tools-app.git']);
  await git(['update-ref', 'refs/remotes/origin/upstream-branch', remote]);
  await git(['branch', '--set-upstream-to=origin/upstream-branch', 'local-work']);
  await writeFile(join(directory, 'working copy.txt'), 'untracked');
  assert.deepEqual(await get(route + '/git'), {
    status: 'available', branch: 'local-work', initial: false, changes: 1, upstream: 'origin/upstream-branch', ahead: 1, behind: 1
  });
  await git(['switch', '--detach']);
  const detached = await get(route + '/git');
  assert.equal(detached.branch, null);
  assert.equal(detached.upstream, null);
  assert.equal(detached.ahead, null);
});

test('project activity persists across restarts and safely includes existing database records', { timeout: 30000 }, async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-activity-')));
  const stateDir = join(workspace, 'state', 'jobs');
  let server;
  async function openApp() {
    server = createApp({ stateDir });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async path => (await fetch(base + path)).json();
    const { token } = await get('/api/state');
    const post = (path, payload) => fetch(base + path, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-stackforge-token': token
    }, body: JSON.stringify(payload) });
    return { get, post };
  }
  async function closeApp() {
    if (!server) return;
    await server.shutdownTasks();
    await new Promise(resolve => server.close(resolve));
    server = undefined;
  }
  t.after(async () => { await closeApp(); await rm(workspace, { recursive: true, force: true }); });
  const { get, post } = await openApp();
  async function addProject(name) {
    const path = join(workspace, name);
    await mkdir(path);
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, scripts: { build: 'node --version' } }));
    const response = await post('/api/projects/import', { path });
    assert.equal(response.status, 201);
    return (await response.json()).id;
  }
  const id = await addProject('recorded-project');
  const otherId = await addProject('other-project');
  const route = `/api/projects/${id}`;
  const legacy = { id: '0979c843-7c8e-44ce-b9c3-fd282c43ecd9', projectId: id, action: 'database-backup', status: 'succeeded',
    instanceId: 'a'.repeat(64), startedAt: '2000-01-01T00:00:00.000Z', finishedAt: '2000-01-01T00:00:01.000Z',
    output: 'activity-test-canary' };
  await appendFile(join(workspace, 'state', 'database-operations.jsonl'), [JSON.stringify(legacy),
    JSON.stringify({ ...legacy, id: '4c4c5240-24ef-4d40-8e1e-a190e6c447a8', projectId: otherId, action: 'database-stop' }),
    '{interrupted record}', ''].join('\n'));
  await appendFile(join(workspace, 'state', 'project-operations.jsonl'), '{"interrupted":');
  assert.equal((await post(route + '/startup', { services: [{ name: 'CLI', directory: '.', installCommand: 'node --version' }] })).status, 200);
  async function waitFor(action) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { entries } = await get(route + '/activity');
      if (entries.some(entry => entry.action === action && entry.status === 'succeeded')) return;
      await sleep(50);
    }
    assert.fail(`Missing completed action ${action}`);
  }
  assert.equal((await post(route + '/install', {})).status, 202);
  await waitFor('install');
  const { checks } = await get(route + '/checks');
  assert.equal((await post(route + '/run-check', { check: checks[0].id })).status, 202);
  await waitFor('check-build');
  await closeApp();
  const { get: afterRestart } = await openApp();
  const { entries, limited } = await afterRestart(route + '/activity');
  assert.equal(limited, false);
  assert.deepEqual(entries.map(item => [item.action, item.status]), [
    ['check-build', 'succeeded'], ['install', 'succeeded'], ['database-backup', 'succeeded']
  ]);
  assert.doesNotMatch(JSON.stringify(entries), /activity-test-canary|instanceId|projectId|node --version/);
  assert.deepEqual((await afterRestart(`/api/projects/${otherId}/activity`)).entries.map(item => item.action), ['database-stop']);
});
