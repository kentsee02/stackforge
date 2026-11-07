import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

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
