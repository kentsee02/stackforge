import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { declaredWorkspaces, localText } from './project-detection.mjs';

const managers = {
  npm: ['npm-shrinkwrap.json', 'package-lock.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb']
};

const fileInfo = (directory, name) => lstat(join(directory, name)).catch(() => null);
const regularFile = async (directory, name) => (await fileInfo(directory, name))?.isFile() === true;

function pnpmWorkspaces(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^packages\s*:/.test(line));
  if (start === -1) return ['**'];
  if (!/^packages\s*:\s*(?:#.*)?$/.test(lines[start])) return null;
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^\s*-\s+(?:'([^']+)'|"([^"]+)"|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (match) {
      const pattern = match[1] ?? match[2] ?? match[3];
      if (!/^[\p{L}\p{N}@._*/-]+$/u.test(pattern) || patterns.length >= 32) return null;
      patterns.push(pattern);
    } else if (/^\S/.test(line)) break;
    else return null;
  }
  return patterns;
}

export async function inspectNode(directory, manifest) {
  const [locks, workspace] = await Promise.all([
    Promise.all(Object.entries(managers).map(async ([tool, names]) => {
      const files = await Promise.all(names.map(name => fileInfo(directory, name)));
      return { tool, file: names[files.findIndex(Boolean)], unsafe: files.some(file => file && !file.isFile()) };
    })),
    regularFile(directory, 'pnpm-workspace.yaml')
  ]);
  const candidates = locks.filter(lock => lock.file);
  const pin = typeof manifest.packageManager === 'string'
    ? /^(npm|pnpm|yarn|bun)@(\d+)\.\d+\.\d+(?:[-+][\w.+-]+)?$/.exec(manifest.packageManager)
    : null;
  const locked = candidates[0];
  const tool = pin?.[1] ?? locked?.tool ?? (workspace ? 'pnpm' : undefined);
  const patterns = workspace ? pnpmWorkspaces(await localText(directory, 'pnpm-workspace.yaml')) : declaredWorkspaces(manifest);
  const metadata = { patterns };
  if (candidates.length > 1 || candidates.some(lock => lock.unsafe) ||
      (locked && pin && locked.tool !== tool) || (workspace && tool !== 'pnpm') ||
      (manifest.packageManager !== undefined && !pin)) {
    return { ...metadata, conflict: true, issue: 'Package manager declarations and lockfiles conflict or are unsupported.' };
  }
  if (!tool) return { ...metadata, issue: 'No package manager is declared and no supported lockfile was found.' };

  let args = ['install'];
  if (locked) {
    if (tool === 'npm') args = ['ci'];
    else if (tool === 'yarn') {
      const text = await localText(directory, 'yarn.lock');
      const classic = pin ? pin[2] === '1' : /^# yarn lockfile v1\b/m.test(text);
      const modern = pin ? Number(pin[2]) >= 2 : /^__metadata:/m.test(text) || await regularFile(directory, '.yarnrc.yml');
      if (!classic && !modern) return { ...metadata, tool, issue: 'The Yarn lockfile version could not be identified.' };
      args.push(classic ? '--frozen-lockfile' : '--immutable');
    } else args.push('--frozen-lockfile');
  }
  const evidence = [locked?.file, pin && 'package.json (' + manifest.packageManager + ')', workspace && 'pnpm-workspace.yaml'].filter(Boolean).join(' · ');
  return { ...metadata, tool, step: { tool, command: [tool, ...args].join(' '), args, evidence } };
}
