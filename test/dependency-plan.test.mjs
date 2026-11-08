import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { detectDependencyPlan } from '../src/dependency-plan.mjs';
import { createApp } from '../src/server.mjs';
import { ProjectOperations } from '../src/project-operations.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'stackforge-dependencies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(Object.entries(files).map(async ([name, contents]) => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }));
  return root;
}

test('detects explicit tools and workspaces, skips ambiguous folders, and accepts configured directories', async t => {
  const wrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
  const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const root = await fixture(t, {
    'package.json': '{"workspaces":["components/*"]}',
    'package-lock.json': '{}',
    'components/ui/package.json': '{}',
    'components/ui/package-lock.json': '{}',
    'frontend/package.json': '{}',
    'frontend/yarn.lock': '# yarn lockfile v1\n',
    'web/package.json': '{"packageManager":"yarn@4.5.0"}',
    'web/yarn.lock': '__metadata:\n',
    'backend/pom.xml': '<project></project>',
    ['backend/' + wrapper]: 'wrapper',
    'apps/docs/package.json': '{"packageManager":"bun@1.2.0"}',
    'apps/docs/bun.lock': '{}',
    'apps/node/package.json': '{"packageManager":"pnpm@10.0.0"}',
    'apps/node/pnpm-lock.yaml': 'lockfileVersion: 9.0',
    'apps/node/pnpm-workspace.yaml': "packages:\n  - 'modules/*'\n",
    'apps/node/modules/module/package.json': '{}',
    'apps/node/modules/module/package-lock.json': '{}',
    'apps/conflict/package.json': '{"packageManager":"npm@11.0.0"}',
    'apps/conflict/pnpm-lock.yaml': 'lockfileVersion: 9.0',
    'packages/unknown/package.json': '{"dependencies":{"express":"5.0.0"}}',
    'api/requirements.txt': 'flask==3.0.0',
    'services/python/pyproject.toml': '[project]\nname = "api"',
    'services/python/uv.lock': 'version = 1',
    'services/pip/requirements.txt': 'flask==3.0.0',
    ['services/pip/' + python]: 'interpreter fixture'
  });
  const startup = { services: [{ directory: 'services/python' }, { directory: 'services/pip' }] };
  const plan = await detectDependencyPlan({ path: root, startup });
  const commands = Object.fromEntries(plan.steps.map(step => [step.directory, step.command]));
  assert.deepEqual(commands, {
    '.': 'npm ci',
    'web': 'yarn install --immutable',
    'backend': (process.platform === 'win32' ? wrapper : './' + wrapper) + ' -B -DskipTests dependency:go-offline',
    'frontend': 'yarn install --frozen-lockfile',
    'apps/docs': 'bun install --frozen-lockfile',
    'apps/node': 'pnpm install --frozen-lockfile',
    'services/python': 'uv sync --locked',
    'services/pip': python + ' -m pip install -r requirements.txt'
  });
  assert.deepEqual(plan.issues.map(issue => issue.directory).sort(), ['api', 'apps/conflict', 'packages/unknown']);
  const alias = await fixture(t, {});
  await symlink(dirname(root), join(alias, 'alias'), 'junction');
  const aliased = await detectDependencyPlan({ path: join(alias, 'alias', basename(root)), startup });
  assert.equal(aliased.id, plan.id);
});

test('only installs a reviewed plan and keeps the custom fallback', { timeout: 20000 }, async t => {
  const root = await fixture(t, { 'package.json': '{}', 'package-lock.json': '{}' });
  const calls = [];
  const app = createApp({ stateDir: false, operations: new ProjectOperations({
    install: async (args, options) => { calls.push({ args, cwd: options.cwd }); },
    command: async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); }
  }) });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await app.shutdownTasks(); await new Promise(resolve => app.close(resolve)); });
  const url = 'http://127.0.0.1:' + app.address().port;
  const get = async route => (await fetch(url + route)).json();
  const { token } = await get('/api/state');
  const post = async (route, body, status) => {
    const response = await fetch(url + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const { id } = await post('/api/projects/import', { path: root }, 201);
  const project = '/api/projects/' + id;
  const task = async () => {
    for (let i = 0; i < 100; i++) {
      const result = (await get('/api/projects?logs=' + id)).projects[0].dependencies;
      if (result && result.status !== 'running') return result;
      await delay(50);
    }
    assert.fail('Installation did not finish');
  };
  const initial = await get(project + '/dependencies');
  assert.deepEqual(initial.steps, [{ tool: 'npm', command: 'npm ci', directory: '.', evidence: 'package-lock.json' }]);
  assert.equal(calls.length, 0);
  await post(project + '/install', { mode: 'detected' }, 400);

  await writeFile(join(root, 'yarn.lock'), '# yarn lockfile v1');
  await post(project + '/install', { mode: 'detected', planId: initial.id }, 202);
  assert.match((await task()).error, /plan changed/);
  assert.equal(calls.length, 0);
  assert.equal((await get(project + '/dependencies')).steps.length, 0);
  await post(project + '/startup', { services: [{ name: 'Root', directory: '.', installCommand: 'npm ci --ignore-scripts' }] }, 200);
  await post(project + '/install', {}, 202);
  assert.equal((await task()).status, 'succeeded');
  assert.equal(calls[0].command, 'npm ci --ignore-scripts');

  await rm(join(root, 'yarn.lock'));
  const updated = await get(project + '/dependencies');
  await post(project + '/install', { mode: 'detected', planId: updated.id }, 202);
  assert.equal((await task()).status, 'succeeded');
  assert.deepEqual(calls[1], { args: ['ci'], cwd: await realpath(root) });
});
