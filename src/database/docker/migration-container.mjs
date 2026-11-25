import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { throwIfCancelled } from '../../platform/process.mjs';

export async function migrationImage(cli, reference, allowPull) {
  async function inspect() {
    try {
      const image = (await cli(['image', 'inspect', '--format', '{{.Id}}', reference])).trim();
      if (/^sha256:[a-f\d]{64}$/.test(image)) return image;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
    }
  }
  const present = await inspect();
  if (present || !allowPull) return present;
  try { await cli(['pull', reference], { timeout: 165000 }); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Could not download the pinned migration tool image. Check Docker and network access.');
  }
  return inspect();
}

export async function buildMigrationImage({ cli, reference, dockerfile, allowBuild, directory }) {
  const existing = await migrationImage(cli, reference, false);
  if (existing || !allowBuild) return existing;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(directory, 'migration-tool-'));
  try {
    await writeFile(join(staging, 'Dockerfile'), dockerfile, { flag: 'wx', mode: 0o600 });
    await cli(['build', '--pull=false', '--tag', reference, staging], { timeout: 165000 });
    return migrationImage(cli, reference, false);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Could not prepare the Alembic runtime. Check Docker and package registry access.');
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function runMigrationContainer({ cli, container, image, args, files, directory, env, signal, verify, cancel,
  offline = false, network, mounts = [], user, timeout = 150000 }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(directory, 'native-migration-'));
  const folder = join(staging, 'files');
  const name = 'stackforge-migrate-' + randomBytes(16).toString('hex');
  const cleanup = { signal: null, timeout: 15000 };
  let worker, started = false, finished = false;
  try {
    await mkdir(folder, { mode: 0o755 });
    for (const [path, sql] of files) {
      if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw new Error();
      const file = join(folder, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, sql, { flag: 'wx', mode: 0o644 });
    }
    if (folder.slice(process.platform === 'win32' ? 2 : 0).includes(':')) throw new Error();
    await verify();
    throwIfCancelled(signal);
    worker = (await cli(['container', 'create', '--name', name, '--network', network ?? (offline ? 'none' : 'container:' + container),
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--label', 'io.stackforge.migration-worker=' + name,
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--env', 'HOME=/tmp',
      '--volume', folder + ':/stackforge:ro', ...mounts.flatMap(mount => ['--mount', mount]), ...(user ? ['--user', user] : []),
      ...Object.keys(env).flatMap(key => ['--env', key]), image, ...args],
    { extraEnv: env, ...cleanup })).trim();
    if (!/^[a-f\d]{64}$/.test(worker)) throw new Error();
    await verify();
    throwIfCancelled(signal);
    started = true;
    const result = await cli(['container', 'start', '--attach', worker], { stdoutLimit: 512 * 1024, timeout });
    finished = true;
    return result;
  } finally {
    if (!/^[a-f\d]{64}$/.test(worker ?? '')) {
      const owned = await cli(['container', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "io.stackforge.migration-worker"}}', name],
        cleanup).catch(() => '');
      const [id, owner] = owned.trim().split(' ');
      if (owner === name) worker = id;
    }
    if (/^[a-f\d]{64}$/.test(worker ?? '')) {
      await cli(['container', 'rm', '--force', worker], cleanup).catch(() => {});
    }
    if (started && !finished && cancel) await cancel().catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }
}
