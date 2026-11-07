import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';
import { run } from '../src/process.mjs';

test('project checks run only supported commands, and Git compares the selected repository against its local upstream', { timeout: 30000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-tools-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { name: 'tools-app', frontend: 'vue', backend: 'spring', database: 'none' };
  await Promise.all(['scripts', 'frontend', 'backend'].map(folder => mkdir(join(directory, folder))));
  await Promise.all([
    writeFile(join(directory, 'stackforge.json'), JSON.stringify({ generator: 'StackForge', options })),
    writeFile(join(directory, 'scripts/dev.mjs'), ''),
    writeFile(join(directory, 'scripts/check.mjs'), "console.log('fixture check output'); if (process.argv[2] === 'wait') setInterval(() => {}, 1000);"),
    writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'node scripts/check.mjs', test: 'node scripts/check.mjs wait', deploy: 'exit 1' } })),
    writeFile(join(directory, 'frontend/package.json'), JSON.stringify({ scripts: { lint: 'node -e "console.error(12345); process.exit(7)"' } })),
    writeFile(join(directory, 'backend/pom.xml'), '<project/>'),
    writeFile(join(directory, process.platform === 'win32' ? 'backend/mvnw.cmd' : 'backend/mvnw'), process.platform === 'win32'
      ? '@echo off\r\necho fixture Maven %*\r\n' : '#!/bin/sh\necho fixture Maven "$@"\n', { mode: 0o755 })
  ]);

  const server = createApp({ stateDir: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await server.shutdownTasks(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async path => (await fetch(base + path)).json();
  const { token } = await get('/api/state');
  const post = (path, body = {}, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stackforge-token': token, ...headers }, body: JSON.stringify(body) });
  const imported = await post('/api/projects/import', { path: directory });
  assert.equal(imported.status, 201);
  const { id } = await imported.json();
  const route = `/api/projects/${id}`;
  const state = async check => {
    for (let i = 0; i < 120; i++) {
      const project = (await get(`/api/projects?logs=${id}`)).projects[0];
      if (project.checkTask && check(project)) return project.checkTask;
      await sleep(50);
    }
    assert.fail('Expected check state was not reached');
  };
  assert.deepEqual((await get(route + '/checks')).checks.map(check => check.id), ['root:build', 'root:test', 'frontend:lint', 'maven:package', 'maven:test']);
  assert.equal((await post(route + '/run-check', { check: 'root:deploy' })).status, 409);
  assert.equal((await post(route + '/run-check', { check: 'root:build' }, { 'x-stackforge-token': 'invalid' })).status, 403);
  assert.equal((await post(route + '/run-check', { check: 'root:build' })).status, 202);
  assert.match((await state(({ checkTask }) => checkTask.phase === 'root:build' && checkTask.status === 'succeeded')).log, /fixture check output/);
  assert.equal((await post(route + '/run-check', { check: 'frontend:lint' })).status, 202);
  const failed = await state(({ checkTask }) => checkTask.phase === 'frontend:lint' && checkTask.status === 'failed');
  assert.match(failed.log, /12345/);
  assert.match(failed.error, /7/);
  assert.equal((await post(route + '/run-check', { check: 'maven:package' })).status, 202);
  assert.match((await state(({ checkTask }) => checkTask.phase === 'maven:package' && checkTask.status === 'succeeded')).log, /fixture Maven -B package/);
  assert.equal((await post(route + '/run-check', { check: 'root:test' })).status, 202);
  await state(({ checkTask }) => checkTask.phase === 'root:test' && checkTask.log.includes('fixture check output'));
  assert.equal((await post(route + '/trash', { confirmName: options.name })).status, 409);
  assert.equal((await post(route + '/check-cancel')).status, 202);
  await state(({ checkTask }) => checkTask.status === 'cancelled');

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
