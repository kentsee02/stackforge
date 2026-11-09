import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { detectStartupSuggestions } from '../src/startup-suggestions.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'stackforge-startup-suggestions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(Object.entries(files).map(async ([name, value]) => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  }));
  return root;
}

test('workspace members inherit their package manager and offer declared startup choices', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'workspace', packageManager: 'pnpm@10.0.0', scripts: { dev: 'echo no known orchestration' } },
    'pnpm-workspace.yaml': "packages:\n  - 'services/*'\n",
    'services/web/package.json': { name: '@team/web', scripts: { dev: 'vite --port 5178', start: 'vite --port 5179 && echo done' } },
    'services/api/package.json': { name: 'api', scripts: { 'start:dev': 'nest start --watch', test: 'node test.mjs' } },
    'services/conflict/package.json': { packageManager: 'npm@11.0.0', scripts: { dev: 'node main.mjs' } },
    'services/no-start/package.json': { scripts: { test: 'node test.mjs' } },
    'frontend/package.json': { scripts: { dev: 'vite' } },
    'workers/queue/package.json': { name: 'queue', packageManager: 'bun@1.2.0', scripts: { start: 'bun worker.ts' } }
  });
  const startup = { services: [{ directory: 'workers/queue' }] };
  const { groups, limited } = await detectStartupSuggestions({ path: root, startup });
  assert.equal(limited, false);
  assert.deepEqual(Object.fromEntries(groups.map(group => [group.directory, group.choices])), {
    'services/web': [{ command: 'pnpm run dev', script: 'dev', port: 5178 }, { command: 'pnpm run start', script: 'start' }],
    'services/api': [{ command: 'pnpm run start:dev', script: 'start:dev' }],
    'workers/queue': [{ command: 'bun run start', script: 'start' }]
  });
});

test('a recognized workspace launcher replaces its member suggestions', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'root', workspaces: ['apps/*'], scripts: { dev: 'turbo run dev', start: 'node one.mjs' } },
    'package-lock.json': '{}',
    'turbo.json': '{}',
    'apps/web/package.json': { scripts: { dev: 'vite --port 5173' } },
    'apps/api/package.json': { scripts: { dev: 'node server.mjs' } },
    'server/package.json': { name: 'other', scripts: { start: 'node main.mjs' } },
    'server/yarn.lock': '# yarn lockfile v1'
  });
  const { groups } = await detectStartupSuggestions({ path: root });
  assert.deepEqual(groups, [
    { directory: '.', name: 'root', choices: [{ command: 'npm run dev', script: 'dev', orchestrates: true }] },
    { directory: 'server', name: 'other', choices: [{ command: 'yarn run start', script: 'start' }] }
  ]);
});

test('reading suggestions leaves saved custom configuration and project files untouched', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'fixture', scripts: { dev: 'node should-not-run.mjs' } },
    'package-lock.json': '{}',
    'should-not-run.mjs': "import { writeFileSync } from 'node:fs'; writeFileSync('executed.txt', 'unexpected');"
  });
  const app = createApp({ stateDir: false });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await app.shutdownTasks(); await new Promise(resolve => app.close(resolve)); });
  const url = 'http://127.0.0.1:' + app.address().port;
  const get = async path => {
    const response = await fetch(url + path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const { token } = await get('/api/state');
  const post = async (path, body, status) => {
    const response = await fetch(url + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body) });
    assert.equal(response.status, status);
    return response.json();
  };
  const { id } = await post('/api/projects/import', { path: root }, 201);
  const saved = [{ name: 'Existing', directory: '.', command: 'node worker.js', installCommand: 'npm ci' }];
  await post('/api/projects/' + id + '/startup', { services: saved }, 200);
  const data = await get('/api/projects/' + id + '/startup-suggestions');
  assert.equal(data.groups[0].choices[0].command, 'npm run dev');
  assert.deepEqual((await get('/api/projects?logs=' + id)).projects[0].startupServices, saved);
  await assert.rejects(stat(join(root, 'executed.txt')), { code: 'ENOENT' });
});
