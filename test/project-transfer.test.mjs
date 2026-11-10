import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { cloneGithub } from '../src/project-clone.mjs';
import { ProjectOperations } from '../src/project-operations.mjs';
import { ProjectConfig } from '../src/project-config.mjs';
import { detectFrameworks } from '../src/project-services.mjs';
import { createDesktop } from '../src/desktop.mjs';

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

test('GitHub clone detects frameworks and recycles only a verified cloned directory', async t => {
  const commands = [];
  const command = async (name, args) => {
    commands.push([name, args]);
    await mkdir(join(args.at(-1), '.git'), { recursive: true });
    await writeFile(join(args.at(-1), 'package.json'), '{"dependencies":{"react":"^19"},"scripts":{"test":"node --test"}}');
  };
  const desktop = { ...createDesktop(), trashProject: path => rename(path, path + '-recycled') };
  const { directory, post, get } = await fixture(t, {
    desktop, clone: (repo, parent, options) => cloneGithub(repo, parent, { ...options, command })
  });
  const clone = repository => post('/api/projects/clone', { repository, parentDir: directory });
  for (const url of ['https://github.com.evil.test/owner/demo', 'https://github.com/owner/..', 'file:///tmp/demo', 'https://user@github.com/owner/demo']) {
    assert.equal((await clone(url)).status, 409);
  }
  assert.deepEqual(commands, []);
  const response = await clone('https://github.com/owner/Demo.git');
  assert.equal(response.status, 201);
  const project = await response.json();
  assert.equal(project.unmanaged, true);
  assert.equal(project.external, false);
  assert.equal(project.cloned, true);
  assert.equal(project.cloneId, undefined);
  assert.equal(project.cloneIdentity, undefined);
  assert.equal(project.removeOnly, undefined);
  assert.deepEqual(project.frameworks, ['React']);
  assert.equal(project.name, 'Demo');
  assert.equal(commands[0][0], 'git');
  assert.equal(commands[0][1].at(-2), 'https://github.com/owner/Demo.git');
  assert.deepEqual(await readdir(directory), ['Demo']);
  assert.equal((await clone('https://github.com/owner/Demo')).status, 409);
  assert.equal(commands.length, 1);
  const route = `/api/projects/${project.id}`;
  assert.equal((await post(route + '/start')).status, 409);
  assert.deepEqual((await get(route + '/checks')).checks.map(check => check.id), ['root:test']);
  const confirm = { confirmName: project.name };
  assert.equal((await post(route + '/trash', { confirmName: 'wrong' })).status, 400);
  const marker = join(project.path, '.git', 'stackforge-clone');
  const original = await readFile(marker);
  await writeFile(marker, 'wrong');
  assert.equal((await post(route + '/trash', confirm)).status, 409);
  await access(join(project.path, 'package.json'));
  await writeFile(marker, original);
  const originalDirectory = join(directory, 'original-clone');
  const replacementDirectory = join(directory, 'replacement-directory');
  await rename(project.path, originalDirectory);
  await mkdir(join(project.path, '.git'), { recursive: true });
  await writeFile(marker, original);
  await writeFile(join(project.path, 'keep.txt'), 'replacement');
  assert.equal((await post(route + '/trash', confirm)).status, 409);
  assert.equal(await readFile(join(project.path, 'keep.txt'), 'utf8'), 'replacement');
  await rename(project.path, replacementDirectory);
  await rename(originalDirectory, project.path);
  const deleted = await post(route + '/trash', confirm);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { trashed: true, databaseDeleted: false });
  await assert.rejects(access(project.path), { code: 'ENOENT' });
  await access(join(project.path + '-recycled', 'package.json'));
  assert.equal((await post(route + '/trash', confirm)).status, 404);
  const clonedAgain = await clone('https://github.com/owner/Demo');
  assert.equal(clonedAgain.status, 201);
  assert.notEqual((await clonedAgain.json()).id, project.id);

  const local = await post('/api/projects/import', { path: project.path + '-recycled' });
  assert.equal(local.status, 201);
  const imported = await local.json();
  assert.deepEqual(imported.frameworks, ['React']);
  assert.equal(imported.cloned, undefined);
  assert.deepEqual(await post(`/api/projects/${imported.id}/trash`, { confirmName: imported.name }).then(response => response.json()), { removed: true });
  await access(join(imported.path, 'package.json'));
});

test('stale clone records can be replaced by a new clone or removed without touching the folder', async t => {
  const command = async (name, args) => {
    const checkout = args.at(-1);
    await mkdir(join(checkout, '.git'), { recursive: true });
    await writeFile(join(checkout, 'package.json'), '{"packageManager":"npm@11.0.0","scripts":{"dev":"node serve.js"}}');
  };
  const desktop = { ...createDesktop(), trashProject: () => assert.fail('The replacement directory must not be recycled') };
  const { directory, post, get } = await fixture(t, { desktop, clone: (repo, parent, options) => cloneGithub(repo, parent, { ...options, command }) });
  const clone = async () => {
    const response = await post('/api/projects/clone', { repository: 'https://github.com/owner/demo', parentDir: directory });
    assert.equal(response.status, 201);
    return response.json();
  };
  const first = await clone();
  await rename(first.path, join(directory, 'first-clone'));
  const second = await clone();
  assert.notEqual(second.id, first.id);
  assert.deepEqual((await get('/api/projects')).projects.map(project => project.id), [second.id]);

  await rename(second.path, join(directory, 'second-clone'));
  await mkdir(second.path);
  await writeFile(join(second.path, 'package.json'), '{"packageManager":"npm@11.0.0","scripts":{"dev":"node local.js"}}');
  await writeFile(join(second.path, 'keep.txt'), 'user file');
  const route = '/api/projects/' + second.id;
  const confirm = { confirmName: second.name };
  assert.match((await get(route + '/startup-suggestions')).error, /Remove it from Projects/);
  assert.equal((await post(route + '/trash', confirm)).status, 409);
  assert.equal((await post(route + '/remove', { confirmName: 'wrong' })).status, 400);
  const removed = await post(route + '/remove', confirm);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { removed: true });
  assert.equal(await readFile(join(second.path, 'keep.txt'), 'utf8'), 'user file');

  const imported = await post('/api/projects/import', { path: second.path });
  assert.equal(imported.status, 201);
  const local = await imported.json();
  assert.equal(local.cloned, undefined);
  assert.equal((await get('/api/projects/' + local.id + '/startup-suggestions')).groups[0].choices[0].command, 'npm run dev');
});

test('unrecognized directories can be imported and old external records acquire detected frameworks', async t => {
  const { directory, post } = await fixture(t);
  const folder = join(directory, 'local-folder');
  await mkdir(folder);
  await writeFile(join(folder, 'package.json'), '{}');
  const local = await post('/api/projects/import', { path: folder });
  assert.equal(local.status, 201);
  const project = await local.json();
  assert.equal(project.external, true);
  assert.deepEqual(project.frameworks, []);

  const front = join(folder, 'frontend');
  const backend = join(folder, 'backend');
  const workspace = join(folder, 'apps', 'java');
  const nestedWorkspace = join(folder, 'modules', 'dashboard', 'client');
  const deepWorkspace = join(folder, 'features', 'accounts', 'internal', 'app');
  const outside = join(directory, 'outside');
  await Promise.all([front, backend, workspace, nestedWorkspace, deepWorkspace, outside].map(path => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(join(front, 'package.json'), '{"dependencies":{"next":"^16","react":"^19"}}'),
    writeFile(join(backend, 'package.json'), '{"dependencies":{"@nestjs/core":"^12","express":"^5"}}'),
    writeFile(join(folder, 'package.json'), '{"workspaces":{"packages":["modules/*/client","./features/**","../outside"]}}'),
    writeFile(join(nestedWorkspace, 'package.json'), '{"dependencies":{"vue":"^3"}}'),
    writeFile(join(deepWorkspace, 'package.json'), '{"dependencies":{"@angular/core":"^21"}}'),
    writeFile(join(outside, 'package.json'), '{"dependencies":{"hono":"^4"}}'),
    writeFile(join(folder, 'pyproject.toml'), '[project]\ndependencies = [\n  "fastapi",\n  "django[argon2]>=5",\n]\n'),
    writeFile(join(workspace, 'pom.xml'), '<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId></parent></project>')
  ]);
  const expected = ['Angular', 'Django', 'FastAPI', 'NestJS', 'Next.js', 'Spring Boot', 'Vue'];
  assert.deepEqual((await detectFrameworks({ path: folder })).sort(), expected);
  const file = join(directory, 'projects.json');
  await writeFile(file, JSON.stringify({ version: 1, imports: [{ id: project.id, path: folder, external: true }] }));
  const saved = new ProjectConfig(file);
  await saved.ready;
  assert.equal(saved.value.imports[0].unmanaged, true);
  assert.deepEqual(saved.value.imports[0].frameworks.sort(), expected);
});

test('a local import rejects a replacement directory before any startup configuration exists', async t => {
  const { directory, base, post } = await fixture(t);
  const root = join(directory, 'local');
  const create = async () => {
    await mkdir(root);
    await writeFile(join(root, 'package.json'), '{"scripts":{"dev":"node dev.mjs","build":"node build.mjs"}}');
    await writeFile(join(root, 'package-lock.json'), '{}');
  };
  await create();
  const response = await post('/api/projects/import', { path: root });
  assert.equal(response.status, 201);
  const { id, name } = await response.json();
  const route = `/api/projects/${id}`;
  assert.equal((await fetch(base + route + '/dependencies')).status, 200);
  await rename(root, root + '-original');
  await create();
  for (const view of ['dependencies', 'startup-suggestions', 'checks', 'git']) {
    const rejected = await fetch(base + route + '/' + view);
    assert.equal(rejected.status, 409, view);
    assert.match((await rejected.json()).error, /moved or replaced/);
  }
  const config = await post(route + '/startup', { services: [{ name: 'API', directory: '.', command: 'node dev.mjs' }] });
  assert.equal(config.status, 400);
  assert.match((await config.json()).error, /moved or replaced/);
  assert.equal((await post(route + '/remove', { confirmName: name })).status, 200);
  await access(join(root, 'package.json'));
});

test('database transfer locks the project, preserves binary output and requires an empty target', async t => {
  const dump = Buffer.from([80, 71, 68, 77, 80, 0, 255]);
  const name = 'backup-fixture';
  const volume = `${name}_data`, target = '/var/lib/postgresql/data', databaseId = '1234567890abcdef12345678';
  let directory;
  let isEmpty = false, restores = 0, sqlReady = false, mountName = volume;
  let releaseBackup;
  const backupGate = new Promise(resolve => { releaseBackup = resolve; });
  let markBackupStarted;
  const backupStarted = new Promise(resolve => { markBackupStarted = resolve; });
  const operations = new ProjectOperations({ command: async (command, args, options) => {
    assert.equal(command, 'docker');
    if (args[1] === 'config') return JSON.stringify({ name, services: { db: {
      volumes: [{ type: 'volume', source: 'data', target }]
    } }, volumes: { data: { name: volume } } });
    if (args[0] === 'compose' || args[0] === 'ps') return 'abcdef123456\n';
    if (args[0] === 'inspect') {
      const mounts = [{ Type: 'volume', Name: mountName, Destination: target, RW: true }];
      return `${JSON.stringify(directory)}\tdb\trunning\thealthy\t${JSON.stringify(mounts)}\n`;
    }
    if (args[0] === 'volume' && args[1] === 'ls') return volume;
    if (args[0] === 'volume' && args[1] === 'inspect') return ['null', JSON.stringify({
      'com.docker.compose.project': name, 'com.docker.compose.volume': 'data', 'io.stackforge.database-id': databaseId
    }), '"local"', 'null'].join('\t');
    if (args.includes('stackforge')) return isEmpty ? 't\n' : 'f\n';
    if (args.at(-1).includes('SELECT 1')) return sqlReady ? '1' : '';
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
    assert.fail(args[0]);
  } });
  const app = await fixture(t, { operations });
  directory = join(app.directory, name);
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'compose.yaml'), 'services: {}'),
    writeFile(join(directory, 'scripts/dev.mjs'), ''),
    writeFile(join(directory, 'stackforge.json'), JSON.stringify({
      generator: 'StackForge', databaseId, options: { name, frontend: 'none', backend: 'express', database: 'postgres' }
    }))
  ]);
  const imported = await app.post('/api/projects/import', { path: directory });
  assert.equal(imported.status, 201);
  const { id } = await imported.json();
  const route = `/api/projects/${id}`;
  assert.equal((await app.post(route + '/database-backup', {}, { Origin: 'https://example.com' })).status, 403);
  const starting = await app.post(route + '/database-backup');
  assert.equal(starting.status, 409);
  assert.match((await starting.json()).error, /SQL is not ready/);
  sqlReady = true;
  mountName = 'unrelated-volume';
  const unverified = await app.post(route + '/database-backup');
  assert.equal(unverified.status, 409);
  assert.match((await unverified.json()).error, /could not be verified/);
  mountName = volume;
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
