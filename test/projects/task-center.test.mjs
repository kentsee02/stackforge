import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../../src/http/server.mjs';

test('Tasks combines concurrent projects and generation, protects cancellation, and reloads terminal outcomes', { timeout: 45000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-task-center-')));
  const stateDir = join(root, 'state', 'jobs');
  let app;
  async function open() {
    app = createApp({ stateDir, check: async () => ({ canCreate: true }),
      generate: async (_, report, { signal }) => {
        report({ type: 'step', message: 'generation-output-canary', progress: 20 });
        await sleep(60000, undefined, { signal });
      } });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const base = 'http://127.0.0.1:' + app.address().port;
    const get = async path => (await fetch(base + '/api/' + path)).json();
    const { token } = await get('state');
    return { get, post: (path, payload, key = token) => fetch(base + '/api/' + path, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-stackforge-token': key
    }, body: JSON.stringify(payload) }) };
  }
  async function close() {
    if (!app) return;
    await app.shutdownTasks();
    await new Promise(resolve => app.close(resolve));
    app = undefined;
  }
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const { get, post } = await open();

  async function loadProject(name) {
    const path = join(root, name);
    await mkdir(path);
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, scripts: { test: 'node wait.mjs' } }));
    await writeFile(join(path, 'wait.mjs'), 'console.log("check fixture started"); setTimeout(() => {}, 10000);');
    const response = await post('projects/import', { path });
    assert.equal(response.status, 201);
    const { id } = await response.json();
    const { checks } = await get(`projects/${id}/checks`);
    return { id, async run({ waitForCommand = true } = {}) {
      assert.equal((await post(`projects/${id}/run-check`, { check: checks[0].id })).status, 202);
      if (!waitForCommand) return;
      for (let i = 0; i < 100; i++) {
        const { projects } = await get(`projects?logs=${id}`);
        if (projects.find(project => project.id === id)?.checkTask?.log.includes('check fixture started')) return;
        await sleep(50);
      }
      assert.fail('Check fixture did not start');
    } };
  }
  async function until(assertion) {
    for (let i = 0; i < 100; i++) {
      const view = await get('tasks');
      if (assertion(view)) return view;
      await sleep(50);
    }
    assert.fail('Task view did not reach the expected state');
  }
  const first = await loadProject('first-project');
  const second = await loadProject('second-project');
  await Promise.all([first.run(), second.run()]);
  const started = await post('projects', { name: 'generated-project', parentDir: root, frontend: 'vue', backend: 'none', database: 'none', install: false, git: false });
  assert.equal(started.status, 202);
  const { id: jobId } = await started.json();
  const { active } = await until(view => view.active.length === 3);
  const firstTask = active.find(task => task.projectId === first.id);
  const secondTask = active.find(task => task.projectId === second.id);
  const creation = active.find(task => task.jobId === jobId);
  assert.deepEqual(active.map(row => row.action).sort(), ['check-test', 'check-test', 'create-project']);
  assert.ok(active.every(row => row.canCancel));
  assert.doesNotMatch(JSON.stringify(active), /generation-output-canary|wait\.mjs|parentDir/);
  assert.equal((await post('tasks/cancel', { id: firstTask.id }, 'invalid')).status, 403);
  assert.equal((await post('tasks/cancel', { id: firstTask.id })).status, 202);
  await until(view => view.active.length === 2 && view.history.some(row => row.projectId === first.id && row.status === 'cancelled'));
  await first.run({ waitForCommand: false });
  const replaced = await until(view => view.active.length === 3 && view.active.some(row => row.projectId === first.id && row.id !== firstTask.id));
  const replacement = replaced.active.find(row => row.projectId === first.id);
  assert.equal((await post('tasks/cancel', { id: firstTask.id })).status, 409);
  assert.ok((await get('tasks')).active.some(row => row.id === replacement.id && row.canCancel));
  assert.equal((await post('tasks/cancel', { id: replacement.id })).status, 202);
  assert.equal((await post('tasks/cancel', { id: secondTask.id })).status, 202);
  assert.equal((await post('tasks/cancel', { id: creation.id })).status, 202);
  await until(view => !view.active.length && view.history.length === 4);
  assert.equal((await post(`jobs/${jobId}/retry`, {})).status, 202);
  const retried = (await until(view => view.active.some(row => row.jobId === jobId))).active.find(row => row.jobId === jobId);
  assert.notEqual(retried.id, creation.id);
  assert.equal((await post('tasks/cancel', { id: creation.id })).status, 409);
  assert.equal((await post('tasks/cancel', { id: retried.id })).status, 202);
  await until(view => !view.active.length && view.history.some(row => row.id === retried.id && row.status === 'cancelled'));
  await close();
  const { get: reloaded } = await open();
  const { active: after, history } = await reloaded('tasks');
  assert.deepEqual(after, []);
  assert.equal(history.length, 4);
  assert.ok(history.every(row => row.status === 'cancelled' && row.finishedAt));
  assert.equal(history.find(row => row.jobId === jobId).id, retried.id);
});
