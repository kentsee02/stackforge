import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { absoluteDirectory } from './paths.mjs';
import { run, throwIfCancelled } from './process.mjs';

function githubRepository(value) {
  const match = typeof value === 'string' ? /^https:\/\/github\.com\/([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,104})\/?$/i.exec(value.trim()) : null;
  const name = match?.[2].replace(/\.git$/i, '');
  if (!name || name.length > 100 || /\.$|^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(name)) {
    throw new Error('Enter a GitHub repository URL such as https://github.com/owner/project.');
  }
  return { name, url: `https://github.com/${match[1]}/${name}.git` };
}

async function requireUnused(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('A file or folder with the repository name already exists in this location.');
}

async function cloneMarker(directory) {
  const git = join(directory, '.git');
  if (!(await lstat(git)).isDirectory()) throw new Error('Could not verify the cloned repository.');
  return join(git, 'stackforge-clone');
}

export async function verifyClone(directory, cloneId) {
  try {
    const marker = await cloneMarker(directory);
    const info = await lstat(marker);
    if (info.isFile() && info.size === cloneId.length && await readFile(marker, 'utf8') === cloneId) return;
  } catch { /* The recorded clone could not be verified. */ }
  throw new Error('The folder could not be verified as the original StackForge clone.');
}

export async function cloneGithub(repository, parentDir, { signal, command = run } = {}) {
  const { name, url } = githubRepository(repository);
  const parent = absoluteDirectory(parentDir);
  await mkdir(parent, { recursive: true });
  const directory = await realpath(parent);
  const target = join(directory, name);
  await requireUnused(target);
  throwIfCancelled(signal);
  const staging = await mkdtemp(join(directory, '.stackforge-clone-'));
  try {
    const checkout = join(staging, 'checkout');
    try {
      await command('git', ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
        '-c', 'core.hooksPath=' + join(staging, 'disabled-hooks'), 'clone', '--no-recurse-submodules', '--', url, checkout], {
        cwd: staging, signal, timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Git could not clone the repository. Check the URL, network, and Git credentials.');
    }
    throwIfCancelled(signal);
    const cloneId = randomBytes(16).toString('hex');
    await writeFile(await cloneMarker(checkout), cloneId, { flag: 'wx', mode: 0o600 });
    const lockPath = join(directory, `.${name}.stackforge.lock`);
    const lock = await open(lockPath, 'wx').catch(error => {
      if (error.code === 'EEXIST') throw new Error('Another StackForge task is using this destination.');
      throw error;
    });
    try {
      await requireUnused(target);
      await rename(checkout, target);
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
    return { path: target, cloneId };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
