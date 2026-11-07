import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Settings } from '../src/settings.mjs';
import { createDesktop } from '../src/desktop.mjs';
import { createApp } from '../src/server.mjs';
import { run } from '../src/process.mjs';

const directoryInfo = { isDirectory: () => true, isSymbolicLink: () => false };
const windowsPath = "C:\\Projects\\研发 & O'Brien\\demo";
function windows(overrides = {}) {
  return createDesktop({
    platform: 'win32', env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\Dev\\AppData\\Local', PATH: 'C:\\Code\\bin' },
    fileExists: async file => /powershell\.exe$|explorer\.exe$|\\Code\.exe$|\\code\.cmd$/i.test(file),
    statDirectory: async () => directoryInfo, lstatDirectory: async () => directoryInfo,
    ...overrides
  });
}

test('directory preferences survive restart, keep five unique recent folders, and clear paths when disabled', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'stackforge-settings-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const file = join(temporary, 'settings.json'), settings = new Settings(file, { platform: 'win32' });
  await settings.ready;
  await Promise.all(Array.from({ length: 7 }, (_, i) => settings.save({ rememberDirectory: true, directory: 'D:\\Code\\Folder ' + i })));
  await settings.save({ rememberDirectory: true, directory: 'D:\\Code\\Folder 3', token: 'do-not-store', publish: true });
  const restored = new Settings(file, { platform: 'win32' }); await restored.ready;
  assert.equal(restored.value.directory, 'D:\\Code\\Folder 3');
  assert.equal(restored.value.recentDirectories.length, 5);
  assert.equal(new Set(restored.value.recentDirectories).size, 5);
  assert.equal((await readFile(file, 'utf8')).includes('do-not-store'), false);
  await restored.save({ rememberDirectory: false });
  assert.deepEqual(restored.value, { rememberDirectory: false, recentDirectories: [] });
  assert.equal((await readFile(file, 'utf8')).includes('Folder'), false);
  await assert.rejects(restored.save({ rememberDirectory: true, directory: '..\\relative' }), /absolute/);
});

test('damaged preference files fall back to the default without blocking startup', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'stackforge-settings-bad-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const file = join(temporary, 'settings.json'); await writeFile(file, '{broken');
  const settings = new Settings(file); await settings.ready;
  assert.deepEqual(settings.value, { rememberDirectory: true, recentDirectories: [] });
});

test('Windows opens use executable arguments or fixed encoded scripts, never interpolate the project path', async () => {
  const calls = [];
  const record = async (...args) => calls.push(args);
  const desktop = windows({ launch: record, command: record });
  assert.deepEqual(await desktop.capabilities(), { picker: true, folder: true, vscode: true, terminal: true });
  for (const action of ['folder', 'vscode', 'terminal']) await desktop.openProject(windowsPath, action);
  assert.deepEqual(calls[0][1], [windowsPath]);
  assert.deepEqual(calls[1][1], ['--new-window', windowsPath]);
  assert.equal(calls[1][0], 'C:\\Code\\Code.exe');
  const start = Buffer.from(calls[2][1].at(-1), 'base64').toString('utf16le');
  assert.match(start, /Start-Process.*'-NoExit'.*-WindowStyle Normal/);
  assert.equal(start.includes(windowsPath), false);
  const script = Buffer.from(start.match(/'-EncodedCommand', '([^']+)'/)[1], 'base64').toString('utf16le');
  assert.match(script, /Set-Location -LiteralPath/);
  assert.equal(script.includes(windowsPath), false);
  assert.equal(calls[2][2].env.STACKFORGE_OPEN_PATH, windowsPath);
  await assert.rejects(desktop.openProject(windowsPath, 'terminal; bad'), /Unsupported/);
  assert.equal(calls.length, 3);
});

test('the native picker preserves Unicode paths, starts at an existing parent and treats cancellation normally', async () => {
  const calls = [];
  const desktop = windows({
    statDirectory: async path => { if (path.endsWith('\\missing')) throw new Error('missing'); return directoryInfo; },
    command: async (...args) => { calls.push(args); return JSON.stringify({ path: windowsPath }); }
  });
  assert.equal(await desktop.pickDirectory('C:\\Projects\\missing', { language: 'zh-CN' }), windowsPath);
  assert.equal(calls[0][2].env.STACKFORGE_PICKER_PATH, 'C:\\Projects');
  assert.equal(calls[0][2].env.STACKFORGE_PICKER_TITLE, '选择新项目的保存父目录');
  assert.equal(calls[0][2].stdoutOnly, true);
  const script = Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le');
  assert.equal(script.includes(windowsPath), false);
  assert.equal(await windows({ command: async () => '{"path":null}' }).pickDirectory('C:\\Projects'), null);
});

test('structured desktop output stays separate from stderr diagnostics', async () => {
  const output = await run(process.execPath, ['-e', 'process.stderr.write("diagnostic\\n"); process.stdout.write(JSON.stringify({ path: "\u7814\u53d1" }));'], { stdoutOnly: true });
  assert.deepEqual(JSON.parse(output), { path: '研发' });
});

test('a second folder picker is refused and shutdown aborts the first one', async () => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const desktop = windows({ command: async (name, args, { signal }) => new Promise((resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
  }) });
  const picking = desktop.pickDirectory('C:\\Projects');
  const stopped = assert.rejects(picking, { name: 'AbortError' });
  await ready; await assert.rejects(desktop.pickDirectory('C:\\Projects'), /already open/);
  desktop.shutdown(); await stopped;
});

test('desktop actions refuse replaced project directories and clearly report missing applications', async () => {
  let launched = false;
  await assert.rejects(windows({ lstatDirectory: async () => ({ ...directoryInfo, isSymbolicLink: () => true }), launch: async () => { launched = true; } }).openProject(windowsPath, 'folder'), /replaced/);
  await assert.rejects(windows({ fileExists: async () => false }).openProject(windowsPath, 'vscode'), /not found/);
  assert.equal(launched, false);
});

test('macOS and Linux desktop branches pass paths as data and Linux picker cancellation is not an error', async () => {
  const path = "/home/dev/研发 & O'Brien/demo", calls = [];
  const linux = createDesktop({ platform: 'linux', env: { PATH: '/usr/bin' }, fileExists: async file => ['/usr/bin/code', '/usr/bin/xdg-open', '/usr/bin/zenity', '/usr/bin/gnome-terminal'].includes(file), lstatDirectory: async () => directoryInfo, statDirectory: async () => directoryInfo, launch: async (...args) => calls.push(args), command: async (...args) => { calls.push(args); if (args[0].endsWith('zenity')) throw Object.assign(new Error('cancelled'), { exitCode: 1 }); return ''; } });
  for (const action of ['folder', 'vscode', 'terminal']) await linux.openProject(path, action);
  assert.deepEqual(calls[0][1], [path]);
  assert.deepEqual(calls[2][1], ['--working-directory', path]);
  assert.equal(await linux.pickDirectory(path), null);
  const mac = createDesktop({ platform: 'darwin', env: { PATH: '/usr/bin' }, fileExists: async file => ['/usr/bin/open', '/usr/bin/osascript', '/usr/bin/code'].includes(file), lstatDirectory: async () => directoryInfo, command: async (...args) => calls.push(args) });
  await mac.openProject(path, 'terminal');
  const last = calls.at(-1);
  assert.equal(last[1].at(-1), path);
  assert.equal(last[1][1].includes(path), false);
  assert.match(last[1][1], /quoted form/);
});

test('recycle adapters pass only the recorded path and reject roots, symlinks and unsupported systems', async () => {
  const calls = [];
  const command = async (...args) => calls.push(args);
  const path = "/home/dev/研发 & O'Brien/demo";
  await windows({ command }).trashProject(windowsPath);
  assert.equal(calls[0][2].env.STACKFORGE_TRASH_PATH, windowsPath);
  assert.equal(Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le').includes(windowsPath), false);
  await assert.rejects(windows({ command }).trashProject('C:\\'), /safely recycled/);
  const options = { env: { PATH: '/usr/bin' }, fileExists: async file => file === '/usr/bin/gio', lstatDirectory: async () => directoryInfo, command };
  await createDesktop({ ...options, platform: 'linux' }).trashProject(path);
  assert.deepEqual(calls[1][1], ['trash', '--', path]);
  await createDesktop({ ...options, platform: 'darwin' }).trashProject(path);
  assert.equal(calls[2][1].at(-1), path);
  await assert.rejects(createDesktop({ ...options, platform: 'linux', lstatDirectory: async () => ({ ...directoryInfo, isSymbolicLink: () => true }) }).trashProject(path), /safely recycled/);
  await assert.rejects(createDesktop({ ...options, platform: 'linux', fileExists: async () => false }).trashProject(path), /system trash did not accept/);
  const changed = { ...directoryInfo, dev: 4n, ino: 7n, birthtimeNs: 8n };
  await assert.rejects(createDesktop({ ...options, platform: 'linux', lstatDirectory: async () => changed })
    .trashProject(path, { dev: '4', ino: '6', birth: '8' }), /original StackForge clone/);
  assert.equal(calls.length, 3);
});

test('desktop and preference APIs require authorization and open only the project recorded by the completed task', async t => {
  const parentDir = resolve(tmpdir(), 'desktop-api-parent'), expected = join(parentDir, 'desktop-api-app');
  const opened = [], picked = [];
  const desktop = { capabilities: async () => ({ picker: true, folder: true, vscode: false, terminal: true }), pickDirectory: async path => { picked.push(path); return parentDir; }, openProject: async (...args) => opened.push(args), shutdown: () => {} };
  const server = createApp({ stateDir: false, desktop, check: async () => ({ canCreate: true, checks: [] }), generate: async () => ({ path: expected, commands: ['npm run dev'] }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.shutdownTasks(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port, state = await (await fetch(url + '/api/state')).json();
  const post = (path, body, token = state.token, origin = url) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token, Origin: origin }, body: JSON.stringify(body) });
  for (const path of ['/api/desktop/pick-directory', '/api/preferences', '/api/jobs/missing/open']) assert.equal((await post(path, {}, 'wrong')).status, 403);
  assert.equal((await post('/api/desktop/pick-directory', { initialDir: parentDir }, state.token, 'https://elsewhere.invalid')).status, 403);
  assert.equal(picked.length, 0);
  assert.equal((await post('/api/desktop/pick-directory', { initialDir: parentDir })).status, 200);
  assert.equal(picked[0], parentDir);
  assert.equal((await post('/api/preferences', { rememberDirectory: true, directory: parentDir })).status, 200);
  assert.equal((await (await fetch(url + '/api/state')).json()).preferences.directory, parentDir);
  const response = await post('/api/projects', { name: 'desktop-api-app', parentDir, frontend: 'vue', backend: 'none', database: 'none', install: false, git: false });
  const { id } = await response.json(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post('/api/jobs/' + id + '/open', { action: 'folder', path: '/attacker/controlled' })).status, 200);
  assert.deepEqual(opened, [[expected, 'folder']]);
  assert.equal((await post('/api/jobs/missing/open', { action: 'folder' })).status, 404);
});
