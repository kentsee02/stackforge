import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

const ignored = /^(?:\.|__|venv$|env$|tests?$|test_|fixtures?$|docs?$|examples?$|scripts?$|migrations?$|node_modules$|build$|dist$|site-packages$)/i;
const manifest = async path => (await lstat(path).catch(() => null))?.isFile();

export function djangoSettingsFiles(manage) {
  if (!/\bdjango\.core\.management\b/.test(manage)) return [];
  const configured = [...manage.matchAll(/\bos\.environ\.setdefault\(\s*['"]DJANGO_SETTINGS_MODULE['"]\s*,\s*(['"])((?:[A-Za-z_]\w*\.){0,7}[A-Za-z_]\w*)\1\s*\)/g)];
  if (configured.length !== 1) return [];
  const module = configured[0][2].replaceAll('.', '/');
  return [module + '.py', module + '/__init__.py'];
}

export async function pythonSourceFiles(folder, walkPackages) {
  const pending = [{ directory: '', depth: 0 }];
  const files = [];
  let examined = 0;
  for (const { directory, depth } of pending) {
    const listing = await opendir(join(folder, directory)).catch(() => null);
    if (!listing) continue;
    for await (const entry of listing) {
      if (++examined > 384 || files.length >= 64) return;
      if (ignored.test(entry.name)) continue;
      if (entry.isFile() && /^[A-Za-z_]\w*\.py$/.test(entry.name)) files.push(directory + entry.name);
      if (walkPackages && depth < 3 && entry.isDirectory() && /^[A-Za-z_]\w*$/.test(entry.name)) {
        const next = directory + entry.name + '/';
        if (!await manifest(join(folder, next, 'pyproject.toml')) && !await manifest(join(folder, next, 'requirements.txt'))) pending.push({ directory: next, depth: depth + 1 });
      }
    }
  }
  return files;
}
