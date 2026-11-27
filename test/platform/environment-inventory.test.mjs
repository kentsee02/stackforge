import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectLocalTools, localEnvironmentInventory } from '../../src/platform/environment-inventory.mjs';

test('environment resolves effective paths, reports known minimums and classifies failed probes without exposing stderr', async () => {
  const devices = new Map([
    ['git', 'git.exe'], ['docker', 'docker.exe'], ['javac', 'javac.exe'], ['pnpm', 'pnpm.cmd'], ['bun', 'bun.exe'], ['gradle', 'gradle.exe'],
    ['python', 'python.exe'], ['python3', 'python3.exe'], ['dotnet', 'dotnet.exe'], ['mysql', 'mysql.exe'], ['sqlcmd', 'sqlcmd.exe']
  ].map(([tool, file]) => [tool, 'C:\\Tools\\' + file]));
  const calls = [];
  const npmPath = 'C:\\Node\\lib\\npm-cli.js';
  const nodePath = 'C:\\Node\\node.exe';
  const runInventory = localEnvironmentInventory({ platform: 'win32', architecture: 'x64', nodeVersion: '22.11.1', nodePath,
    env: { Path: 'C:\\Tools', ComSpec: 'C:\\Windows\\System32\\cmd.exe', DELIBERATE_TEST_ENV: 'hidden-value' },
    npm: () => ({ command: nodePath, prefix: [npmPath] }),
    find: async (name, options) => { assert.equal(options.cwd, undefined); return devices.get(name); },
    command: async (path, args, options) => {
      calls.push([path, args]);
      assert.equal(options.env.COREPACK_ENABLE_NETWORK, '0');
      assert.equal(options.env.GOTOOLCHAIN, 'local');
      assert.equal(options.env.RUSTUP_AUTO_INSTALL, '0');
      assert.ok(options.timeout > 0);
      if (path === nodePath) { assert.deepEqual(args, [npmPath, '--version']); return '10.9.0'; }
      if (path.endsWith('git.exe')) return 'git version 2.27.1.windows.1';
      if (path.endsWith('docker.exe')) return args.includes('compose') ? 'v2.30.2' : 'Docker version 28.1.1, build 123';
      if (path.endsWith('javac.exe')) return 'javac 21';
      if (path === options.env.ComSpec) {
        assert.equal(options.windowsVerbatimArguments, true);
        assert.equal(options.env.STACKFORGE_PROBE_BINARY, devices.get('pnpm'));
        assert.match(args.at(-1), /%STACKFORGE_PROBE_BINARY%/);
        return '10.2.1';
      }
      if (path.endsWith('python3.exe')) return 'Python 3.12.4';
      if (path.endsWith('dotnet.exe')) return '8.0.400 [C:\\SDKs]\n9.0.302 [C:\\SDKs]';
      if (path.endsWith('bun.exe')) return 'private-output-canary';
      if (path.endsWith('mysql.exe')) return 'mysql  Ver 15.1 Distrib 10.11.8-MariaDB, for Linux';
      if (path.endsWith('sqlcmd.exe') && args[0] === '-?') return 'Microsoft SQL Server Command Line Tool\nVersion 16.0.1000.6';
      throw new Error('private-error-canary');
    }
  });
  const first = runInventory();
  assert.equal(runInventory(), first, 'concurrent HTTP requests should share one inspection');
  const data = await first;
  const tool = id => data.tools.find(row => row.id === id);
  assert.deepEqual([tool('node').status, tool('node').path, tool('node').minimum], ['outdated', nodePath, '22.12']);
  assert.deepEqual([tool('npm').status, tool('npm').path], ['available', npmPath]);
  assert.deepEqual([tool('git').version, tool('git').status], ['2.27.1.windows.1', 'outdated']);
  assert.deepEqual([tool('docker').version, tool('docker-compose').version, tool('java').version], ['28.1.1', '2.30.2', '21']);
  assert.deepEqual([tool('pnpm').version, tool('python').path, tool('dotnet').version], ['10.2.1', devices.get('python3'), '9.0.302']);
  assert.equal(tool('mysql').version, '10.11.8-MariaDB');
  assert.equal(tool('sqlcmd').version, '16.0.1000.6');
  assert.equal(tool('yarn').status, 'missing');
  assert.equal(tool('bun').status, 'unverified');
  assert.equal(tool('gradle').status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(data), /hidden-value|private-error-canary|private-output-canary|C:\\\\SDKs/);
  assert.equal(calls.some(([, args]) => args.includes('info') || args.includes('auth') || args.includes('install')), false);
  assert.notEqual(runInventory(), first, 'a new check should inspect again');
  await runInventory();
});

test('Windows version probes use a literal path for an installed command shim', { skip: process.platform !== 'win32' }, async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'stackforge tools %temp% ! &-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const executable = join(folder, 'pnpm.cmd');
  await writeFile(executable, '@echo off\r\nif not "%1"=="--version" exit /b 8\r\necho 11.2.3\r\n');
  const result = await inspectLocalTools({ env: { ...process.env, PATH: folder, Path: folder },
    npm: () => ({ command: 'npm', prefix: [] }) });
  assert.deepEqual(result.tools.find(tool => tool.id === 'pnpm'), {
    id: 'pnpm', name: 'pnpm', group: 'toolchains', path: executable, version: '11.2.3', status: 'available'
  });
});
