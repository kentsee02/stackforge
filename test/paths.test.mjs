import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProjectsDirectory } from '../src/paths.mjs';
import { createApp } from '../src/server.mjs';

test('default project folders live in the user home on Windows, macOS and Linux', () => {
  for (const [platform, home, expected] of [
    ['win32', 'C:\\Users\\Alex', 'C:\\Users\\Alex\\Projects'],
    ['win32', 'D:\\Profiles\\Alex Dev', 'D:\\Profiles\\Alex Dev\\Projects'],
    ['darwin', '/Users/alex', '/Users/alex/Projects'],
    ['linux', '/home/alex', '/home/alex/Projects']
  ]) assert.equal(defaultProjectsDirectory({ platform, home, configured: '' }), expected);
});

test('custom default directories require absolute paths and support another drive or network share', () => {
  const windows = { platform: 'win32', home: 'C:\\Users\\Alex' };
  assert.equal(defaultProjectsDirectory({ ...windows, configured: 'D:\\Development\\Projects' }), 'D:\\Development\\Projects');
  assert.equal(defaultProjectsDirectory({ ...windows, configured: '\\\\fileserver\\team\\Code' }), '\\\\fileserver\\team\\Code');
  assert.equal(defaultProjectsDirectory({ platform: 'linux', home: '/home/alex', configured: '/mnt/code' }), '/mnt/code');
  for (const configured of ['relative/projects', '../projects', 'C:projects', '\\Code', '/Code', '\\\\fileserver', 'D:\\Code\0bad']) assert.throws(() => defaultProjectsDirectory({ ...windows, configured }), /absolute/);
  assert.throws(() => defaultProjectsDirectory({ platform: 'linux', home: '/home/alex', configured: '../code' }), /absolute/);
  assert.equal(defaultProjectsDirectory({ ...windows, configured: '  ' }), 'C:\\Users\\Alex\\Projects');
  assert.throws(() => defaultProjectsDirectory({ platform: 'linux', home: 'unknown', configured: '' }), /home directory/);
});

test('the browser state API receives the configured project directory without creating a project', async t => {
  let generated = false;
  const defaultDir = defaultProjectsDirectory({ platform: 'win32', home: 'C:\\Users\\Alex', configured: 'D:\\Code' });
  const server = createApp({ defaultDir, stateDir: false, generate: async () => { generated = true; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const state = await (await fetch(`http://127.0.0.1:${server.address().port}/api/state`)).json();
  assert.equal(state.defaultDir, 'D:\\Code');
  assert.equal(generated, false);
});
