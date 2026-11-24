import { constants } from 'node:fs';
import { access, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { databaseKey } from '../discovery.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { run, throwIfCancelled } from '../../platform/process.mjs';
import { backupLimit } from '../backup/docker-transfer.mjs';
import { sqliteFileState } from './sqlite-file.mjs';

const worker = fileURLToPath(new URL('./sqlite-worker.mjs', import.meta.url));
const invalid = 'Choose a SQLite database file inside the project.';
const unavailable = 'SQLite could not read or verify the database file.';
const existsError = 'SQLite restore and creation require a missing database file with no journal files.';
const header = Buffer.from('SQLite format 3\0');

export async function sqliteTarget(project, binding) {
  const path = binding.instance?.path;
  if (binding.instance?.provider !== 'sqlite' || !path || isAbsolute(path) ||
      !/\.(?:db|sqlite3?)$/i.test(path) ||
      path.split('/').some(part => !part || /[. ]$/.test(part) || /[\\:\x00-\x1f]/.test(part))) {
    throw new Error(invalid);
  }
  const { root, identity } = await resolveStartup(project, []);
  const file = resolve(root, path);
  const within = relative(root, file);
  if (!within || isAbsolute(within) || within.startsWith('..' + sep)) throw new Error(invalid);
  const parent = dirname(file);
  if (await realpath(parent).catch(() => '') !== parent) throw new Error('The SQLite database folder is missing or unsafe.');
  const { main, files, identity: fileIdentity, revision, orphaned } = sqliteFileState(file);
  const key = databaseKey(identity, path, files.map(stat => stat && [String(stat.ino), String(stat.dev), String(stat.birthtimeNs)]));
  const writable = !files.some(Boolean) && await access(parent, constants.W_OK).then(() => true, () => false);
  return { file, parent, path, main, key, writable, fileIdentity, revision, orphaned };
}

export function sqliteAdapter(directory, { command = run } = {}) {
  async function native(action, file, output, signal) {
    try {
      const result = await command(process.execPath, ['--experimental-sqlite', worker, action, file, ...(output ? [output] : [])],
        { signal, timeout: 15000, stdoutOnly: true, stdoutLimit: 256 * 1024 });
      return result ? JSON.parse(result) : undefined;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.message.includes('SQLITE_BUSY')) throw new Error('The SQLite database is locked. Stop the writer or retry.');
      throw new Error(unavailable);
    }
  }
  async function temporary(work) {
    if (directory !== tmpdir()) await mkdir(directory, { recursive: true, mode: 0o700 });
    const folder = await mkdtemp(join(directory, 'sqlite-'));
    try { return await work(join(folder, 'backup.sqlite')); }
    finally { await rm(folder, { recursive: true, force: true }); }
  }
  async function verify(data, signal) {
    if (!data.subarray(0, header.length).equals(header)) throw new Error(unavailable);
    return temporary(async file => {
      await writeFile(file, data, { mode: 0o600, flag: 'wx' });
      return native('verify', file, undefined, signal);
    });
  }
  async function inspect(project, binding, signal) {
    const target = await sqliteTarget(project, binding);
    const details = target.main ? await native('inspect', target.file, undefined, signal) : undefined;
    return { path: target.path, exists: Boolean(target.main), details, capabilities: {
      inspect: Boolean(target.main), backup: Boolean(details && details.bytes <= backupLimit), create: target.writable, restore: target.writable
    } };
  }
  async function backup(project, binding, signal) {
    const source = await sqliteTarget(project, binding);
    if (!source.main) throw new Error(unavailable);
    return temporary(async output => {
      const details = await native('inspect', source.file, undefined, signal);
      if (details.bytes > backupLimit) throw new Error('The database backup exceeds the 64 MiB limit.');
      await native('snapshot', source.file, output, signal);
      if ((await sqliteTarget(project, binding)).main?.ino !== source.main.ino) throw new Error(invalid);
      const snapshot = await native('verify', output, undefined, signal);
      if ((await lstat(output)).size > backupLimit) throw new Error('The database backup exceeds the 64 MiB limit.');
      return { data: await readFile(output), engine: 'sqlite', version: snapshot.version, objects: snapshot.objects.length, objectsLimited: snapshot.limited };
    });
  }
  async function install(project, binding, data, signal) {
    const target = await sqliteTarget(project, binding);
    if (!target.writable) throw new Error(existsError);
    // Hard-link a checked file from a sibling directory. An existing destination wins.
    const staging = await mkdtemp(join(target.parent, '.stackforge-sqlite-'));
    const file = join(staging, 'database.sqlite');
    try {
      await writeFile(file, data ?? Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
      if (!data) await native('create', file, undefined, signal);
      const schema = await native('verify', file, undefined, signal);
      const current = await sqliteTarget(project, binding);
      throwIfCancelled(signal);
      if (!current.writable || current.key !== target.key) throw new Error(existsError);
      await link(file, target.file).catch(() => { throw new Error(existsError); });
      return { created: true, objects: schema.objects.length };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const empty = signal => temporary(async file => {
    await native('create', file, undefined, signal);
    return readFile(file);
  });
  return { inspect, backup, install, verify, empty };
}
