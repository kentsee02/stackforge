import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { access, lstat, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

async function executableFile(path, platform) {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch { return false; }
}

export async function findPathExecutable(name, { cwd, platform = process.platform, env = process.env,
  fileExists = path => executableFile(path, platform) } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const extensions = platform === 'win32' && !paths.extname(name) ? ['.exe', '.cmd', '.bat', ''] : [''];
  const directories = (env.PATH || env.Path || '').split(paths.delimiter);
  if (cwd && platform === 'win32') directories.unshift(cwd);
  for (const entry of directories) {
    const path = entry.replace(/^"|"$/g, '');
    const directory = paths.isAbsolute(path) ? path : cwd && paths.resolve(cwd, path);
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = paths.join(directory, name + extension);
      if (await fileExists(candidate)) return candidate;
    }
  }
}

export async function locationExists(path) {
  try { await lstat(path); return true; }
  catch (error) { return !['ENOENT', 'ENOTDIR'].includes(error.code); }
}

export function absoluteDirectory(value, platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix;
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Choose a valid absolute directory path.');
  const path = value.trim();
  if (!paths.isAbsolute(path) || platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(path)) throw new Error('Choose a valid absolute directory path.');
  return paths.normalize(path);
}

// Keep generated work independent of this tool's checkout and working directory.
// Resolve a suggestion only; create directories when a project is requested.
export function defaultProjectsDirectory({ home = homedir(), platform = process.platform, configured = process.env.STACKFORGE_PROJECTS_DIR } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const absolute = value => paths.isAbsolute(value) && (platform !== 'win32' || /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(value));
  if (configured !== undefined && typeof configured !== 'string') throw new Error('STACKFORGE_PROJECTS_DIR must be an absolute directory path.');
  const override = configured?.trim();
  if (override) {
    if (!absolute(override) || override.includes('\0')) throw new Error('STACKFORGE_PROJECTS_DIR must be an absolute directory path.');
    return paths.normalize(override);
  }
  if (typeof home !== 'string' || !absolute(home) || home.includes('\0')) throw new Error('Cannot determine the home directory. Set STACKFORGE_PROJECTS_DIR to an absolute directory path.');
  return paths.join(home, 'Projects');
}
