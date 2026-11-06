import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnvironment } from '../src/environment.mjs';
import { validateOptions } from '../src/catalog.mjs';
import { generateProject } from '../src/generator.mjs';
import { publishProject } from '../src/git.mjs';
import { run } from '../src/process.mjs';
import { createApp } from '../src/server.mjs';
import { normalizeTemplate, parseTemplateFile } from '../public/template-store.js';

const base = { name: 'test-project', parentDir: tmpdir(), frontend: 'vue', backend: 'express', database: 'none', install: false, git: true };
const healthy = {
  nodeVersion: '24.1.0', npm: async () => '12.0.0', portAvailable: async () => true,
  fetchImpl: async () => new Response('{}'),
  run: async (command, args) => {
    if (command === 'git') return args.includes('--version') ? 'git version 2.51.0' : 'configured';
    if (command === 'javac') return 'javac 21.0.1';
    if (command === 'docker') return args.includes('info') ? '28.0.0' : '2.40.0';
    if (command === 'gh' && args.includes('user')) return 'test-owner';
    if (command === 'gh' && args.some(value => value.startsWith('repos/'))) throw new Error('Not Found (HTTP 404)');
    return 'gh version 2.80.0';
  }
};

test('local Git initialization checks installation but never requests authentication or commit identity', async () => {
  const calls = [];
  const report = await checkEnvironment(base, { ...healthy, run: async (command, args, settings) => { calls.push([command, args]); return healthy.run(command, args, settings); } });
  assert.equal(report.canCreate, true);
  assert.equal(report.checks.some(item => ['identity', 'github'].includes(item.id)), false);
  assert.equal(calls.some(([command]) => command === 'gh'), false);
});

test('missing prerequisites block only operations that need them during creation', async () => {
  const offline = { ...healthy, run: async () => { throw new Error('not installed'); }, portAvailable: async () => false };
  const onlyFiles = await checkEnvironment({ ...base, git: false, backend: 'spring', database: 'mysql' }, offline);
  assert.equal(onlyFiles.canCreate, true);
  for (const id of ['java', 'docker', 'docker-engine', 'port-5173', 'port-8080', 'port-3306']) assert.equal(onlyFiles.checks.find(item => item.id === id).status, 'warning');
  const installing = await checkEnvironment({ ...base, git: false, backend: 'spring', install: true }, offline);
  assert.equal(installing.checks.find(item => item.id === 'java').status, 'error');
  const gitRequired = await checkEnvironment(base, offline);
  assert.equal(gitRequired.checks.find(item => item.id === 'git').status, 'error');
  const tooOld = await checkEnvironment(base, { ...healthy, nodeVersion: '22.11.0' });
  assert.equal(tooOld.checks.find(item => item.id === 'node').status, 'error');
});

test('detects unavailable network, existing folders and missing commit identity without creating files', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'stackforge-check-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, base.name));
  const report = await checkEnvironment({ ...base, parentDir: parent, commit: true }, { ...healthy, fetchImpl: async () => { throw new Error('offline'); }, run: async (command, args) => args.includes('config') ? '' : healthy.run(command, args) });
  for (const id of ['identity', 'npm-network', 'destination']) assert.equal(report.checks.find(item => item.id === id).status, 'error');
  assert.deepEqual(await readdir(parent), [base.name]);
  const specified = await checkEnvironment({ ...base, commit: true, authorName: 'Example', authorEmail: 'example@example.com' }, healthy);
  assert.equal(specified.checks.find(item => item.id === 'identity').status, 'ok');
});

test('GitHub checks account and new repository availability only when publication is selected', async () => {
  const options = { ...base, commit: true, publish: true };
  assert.equal((await checkEnvironment(options, healthy)).canCreate, true);
  const taken = await checkEnvironment(options, { ...healthy, run: async (command, args) => args.some(value => value.startsWith('repos/')) ? '42' : healthy.run(command, args) });
  assert.equal(taken.checks.find(item => item.id === 'repo-name').status, 'error');
  const noAuth = await checkEnvironment(options, { ...healthy, run: async (command, args) => { if (command === 'gh') throw new Error('not logged in'); return healthy.run(command, args); } });
  assert.equal(noAuth.checks.find(item => item.id === 'github').status, 'error');
});

test('validates Git step dependencies and command-sensitive identity input', () => {
  for (const input of [{ commit: true, git: false }, { publish: true }, { visibility: 'internal' }, { repoName: '../other' }, { authorName: 'person\nother' }, { authorEmail: 'invalid' }]) assert.throws(() => validateOptions({ ...base, ...input }));
  assert.equal(validateOptions({ ...base, commit: true, authorName: 'Name & Company', authorEmail: 'example@example.com' }).authorName, 'Name & Company');
});

test('portable templates whitelist configuration and strip paths, identities and publication authority', () => {
  const item = normalizeTemplate({ name: '我的模板', config: { ...base, groupId: 'com.example', commit: true, publish: true, parentDir: '/secret', authorEmail: 'private@example.com', token: 'secret' } });
  assert.deepEqual(Object.keys(item.config).sort(), ['backend', 'commit', 'database', 'frontend', 'git', 'groupId', 'install'].sort());
  const text = JSON.stringify({ format: 'stackforge-presets', version: 1, templates: [item] });
  assert.deepEqual(parseTemplateFile(text), [item]);
  assert.throws(() => parseTemplateFile(text.replace('"version":1', '"version":2')));
  assert.throws(() => parseTemplateFile(JSON.stringify({ format: 'stackforge-presets', version: 1, templates: [item, item] })), /重名/);
  assert.throws(() => parseTemplateFile(' '.repeat(65537)), /64 KB/);
  assert.throws(() => normalizeTemplate({ name: 'bad', config: { ...item.config, backend: 'none', database: 'mysql' } }));
});

test('real first commit records the provided local identity and excludes .env', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'stackforge-commit-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const result = await generateProject({ ...base, parentDir: parent, database: 'mysql', commit: true, authorName: 'Name & Company', authorEmail: 'example@example.com' }, () => {}, {
    fetchImpl: async () => new Response('{"version":"1.2.3"}'),
    run: (command, args, options) => run(command, ['-c', 'commit.gpgsign=false', ...args], options)
  });
  const tracked = await run('git', ['ls-files'], { cwd: result.path });
  assert.match(tracked, /\.env.example/);
  assert.equal(tracked.split(/\r?\n/).includes('.env'), false);
  assert.equal((await run('git', ['log', '-1', '--format=%an|%ae'], { cwd: result.path })).trim(), 'Name & Company|example@example.com');
  assert.equal(result.committed, true);
});

test('publication retry reuses only its recorded remote, verifies account, and never creates a second repository', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stackforge-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.git'));
  let creations = 0, pushes = 0, origin = '', account = 'test-owner';
  const remote = { id: 42, full_name: 'test-owner/test-project', private: true };
  const command = async (bin, args) => {
    if (bin === 'gh' && args.includes('user')) return account;
    if (bin === 'gh' && args.includes('user/repos')) { creations++; return JSON.stringify(remote); }
    if (bin === 'gh') return JSON.stringify(remote);
    if (args.includes('get-url')) { if (!origin) throw new Error('no origin'); return origin; }
    if (args.includes('add')) { origin = args.at(-1); return ''; }
    if (args.includes('push')) { pushes++; if (pushes === 1) throw new Error('connection lost'); return ''; }
    throw new Error('Unexpected command');
  };
  const options = validateOptions({ ...base, commit: true, publish: true });
  await assert.rejects(publishProject(root, options, () => {}, command), /connection lost/);
  assert.equal(JSON.parse(await readFile(join(root, '.git/stackforge-remote.json'))).id, 42);
  assert.equal((await publishProject(root, options, () => {}, command)).status, 'published');
  assert.equal(creations, 1);
  account = 'different-user';
  await assert.rejects(publishProject(root, options, () => {}, command), /账号已变更/);
  assert.equal(pushes, 2);
});

test('a remote publication failure preserves the complete local project', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'stackforge-remote-fail-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const result = await generateProject({ ...base, parentDir: parent, commit: true, publish: true, authorName: 'Example', authorEmail: 'example@example.com' }, () => {}, {
    fetchImpl: async () => new Response('{"version":"1.2.3"}'),
    run: async (command, args) => { if (command === 'gh') throw new Error('remote unavailable'); return ''; }
  });
  assert.equal(result.remote.status, 'failed');
  assert.equal((await stat(join(result.path, 'README.md'))).isFile(), true);
});

test('HTTP checks protect writes, block generation on errors and retry publication against the saved job path', async t => {
  let canCreate = false, generated = 0, pushedPath;
  const server = createApp({ check: async () => ({ canCreate, checks: [] }), generate: async () => { generated++; return { path: 'trusted/job/path', commands: [], remote: { status: 'failed', error: 'offline' } }; }, publish: async path => { pushedPath = path; return { status: 'published', url: 'https://github.com/test-owner/test-project' }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(origin + '/api/state')).json();
  const headers = { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token };
  const post = (path, input, h = headers) => fetch(origin + path, { method: 'POST', headers: h, body: JSON.stringify(input) });
  assert.equal((await post('/api/checks', base, { ...headers, 'X-StackForge-Token': 'wrong' })).status, 403);
  assert.equal((await post('/api/projects', base)).status, 422);
  assert.equal(generated, 0);
  canCreate = true;
  const accepted = await post('/api/projects', { ...base, commit: true, publish: true });
  const { id } = await accepted.json();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post(`/api/jobs/${id}/publish`, { path: '/untrusted/input' })).status, 202);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pushedPath, 'trusted/job/path');
  assert.equal((await post(`/api/jobs/${id}/publish`, {})).status, 400);
});
