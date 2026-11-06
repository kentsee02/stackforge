import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, stat, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { generateProject } from '../src/generator.mjs';
import { createApp } from '../src/server.mjs';
import { run, cancelled } from '../src/process.mjs';
import { launch } from '../scripts/launcher.mjs';

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

test('double-click launcher avoids an occupied port and reuses the same project server', async t => {
  const directory = await temp(t, 'stackforge-launch-');
  const occupied = createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port;
  const launched = await launch({ port, directory, open: false, appOptions: { stateDir: false } });
  t.after(async () => { await launched.server.shutdownTasks(); await new Promise(resolve => launched.server.close(resolve)); });
  assert.notEqual(Number(new URL(launched.url).port), port);
  const second = await launch({ port, directory, open: false, appOptions: { stateDir: false } });
  assert.equal(second.reused, true);
  assert.equal(second.url, launched.url);
});
