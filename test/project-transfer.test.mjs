import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { cloneGithub } from '../src/project-clone.mjs';
import { ProjectOperations } from '../src/project-operations.mjs';

async function fixture(t, options) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-transfer-')));
  const app = createApp({ stateDir: false, ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    await app.shutdownTasks();
    await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const get = async path => (await fetch(base + path)).json();
  const { token } = await get('/api/state');
  const post = (path, body = {}, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token, ...headers }, body: JSON.stringify(body)
  });
  return { directory, base, token, post, get };
}

test('GitHub clone validates the remote and registers external projects without deleting their files', async t => {
  const commands = [];
  const command = async (name, args) => {
    commands.push([name, args]);
    await mkdir(join(args.at(-1), '.git'), { recursive: true });
    await writeFile(join(args.at(-1), 'package.json'), '{"scripts":{"test":"node --test"}}');
  };
  const { directory, post, get } = await fixture(t, { clone: (repo, parent, options) => cloneGithub(repo, parent, { ...options, command }) });
  const clone = repository => post('/api/projects/clone', { repository, parentDir: directory });
  for (const url of ['https://github.com.evil.test/owner/demo', 'https://github.com/owner/..', 'file:///tmp/demo', 'https://user@github.com/owner/demo']) {
    assert.equal((await clone(url)).status, 409);
  }
  assert.deepEqual(commands, []);
  const response = await clone('https://github.com/owner/Demo.git');
  assert.equal(response.status, 201);
  const project = await response.json();
  assert.equal(project.external, true);
  assert.equal(project.name, 'Demo');
  assert.equal(commands[0][0], 'git');
  assert.equal(commands[0][1].at(-2), 'https://github.com/owner/Demo.git');
  assert.deepEqual(await readdir(directory), ['Demo']);
  assert.equal((await clone('https://github.com/owner/Demo')).status, 409);
  assert.equal(commands.length, 1);
  const route = `/api/projects/${project.id}`;
  assert.equal((await post(route + '/start')).status, 409);
  assert.deepEqual((await get(route + '/checks')).checks.map(check => check.id), ['root:test']);
  assert.equal((await post(route + '/trash', { confirmName: project.name })).status, 200);
  await access(join(project.path, '.git'));
  assert.equal(await readFile(join(project.path, 'package.json'), 'utf8'), '{"scripts":{"test":"node --test"}}');
  const local = await post('/api/projects/import', { path: project.path });
  assert.equal(local.status, 201);
  assert.equal((await local.json()).external, true);
});

test('database transfer locks the project, preserves binary output and requires an empty target', async t => {
  const dump = Buffer.from([80, 71, 68, 77, 80, 0, 255]);
  const name = 'backup-fixture';
  let directory;
  let isEmpty = false, restores = 0;
  let releaseBackup;
  const backupGate = new Promise(resolve => { releaseBackup = resolve; });
  let markBackupStarted;
  const backupStarted = new Promise(resolve => { markBackupStarted = resolve; });
  const operations = new ProjectOperations({ command: async (command, args, options) => {
    assert.equal(command, 'docker');
    if (args[0] === 'compose') return 'abcdef123456\n';
    if (args[0] === 'inspect') return `${JSON.stringify(directory)}\tdb\trunning\thealthy\n`;
    if (args.includes('-i')) {
      restores++;
      assert.deepEqual(options.input, dump);
      assert.match(args.at(-1), /--single-transaction/);
      return '';
    }
    if (options.binaryLimit) {
      markBackupStarted();
      await backupGate;
      return dump;
    }
    return isEmpty ? 't\n' : 'f\n';
  } });
  const app = await fixture(t, { operations });
  directory = join(app.directory, name);
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'compose.yaml'), 'services: {}'),
    writeFile(join(directory, 'scripts/dev.mjs'), ''),
    writeFile(join(directory, 'stackforge.json'), JSON.stringify({
      generator: 'StackForge', options: { name, frontend: 'none', backend: 'express', database: 'postgres' }
    }))
  ]);
  const imported = await app.post('/api/projects/import', { path: directory });
  assert.equal(imported.status, 201);
  const { id } = await imported.json();
  const route = `/api/projects/${id}`;
  assert.equal((await app.post(route + '/database-backup', {}, { Origin: 'https://example.com' })).status, 403);
  const backup = app.post(route + '/database-backup');
  try {
    await Promise.race([backupStarted, backup.then(() => assert.fail('Backup ended before Docker ran'))]);
    assert.equal((await app.post(route + '/start')).status, 409);
    assert.equal((await app.post(route + '/trash', { confirmName: name })).status, 409);
  } finally { releaseBackup(); }
  const download = await backup;
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /pg\.dump/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), dump);
  const restore = (confirmName, data = dump) => fetch(app.base + route + '/database-restore', {
    method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream', 'X-StackForge-Token': app.token, 'X-StackForge-Confirm-Name': confirmName }
  });
  assert.equal((await restore('wrong')).status, 400);
  assert.equal((await restore(name, Buffer.from('other format'))).status, 409);
  assert.equal((await restore(name)).status, 409);
  assert.equal(restores, 0);
  isEmpty = true;
  assert.equal((await restore(name)).status, 200);
  assert.equal(restores, 1);
});
