import { access, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { throwIfCancelled } from './process.mjs';
import { sameDirectory } from './project-identity.mjs';

export async function verifyStaging(path, options, owner, identity) {
  if (!owner || dirname(resolve(path)) !== resolve(options.parentDir) || !/^\.stackforge-[a-zA-Z0-9]+$/.test(basename(path))) throw new Error('保留目录不属于这个创建任务，已停止恢复。');
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || (identity && !sameDirectory(info, identity)) || dirname(await realpath(path)) !== await realpath(options.parentDir)) throw new Error('保留目录位置发生变化，已停止恢复。');
  if (await readFile(join(path, '.stackforge-owner'), 'utf8') !== owner) throw new Error('保留目录的任务标识不匹配。');
}

export async function wasPromoted(target, owner) {
  try { return owner && await readFile(join(target, '.stackforge-owner'), 'utf8') === owner; }
  catch { return false; }
}

export function createSteps(checkpoint, report, save, signal) {
  checkpoint.completed ??= [];
  return async (id, message, progress, action) => {
    throwIfCancelled(signal);
    if (checkpoint.completed.includes(id)) {
      report({ type: 'log', message: `已完成，跳过：${message}` });
      return;
    }
    checkpoint.phase = id;
    report({ type: 'step', message, progress, phase: id });
    await save();
    await action();
    // A completed install remains reusable even when cancellation arrived just
    // after its subprocess exited. Persist before observing cancellation again.
    checkpoint.completed.push(id);
    await save();
    throwIfCancelled(signal);
  };
}

export async function writeOwnedFiles(root, files, signal) {
  const { mkdir } = await import('node:fs/promises');
  for (const [name, contents] of Object.entries(files)) {
    throwIfCancelled(signal);
    const file = join(root, name);
    if (name === '.env') {
      try { await access(file); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents, { mode: name === '.env' ? 0o600 : 0o644 });
  }
}
