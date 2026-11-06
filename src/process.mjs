import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function run(command, args, { cwd, env = process.env, log = () => {}, timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const collect = chunk => {
      const value = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '');
      tail = (tail + value).slice(-4000);
      log(value);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} 执行超时，请检查网络后重试。`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(new Error(`无法执行 ${command}：${error.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(tail);
      else reject(new Error(`${command} 退出码 ${code}\n${tail}`));
    });
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
