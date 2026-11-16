import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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

export function stopProcessTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') return terminateTree(child);

  // Generated launchers handle SIGTERM and shut down their own child groups.
  // Signal the group too so a Compose startup command in progress is interrupted.
  try { process.kill(-child.pid, 'SIGTERM'); } catch { return Promise.resolve(); }
  return new Promise(resolve => {
    const closed = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(async () => {
      child.off('close', closed);
      await terminateTree(child);
      resolve();
    }, 3000);
    child.once('close', closed);
  });
}

export function run(command, args, { cwd, env = process.env, log = () => {}, timeout = 600_000, signal, stdoutOnly = false, stdoutLimit = 4000,
  input, inputFile, allowPartialInput = false, binaryLimit, binaryFile, shell = false, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, detached: process.platform !== 'win32',
      stdio: [input || inputFile ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (onSpawn) child.once('spawn', onSpawn);
    let tail = '';
    let stdout = '';
    let stopped;
    let killing;
    const collect = (chunk, stream) => {
      const value = chunk.replace(/\x1b\[[0-9;]*m/g, '');
      tail = (tail + value).slice(-4000);
      log(value, stream);
    };
    const stop = error => {
      if (stopped) return;
      stopped = error;
      killing = terminateTree(child);
    };
    const binary = [];
    let size = 0;
    const limitError = () => Object.assign(new Error(`The database backup exceeds the ${binaryLimit / 1024 ** 2} MiB limit.`), { code: 'OUTPUT_LIMIT' });
    let outputTask;
    if (binaryFile) {
      const bounded = new Transform({ transform(chunk, _, done) {
        size += chunk.length;
        if (size > binaryLimit) done(limitError());
        else done(null, chunk);
      } });
      outputTask = pipeline(child.stdout, bounded, createWriteStream(binaryFile, { flags: 'wx', mode: 0o600 })).catch(stop);
    } else if (binaryLimit) {
      child.stdout.on('data', chunk => {
        if (stopped) return;
        size += chunk.length;
        if (size > binaryLimit) stop(limitError());
        else binary.push(chunk);
      });
    } else {
      child.stdout.setEncoding('utf8').on('data', chunk => {
        if (stdoutOnly) stdout = (stdout + chunk).slice(-stdoutLimit);
        collect(chunk, 'stdout');
      });
    }
    child.stderr.setEncoding('utf8').on('data', chunk => collect(chunk, 'stderr'));
    let inputError;
    let inputTask;
    if (inputFile) {
      const start = inputFile.offset;
      inputTask = pipeline(createReadStream(inputFile.path, { start, end: start + inputFile.bytes - 1 }), child.stdin)
        .catch(error => { inputError = error; });
    } else if (input) {
      child.stdin.once('error', error => { inputError = error; });
      child.stdin.end(input);
    }
    const abort = () => stop(cancelled());
    const timer = timeout > 0 ? setTimeout(() => stop(new Error(`${command} 执行超时，请检查网络后重试。`)), timeout) : undefined;
    signal?.addEventListener('abort', abort, { once: true });
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    let spawnError;
    child.on('error', error => { spawnError = new Error(`无法执行 ${command}：${error.message}`); });
    child.on('close', async code => {
      clean();
      await Promise.all([inputTask, outputTask]);
      if (killing) await killing;
      if (stopped) reject(stopped);
      else if (spawnError) reject(spawnError);
      else if (code === 0 && inputError && !(allowPartialInput && ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(inputError.code))) reject(inputError);
      else if (code === 0) resolve(binaryFile ? { path: binaryFile, offset: 0, bytes: size } :
        binaryLimit ? Buffer.concat(binary, size) : stdoutOnly ? stdout : tail);
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

export function maven(args, options, command = run, wrapper = process.platform === 'win32' ? 'mvnw.cmd' : './mvnw') {
  return process.platform === 'win32'
    ? command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `${wrapper} ${args.join(' ')}`], options)
    : command(wrapper, args, options);
}

export function installMavenDependencies(options, command = run) {
  return maven(['-B', '-DskipTests', 'dependency:go-offline'], options, command);
}
