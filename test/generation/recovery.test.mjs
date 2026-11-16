import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, readFile, writeFile, appendFile, stat, rm, mkdir, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { generateProject } from '../../src/generation/generator.mjs';
import { createApp, identity } from '../../src/http/server.mjs';
import { Jobs } from '../../src/generation/jobs.mjs';
import { JobStore } from '../../src/generation/job-store.mjs';
import { run, cancelled } from '../../src/platform/process.mjs';
import { directoryIdentity } from '../../src/platform/project-identity.mjs';
import { launch } from '../../scripts/launcher.mjs';

const base = { name: 'recovery-app', frontend: 'vue', backend: 'express', database: 'mysql', install: true, git: false };
const fetchImpl = async () => new Response('{"version":"1.2.3"}');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, accepts) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const value = await read(); if (accepts(value)) return value; await delay(30); }
  throw new Error('Timed out waiting for test state');
}
async function temp(t, prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('retry skips completed generation and retains passwords, file edits and partial install data', async t => {
  const parent = await temp(t, 'stackforge-resume-');
  const checkpoint = {};
  let installs = 0;
  const options = { ...base, parentDir: parent };
  await assert.rejects(generateProject(options, () => {}, { checkpoint, fetchImpl, npm: async () => { installs++; throw new Error('download failed'); } }), /download failed/);
  assert.ok(checkpoint.completed.includes('files'));
  assert.equal(checkpoint.completed.includes('npm'), false);
  const env = await readFile(join(checkpoint.staging, '.env'), 'utf8');
  await appendFile(join(checkpoint.staging, 'README.md'), '\nRetain this edit.\n');
  await writeFile(join(checkpoint.staging, 'partial-install.txt'), 'cache');
  const result = await generateProject(options, () => {}, { checkpoint, fetchImpl: async () => { throw new Error('completed downloads must not repeat'); }, npm: async () => { installs++; } });
  assert.equal(installs, 2);
  assert.equal(await readFile(join(result.path, '.env'), 'utf8'), env);
  assert.match(await readFile(join(result.path, 'README.md'), 'utf8'), /Retain this edit/);
  assert.equal(await readFile(join(result.path, 'partial-install.txt'), 'utf8'), 'cache');
  await assert.rejects(stat(join(result.path, '.stackforge-owner')), { code: 'ENOENT' });
});

test('cancellation after promotion resumes the same project without regenerating or overwriting files', async t => {
  const parent = await temp(t, 'stackforge-promoted-');
  const checkpoint = {}, controller = new AbortController();
  const options = { ...base, parentDir: parent, install: false };
  await assert.rejects(generateProject(options, () => {}, { checkpoint, fetchImpl, signal: controller.signal, onCheckpoint: async state => { if (state.promoted) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(checkpoint.promoted, true);
  await appendFile(join(parent, base.name, 'README.md'), '\nDo not overwrite.\n');
  const result = await generateProject(options, () => {}, { checkpoint, fetchImpl: async () => { throw new Error('unexpected download'); } });
  assert.match(await readFile(join(result.path, 'README.md'), 'utf8'), /Do not overwrite/);
});

test('resuming refuses changed options and unowned directories without modifying them', async t => {
  const parent = await temp(t, 'stackforge-owner-');
  const checkpoint = {};
  const options = { ...base, parentDir: parent };
  await assert.rejects(generateProject(options, () => {}, { checkpoint, fetchImpl, npm: async () => { throw new Error('offline'); } }));
  await assert.rejects(generateProject({ ...options, frontend: 'react' }, () => {}, { checkpoint, fetchImpl }), /不能更换/);
  const outside = join(parent, 'user-files');
  await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'keep');
  checkpoint.staging = outside;
  await assert.rejects(generateProject(options, () => {}, { checkpoint, fetchImpl }), /不属于/);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('resuming rejects a copy of the original staging folder even with its ownership marker', async t => {
  const parentDir = await temp(t, 'stackforge-staging-identity-');
  const options = { ...base, parentDir };
  const checkpoint = {};
  await assert.rejects(generateProject(options, () => {}, { checkpoint, fetchImpl, npm: async () => { throw new Error('offline'); } }), /offline/);
  const original = checkpoint.staging + '-original';
  await rename(checkpoint.staging, original);
  await cp(original, checkpoint.staging, { recursive: true });
  await assert.rejects(generateProject(options, () => {}, { checkpoint, fetchImpl, npm: async () => {} }), /位置发生变化/);
  assert.equal((await stat(checkpoint.staging)).isDirectory(), true);
});

test('cancelling a command terminates its descendant process and stops file writes', async t => {
  const directory = await temp(t, 'stackforge-process-');
  const heartbeat = join(directory, 'heartbeat');
  const childCode = "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),25);";
  const parentCode = "require('node:child_process').spawn(process.execPath,['--input-type=commonjs','-e',process.argv[1],process.argv[2]],{stdio:'ignore'});setInterval(()=>{},1000);";
  const controller = new AbortController();
  const executing = run(process.execPath, ['--input-type=commonjs', '-e', parentCode, childCode, heartbeat], { signal: controller.signal });
  const rejected = assert.rejects(executing, { name: 'AbortError' });
  await eventually(async () => { try { return (await stat(heartbeat)).size; } catch { return 0; } }, size => size > 0);
  controller.abort(); await rejected;
  const size = (await stat(heartbeat)).size;
  await delay(200);
  assert.equal((await stat(heartbeat)).size, size);
});

test('HTTP cancellation persists checkpoints, survives server restart and resumes using the recorded options', async t => {
  const directory = await temp(t, 'stackforge-job-');
  const stateDir = join(directory, 'jobs');
  let installs = 0;
  const generate = (options, report, services) => generateProject(options, report, { ...services, fetchImpl, npm: async (args, { signal }) => {
    installs++;
    if (signal.aborted) throw cancelled();
    if (installs === 1) await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(cancelled()), { once: true }); });
  } });
  const open = async () => {
    const server = createApp({ stateDir, generate, check: async () => ({ canCreate: true, checks: [] }) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const state = await (await fetch(url + '/api/state')).json();
    const post = (path, data = {}, token = state.token) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(data) });
    return { server, url, post };
  };
  let app = await open();
  t.after(async () => { await app.server.shutdownTasks(); await new Promise(resolve => app.server.close(resolve)); });
  const accepted = await app.post('/api/projects', { ...base, parentDir: join(directory, 'projects') });
  const { id } = await accepted.json();
  const read = () => fetch(app.url + '/api/jobs/' + id).then(response => response.json());
  await eventually(read, job => job.phase === 'npm');
  assert.equal((await app.post(`/api/jobs/${id}/cancel`, {}, 'wrong')).status, 403);
  assert.equal((await app.post(`/api/jobs/${id}/cancel`)).status, 202);
  const stopped = await eventually(read, job => job.status === 'cancelled');
  assert.equal(stopped.canResume, true);
  const env = await readFile(join(stopped.retainedPath, '.env'), 'utf8');
  const password = env.match(/DB_PASSWORD=(.*)/)[1];
  await app.server.shutdownTasks(); await new Promise(resolve => app.server.close(resolve));
  assert.equal((await readFile(join(stateDir, id + '.json'), 'utf8')).includes(password), false);
  app = await open();
  assert.equal((await read()).status, 'cancelled');
  assert.equal((await app.post(`/api/jobs/${id}/retry`, { name: 'changed', parentDir: '/untrusted' })).status, 202);
  const complete = await eventually(read, job => job.status === 'complete');
  assert.equal(complete.result.name, base.name);
  assert.equal(await readFile(join(complete.result.path, '.env'), 'utf8'), env);
  assert.equal(installs, 2);
});

test('a completed task stays complete while its final record is being saved', async () => {
  const jobs = new Jobs({ directory: false, check: async () => ({ canCreate: true }), generate: async () => ({ path: '/project' }) });
  await jobs.ready;
  let release, finalizing;
  const gate = new Promise(resolve => { release = resolve; });
  const finalRecord = new Promise(resolve => { finalizing = resolve; });
  jobs.store.save = async job => {
    if (job.status === 'complete') { finalizing(); await gate; }
  };
  const id = await jobs.create(base);
  await finalRecord;
  try {
    await assert.rejects(jobs.cancel(id), /这个任务没有在执行/);
    assert.equal(jobs.view(id).status, 'complete');
  } finally {
    release();
    await jobs.shutdown();
  }
  assert.equal(jobs.view(id).status, 'complete');
});

test('shutdown waits for a starting task to finish saving its cancelled state', async () => {
  let checks = 0;
  const jobs = new Jobs({ directory: false, check: async () => { checks++; return { canCreate: true }; } });
  await jobs.ready;
  let release, saving;
  const gate = new Promise(resolve => { release = resolve; });
  const firstSave = new Promise(resolve => { saving = resolve; });
  let writes = 0;
  jobs.store.save = async () => { if (++writes === 1) { saving(); await gate; } };
  const created = jobs.create(base);
  await firstSave;
  let closed = false;
  const closing = jobs.shutdown().then(() => { closed = true; });
  try {
    await delay(30);
    assert.equal(closed, false);
  } finally {
    release();
    await created;
    await closing;
    await jobs.shutdown();
  }
  assert.equal(jobs.view(await created).status, 'cancelled');
  assert.equal(checks, 0);
});

test('HTTP requests with unfinished bodies cannot create a job after shutdown starts', { timeout: 10000 }, async t => {
  const directory = await temp(t, 'stackforge-shutdown-');
  const app = createApp({ stateDir: false, check: async () => ({ canCreate: true }), generate: async () => ({ path: '/project' }) });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const url = `http://127.0.0.1:${app.address().port}`;
  const { token } = await (await fetch(url + '/api/state')).json();
  const accepted = once(app, 'request');
  const pending = request(url + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }
  });
  const response = once(pending, 'response');
  pending.write(' ');
  try {
    await accepted;
    await app.shutdownTasks();
  } finally {
    pending.end(JSON.stringify({ ...base, parentDir: directory }));
  }
  const [result] = await response;
  result.resume();
  assert.equal(result.statusCode, 409);
  assert.deepEqual(await (await fetch(url + '/api/jobs')).json(), []);
});

test('loading job history skips invalid timestamps and keeps valid records', async t => {
  const directory = await temp(t, 'stackforge-damaged-jobs-');
  const options = { ...base, parentDir: directory };
  const validId = randomUUID();
  const record = (id, createdAt) => writeFile(join(directory, id + '.json'), JSON.stringify({
    version: 1, job: { id, status: 'complete', createdAt, logs: [] }, options, checkpoint: {}
  }));
  await Promise.all([record(validId, '2026-01-01T00:00:00.000Z'), record(randomUUID()), record(randomUUID())]);
  assert.deepEqual((await new JobStore(directory).load()).map(item => item.job.id), [validId]);
});

test('publication retry retains the latest error after reloading a saved checkpoint', async t => {
  const parentDir = await temp(t, 'stackforge-publish-record-');
  const path = join(parentDir, base.name);
  await mkdir(path);
  const folderIdentity = directoryIdentity(await lstat(path, { bigint: true }));
  const jobs = new Jobs({ directory: false, publish: async () => { throw new Error('New publication failure'); } });
  await jobs.ready;
  const id = randomUUID();
  const previous = { path, remote: { status: 'failed', error: 'Old publication failure' } };
  jobs.records.set(id, {
    job: { id, status: 'complete', logs: [], result: structuredClone(previous) },
    options: { ...base, parentDir }, checkpoint: { folderIdentity, result: structuredClone(previous) }
  });
  await jobs.retry(id, true);
  await eventually(() => jobs.busy, busy => !busy);
  assert.equal(jobs.view(id).result.remote.error, 'New publication failure');
});

test('creation history verifies targets before desktop open and GitHub retry, including after relocation', async t => {
  const parentDir = await realpath(await temp(t, 'stackforge-history-identity-'));
  const stateDir = join(parentDir, 'state', 'jobs');
  const options = { ...base, parentDir, database: 'none', install: false };
  const checkpoint = {};
  const result = await generateProject(options, () => {}, { checkpoint, fetchImpl });
  result.remote = { status: 'failed', error: 'offline' };
  const store = new JobStore(stateDir);
  const record = { id: randomUUID(), status: 'complete', createdAt: new Date().toISOString(), logs: [], result };
  await store.save(record, options, checkpoint);
  const legacy = { ...options, name: 'legacy-app' };
  const legacyPath = join(parentDir, legacy.name);
  await mkdir(legacyPath);
  await cp(join(result.path, 'stackforge.json'), join(legacyPath, 'stackforge.json'));
  const legacyId = randomUUID();
  await store.save({ ...record, id: legacyId, result: { ...result, path: legacyPath } }, legacy, { promoted: true });

  const opened = [], published = [];
  const app = createApp({ stateDir, desktop: { capabilities: async () => ({}), shutdown() {},
    async openProject(path, action, verify) { await verify(); opened.push([path, action]); } },
    async publish(path, _options, _report, { verifyProject }) { await verifyProject(); published.push(path); return { status: 'published' }; }
  }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await app.shutdownTasks(); await new Promise(resolve => app.close(resolve)); });
  const url = 'http://127.0.0.1:' + app.address().port;
  const get = async path => (await fetch(url + path)).json();
  const { token } = await get('/api/state');
  const post = (path, body = {}) => fetch(url + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body) });
  const open = id => post('/api/jobs/' + id + '/open', { action: 'folder' });
  const retry = async id => {
    assert.equal((await post('/api/jobs/' + id + '/publish')).status, 202);
    await app.jobs.executions.get(id);
    return (await get('/api/jobs/' + id)).result.remote;
  };
  const assertRejected = async (id, reason) => {
    const reply = await open(id);
    assert.equal(reply.status, 400);
    assert.match((await reply.json()).error, reason);
    const remote = await retry(id);
    assert.equal(remote.status, 'failed');
    assert.match(remote.error, reason);
  };

  const moved = join(parentDir, 'moved-project');
  await rename(result.path, moved);
  await cp(moved, result.path, { recursive: true });
  await assertRejected(record.id, /missing or has been replaced/);
  await assertRejected(legacyId, /no recorded folder identity/);
  assert.deepEqual({ opened, published }, { opened: [], published: [] });

  const replacement = join(parentDir, 'original-path-copy');
  await rename(result.path, replacement);
  const imported = await post('/api/projects/import', { path: moved });
  assert.equal(imported.status, 201);
  assert.equal((await imported.json()).id, record.id);
  assert.equal((await get('/api/jobs/' + record.id)).result.path, moved);
  await rename(replacement, result.path);
  assert.equal((await open(record.id)).status, 200);
  assert.deepEqual(opened, [[moved, 'folder']]);

  const parked = join(parentDir, 'parked-project');
  await rename(moved, parked);
  await mkdir(moved);
  await assertRejected(record.id, /missing or has been replaced/);
  assert.deepEqual(opened, [[moved, 'folder']]);
  assert.deepEqual(published, []);
  await rename(moved, replacement);
  await rename(parked, moved);
  assert.equal((await retry(record.id)).status, 'published');
  assert.deepEqual(published, [moved]);
});

test('double-click launcher avoids an occupied port and reuses the same project server', async t => {
  const directory = await temp(t, 'stackforge-launch-');
  const occupied = createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port;
  const launched = await launch({ port, directory, open: false, appOptions: { stateDir: false } });
  if (launched.server) t.after(async () => { await launched.server.shutdownTasks(); await new Promise(resolve => launched.server.close(resolve)); });
  assert.notEqual(Number(new URL(launched.url).port), port);
  const second = await launch({ port, directory, open: false, appOptions: { stateDir: false } });
  assert.equal(second.reused, true);
  assert.equal(second.url, launched.url);
});

test('launcher refuses a second server from the same checkout while an older version is running', async t => {
  const directory = await temp(t, 'stackforge-old-launcher-');
  const older = createServer((req, res) => res.end(JSON.stringify({ ...identity, version: '0.0.1' })));
  await new Promise(resolve => older.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => older.close(resolve)));
  const port = older.address().port;
  await writeFile(join(directory, 'launcher.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
  let unexpected;
  try {
    await assert.rejects(async () => {
      unexpected = await launch({ port, directory, open: false, appOptions: { stateDir: false } });
    }, /another version from this checkout/i);
  } finally {
    if (unexpected?.server) {
      await unexpected.server.shutdownTasks();
      await new Promise(resolve => unexpected.server.close(resolve));
    }
  }
});

test('simultaneous launches on the same port start only one server', async t => {
  const directory = await temp(t, 'stackforge-concurrent-launch-');
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));

  const options = { port, directory, open: false, appOptions: { stateDir: false } };
  const launches = await Promise.allSettled([launch(options), launch(options)]);
  const started = launches.flatMap(result => result.value?.server ? [result.value.server] : []);
  t.after(() => Promise.all(started.map(async server => {
    await server.shutdownTasks();
    await new Promise(resolve => server.close(resolve));
  })));
  assert.deepEqual(launches.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.equal(started.length, 1);
  assert.equal(launches[0].value.url, launches[1].value.url);
});
