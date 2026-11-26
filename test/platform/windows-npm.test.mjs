import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { npm } from '../../src/platform/process.mjs';

const windowsOnly = { skip: process.platform !== 'win32', timeout: 45000 };

test('Windows npm preserves normal output, arguments and exit status, and can cancel at spawn', windowsOnly, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'stackforge npm 准备-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { echo: 'node fixture.mjs', fail: 'node fixture.mjs fail' } }));
  await writeFile(join(cwd, 'fixture.mjs'), `
    const args = process.argv.slice(2);
    console.log(JSON.stringify(args));
    if (args[0] === 'fail') process.exitCode = 7;
  `);
  const args = ['run', 'echo', '--', 'two words', '华文', 'final\\'];
  const standard = await npm(args, { cwd, stdoutOnly: true });
  const signal = new AbortController().signal;
  assert.equal(await npm(args, { cwd, signal, stdoutOnly: true }), standard);
  await assert.rejects(npm(['run', 'fail'], { cwd, signal }), { exitCode: 7 });
  const pending = new AbortController();
  await assert.rejects(npm(['run', 'echo'], { cwd, signal: pending.signal, onSpawn: () => pending.abort() }), { name: 'AbortError' });
});

test('Windows npm cancels a growing process tree without stopping another active job', windowsOnly, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-npm-tree-')));
  const first = new AbortController(), second = new AbortController();
  const running = [];
  t.after(async () => {
    first.abort(); second.abort();
    await Promise.allSettled(running);
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { tree: 'node tree.mjs launch' } }));
  await writeFile(join(cwd, 'tree.mjs'), `
    import { spawn } from 'node:child_process';
    import { appendFileSync, writeFileSync } from 'node:fs';
    const [mode, tag] = process.argv.slice(2);
    if (mode === 'launch') {
      writeFileSync(tag + '.launch', String(process.pid));
      const child = spawn(process.execPath, [import.meta.filename, 'middle', tag], { stdio: 'inherit', windowsHide: true });
      child.unref();
      setTimeout(() => {}, 12000);
    } else if (mode === 'middle') {
      writeFileSync(tag + '.middle', String(process.pid));
      const child = spawn(process.execPath, [import.meta.filename, 'leaf', tag], { stdio: 'inherit', windowsHide: true });
      child.unref();
      if (tag === 'first') {
        let remaining = 10;
        const launching = setInterval(() => {
          const extra = spawn(process.execPath, [import.meta.filename, 'extra', tag], { stdio: 'ignore', windowsHide: true });
          appendFileSync(tag + '.children', String(extra.pid) + '\\n');
          extra.unref();
          if (--remaining === 0) clearInterval(launching);
        }, 35);
      }
      setTimeout(() => {}, 12000);
    } else if (mode === 'leaf') {
      writeFileSync(tag + '.leaf', String(process.pid));
      const timer = setInterval(() => appendFileSync(tag + '.heartbeat', '.'), 25);
      setTimeout(() => clearInterval(timer), 12000);
    } else {
      setTimeout(() => {}, 12000);
    }
  `);
  const result = (tag, controller) => {
    const promise = npm(['run', 'tree', '--', tag], { cwd, signal: controller.signal, timeout: 22000 });
    running.push(promise);
    promise.catch(() => {});
    return promise;
  };
  const firstRun = result('first', first), secondRun = result('second', second);
  const healthy = async tag => {
    for (let i = 0; i < 100; i++) {
      const heartbeat = await readFile(join(cwd, tag + '.heartbeat'), 'utf8').catch(() => '');
      if (heartbeat.length >= 3) return heartbeat.length;
      await delay(50);
    }
    assert.fail(tag + ' descendant did not start');
  };
  const alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const pids = tag => Promise.all(['.launch', '.middle', '.leaf'].map(async suffix => Number(await readFile(join(cwd, tag + suffix), 'utf8'))));
  await Promise.all([healthy('first'), healthy('second')]);
  const firstPids = await pids('first');
  const secondPids = await pids('second');
  first.abort();
  await assert.rejects(firstRun, { name: 'AbortError' });
  const extra = (await readFile(join(cwd, 'first.children'), 'utf8')).trim().split('\n').map(Number);
  assert.ok(extra.length > 0 && [...firstPids, ...extra].every(pid => !alive(pid)));
  assert.ok(secondPids.every(alive));
  const before = await healthy('second');
  await delay(150);
  assert.ok(await healthy('second') > before);
  second.abort();
  await assert.rejects(secondRun, { name: 'AbortError' });
  assert.ok(secondPids.every(pid => !alive(pid)));
});
