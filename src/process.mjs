import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function cancelled() {
  const error = new Error('任务已取消，已完成的文件和步骤会保留。');
  error.name = 'AbortError';
  return error;
}

export function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelled();
}

export async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('close', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
}

export function run(command, args, { cwd, env = process.env, log = () => {}, timeout = 600_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let stopped;
    let killing;
    const collect = chunk => {
      const value = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '');
      tail = (tail + value).slice(-4000);
      log(value);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const stop = error => {
      if (stopped) return;
      stopped = error;
      killing = terminateTree(child);
    };
    const abort = () => stop(cancelled());
    const timer = setTimeout(() => stop(new Error(`${command} 执行超时，请检查网络后重试。`)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { clean(); reject(stopped ?? new Error(`无法执行 ${command}：${error.message}`)); });
    child.on('close', async code => {
      clean();
      if (killing) await killing;
      if (stopped) reject(stopped);
      else if (code === 0) resolve(tail);
      else reject(new Error(`${command} 退出码 ${code}\n${tail}`));
    });
    if (signal?.aborted) abort();
  });
}

export function npmCommand() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(p => p?.endsWith('npm-cli.js') && existsSync(p));
  if (cli) return { command: process.execPath, prefix: [cli] };
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  throw new Error('找不到 npm-cli.js。请使用官方 Node.js LTS 安装包（含 npm）。');
}

export function npm(args, options) {
  const { command, prefix } = npmCommand();
  return run(command, [...prefix, ...args], options);
}
