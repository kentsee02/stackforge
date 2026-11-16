import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture } from './check-architecture.mjs';

const root = new URL('../', import.meta.url);
for (const directory of ['src', 'public', 'scripts', 'test']) {
  const folder = new URL(directory + '/', root);
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && /\.(?:mjs|js)$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name)).sort();
  for (const path of files) {
    const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  if (directory === 'src') await checkArchitecture(fileURLToPath(folder), files);
}
