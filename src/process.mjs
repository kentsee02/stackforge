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

export function run(command, args, { cwd, env = process.env, log = () => {}, timeout = 600_000, signal, stdoutOnly = false, stdoutLimit = 4000, input, binaryLimit, shell = false, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (onSpawn) child.once('spawn', onSpawn);
    let tail = '';
    let stdout = '';
    let stopped;
    let killing;
    const collect = chunk => {
      const value = chunk.replace(/\x1b\[[0-9;]*m/g, '');
      tail = (tail + value).slice(-4000);
      log(value);
    };
    const stop = error => {
      if (stopped) return;
      stopped = error;
      killing = terminateTree(child);
    };
    const binary = [];
    let size = 0;
    if (binaryLimit) {
      child.stdout.on('data', chunk => {
        if (stopped) return;
        size += chunk.length;
        if (size > binaryLimit) stop(Object.assign(new Error('The database backup exceeds the 64 MiB limit.'), { code: 'OUTPUT_LIMIT' }));
        else binary.push(chunk);
      });
    } else {
      child.stdout.setEncoding('utf8').on('data', chunk => {
        if (stdoutOnly) stdout = (stdout + chunk).slice(-stdoutLimit);
        collect(chunk);
      });
    }
    child.stderr.setEncoding('utf8').on('data', collect);
    let inputError;
    if (input) {
      child.stdin.once('error', error => { inputError = error; });
      child.stdin.end(input);
    }
    const abort = () => stop(cancelled());
    const timer = timeout > 0 ? setTimeout(() => stop(new Error(`${command} 执行超时，请检查网络后重试。`)), timeout) : undefined;
    signal?.addEventListener('abort', abort, { once: true });
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { clean(); reject(stopped ?? new Error(`无法执行 ${command}：${error.message}`)); });
    child.on('close', async code => {
      clean();
      if (killing) await killing;
      if (stopped) reject(stopped);
      else if (code === 0 && inputError) reject(inputError);
      else if (code === 0) resolve(binaryLimit ? Buffer.concat(binary, size) : stdoutOnly ? stdout : tail);
      else reject(Object.assign(new Error(`${command} 退出码 ${code}\n${tail}`), { exitCode: code }));
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

export function installNodeDependencies(options, command = npm) {
  return command(['install', '--no-audit', '--no-fund'], options);
}

export function maven(args, options, command = run) {
  return process.platform === 'win32'
    ? command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `mvnw.cmd ${args.join(' ')}`], options)
    : command('./mvnw', args, options);
}

export function installMavenDependencies(options, command = run) {
  return maven(['-B', '-DskipTests', 'dependency:go-offline'], options, command);
}
