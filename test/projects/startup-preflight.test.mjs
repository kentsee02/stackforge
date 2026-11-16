import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directoryIdentity } from '../../src/platform/project-identity.mjs';
import { startupPreflight } from '../../src/projects/project-preflight.mjs';

test('startup preflight checks service evidence without exposing paths, commands, or secrets', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-preflight-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'project');
  const web = join(path, 'web');
  await mkdir(web, { recursive: true });
  const identity = directoryIdentity(await lstat(path, { bigint: true }));
  await writeFile(join(path, '.env'), 'DATABASE_URL=postgresql://portal:private-password@localhost/portal\n');
  const project = { path, unmanaged: true, folderIdentity: identity, startup: { services: [
    { name: 'Web', directory: 'web', command: 'bun private-argument', port: 3174 },
    { name: 'Worker', directory: '.', command: './worker.sh' },
    { name: 'API', directory: 'removed', command: 'node server.mjs' }
  ] } };
  const lookups = [];
  let status = 'stopped';
  let probes = 0;
  const dependencies = {
    runtime: { status: () => ({ status, diagnostic: 'dependencies' }) },
    operations: { status: () => ({}) },
    findTool(name, { cwd }) { lookups.push([name, cwd]); },
    probePort(port) { assert.equal(port, 3174); probes++; return false; }
  };
  const result = await startupPreflight(project, dependencies);
  assert.deepEqual(lookups, [['bun', web]]);
  const item = code => result.items.find(row => row.code === code);
  assert.equal(item('tool-missing').status, 'attention');
  assert.equal(item('command-unverified').service, 'Worker');
  assert.equal(item('working-directory-invalid').directory, 'removed');
  assert.equal(item('port-in-use').service, 'Web');
  assert.equal(item('dependencies-missing').action, 'dependencies');
  assert.equal(item('database-configured').status, 'unverified');
  assert.doesNotMatch(JSON.stringify(result), /private-(?:argument|password)|worker\.sh|stackforge-preflight-/);

  status = 'running';
  const running = await startupPreflight(project, dependencies);
  assert.equal(running.items.find(row => row.code === 'port-active').status, 'unverified');
  assert.equal(probes, 1);

  await rename(path, join(root, 'original'));
  await mkdir(path);
  assert.deepEqual(await startupPreflight(project, dependencies), {
    items: [{ code: 'folder-changed', status: 'attention', action: 'import' }]
  });
});
