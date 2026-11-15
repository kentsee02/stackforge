import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
for (const directory of ['src', 'public', 'scripts', 'test']) {
  const folder = new URL(directory + '/', root);
  const files = await readdir(folder, { recursive: true });
  for (const file of files.filter(name => /\.(?:mjs|js)$/.test(name)).sort()) {
    const path = fileURLToPath(new URL(file.replaceAll('\\', '/'), folder));
    const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
