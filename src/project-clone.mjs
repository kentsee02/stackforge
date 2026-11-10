import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { absoluteDirectory } from './paths.mjs';
import { run, throwIfCancelled } from './process.mjs';
import { cloneFolderChanged, directoryIdentity, sameDirectory } from './project-identity.mjs';

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

export async function verifyClone(directory, cloneId, identity) {
  try {
    if (!sameDirectory(await lstat(directory, { bigint: true }), identity)) throw new Error();
    const marker = await cloneMarker(directory);
    const info = await lstat(marker);
    if (info.isFile() && info.size === cloneId.length && await readFile(marker, 'utf8') === cloneId) return;
  } catch { /* The recorded clone could not be verified. */ }
  throw new Error(cloneFolderChanged);
}

function cloneFailure(error) {
  const output = error.message;
  if (error.code === 'ENOENT' || /spawn git ENOENT/i.test(output)) return 'Git was not found. Install Git and make sure it is on PATH.';
  if (/repository not found|requested URL returned error: 404/i.test(output)) {
    return 'GitHub could not find the repository. Check the URL and your access to it.';
  }
  if (/authentication failed|could not read username|terminal prompts disabled|requested URL returned error: (?:401|403)/i.test(output)) {
    return 'GitHub authentication failed. Check the Git credentials and repository access, then retry.';
  }
  if (/SSL certificate|certificate verify failed|certificate problem|TLS handshake/i.test(output)) {
    return 'Git could not establish a secure connection to GitHub. Check your TLS or proxy configuration.';
  }
  if (/执行超时|timed? out|could not resolve (?:host|proxy)|failed to connect|connection (?:reset|refused)|early EOF|HTTP\/2 stream/i.test(output)) {
    return 'Git could not reach GitHub or the download was interrupted. Check your network and retry.';
  }
  if (/no space left on device|disk full|not enough (?:space|disk space)/i.test(output)) {
    return 'There is not enough disk space to clone the repository.';
  }
  if (/could not create work tree|unable to create file|could not create leading directories|permission denied/i.test(output)) {
    return 'Git could not write the checkout. Check the destination folder permissions or choose another folder.';
  }
  return 'Git could not clone the repository. Check the URL, network, and Git credentials.';
}

export async function cloneGithub(repository, parentDir, { signal, command = run, onPromote } = {}) {
  const { name, url } = githubRepository(repository);
  throwIfCancelled(signal);
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
        cwd: staging, signal, timeout: 180_000,
        env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throwIfCancelled(signal);
      throw new Error(cloneFailure(error));
    }
    throwIfCancelled(signal);
    const cloneId = randomBytes(16).toString('hex');
    await writeFile(await cloneMarker(checkout), cloneId, { flag: 'wx', mode: 0o600 });
    const cloneIdentity = directoryIdentity(await lstat(checkout, { bigint: true }));
    const lockPath = join(directory, `.${name}.stackforge.lock`);
    const lock = await open(lockPath, 'wx').catch(error => {
      if (error.code === 'EEXIST') throw new Error('Another StackForge task is using this destination.');
      throw error;
    });
    try {
      await requireUnused(target);
      throwIfCancelled(signal);
      onPromote?.();
      await rename(checkout, target);
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
    return { path: target, cloneId, cloneIdentity };
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}
