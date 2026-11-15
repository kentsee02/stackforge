import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { databaseConnectionValue, discoverDatabases } from './discovery.mjs';
import { resolveStartup } from '../projects/project-startup.mjs';
import { run, throwIfCancelled } from '../platform/process.mjs';

const missing = 'Rescan and choose a missing PostgreSQL or MySQL connection variable.';
const unsafeFile = 'The project environment file could not be safely edited.';
const existing = 'This variable is already configured. Rescan database configuration.';
const gitProtection = 'To save here, ensure Git ignores this .env file and that the file is untracked.';
const readStat = file => lstat(file, { bigint: true }).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});
const sameFile = (a, b) => a && b && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev && a.birthtimeNs === b.birthtimeNs;

async function verifyGit(folder) {
  let parent = folder;
  while (!await readStat(join(parent, '.git'))) {
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))), LC_ALL: 'C' };
  try { await run('git', ['check-ignore', '--quiet', '--', '.env'], { cwd: folder, env, timeout: 5000 }); }
  catch { throw new Error(gitProtection); }
}

async function readEnvironment(file, stat) {
  if (!stat) return '';
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > 512n * 1024n || await realpath(file) !== file) throw new Error(unsafeFile);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat({ bigint: true });
    if (!sameFile(stat, current) || current.size !== stat.size || current.ctimeNs !== stat.ctimeNs) throw new Error(unsafeFile);
    const data = Buffer.alloc(Number(current.size));
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== data.length) throw new Error(unsafeFile);
    const text = data.toString('utf8');
    if (text.includes('\0')) throw new Error(unsafeFile);
    return text;
  } finally { await handle.close(); }
}

export async function saveDatabaseEnvironment(project, { requirementId, value }, signal) {
  const { root, identity, requirements } = await discoverDatabases(project);
  const requirement = requirements.find(item => item.id === requirementId);
  const variable = requirement?.environmentVariable;
  if (requirement?.status !== 'missing' || !/^[A-Z_][A-Z0-9_]*$/.test(variable ?? '') ||
      !['postgres', 'mysql'].includes(requirement.engine)) throw new Error(missing);
  const url = databaseConnectionValue(value, requirement.engine);
  if (!url) throw new Error('Enter a complete connection URL for the detected database engine. URL-encode special characters in credentials.');
  const folder = resolve(root, requirement.directory);
  const directory = relative(root, folder);
  if (directory.split(sep)[0] === '..' || await realpath(folder) !== folder) throw new Error(unsafeFile);
  const folderStat = await readStat(folder);
  const file = join(folder, '.env');
  const stat = await readStat(file);
  const text = await readEnvironment(file, stat);
  if (parseEnv(text)[variable]?.trim()) throw new Error(existing);
  const local = join(folder, '.env.local');
  const overridden = parseEnv(await readEnvironment(local, await readStat(local)))[variable];
  if (overridden !== undefined && !(requirement.environmentFile === '.env' && overridden === url)) {
    throw new Error('This variable is defined in .env.local. Update it there and rescan.');
  }
  await verifyGit(folder);
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `${text && !text.endsWith('\n') ? lineBreak : ''}${variable}="${url}"${lineBreak}`;
  if (parseEnv(text + line)[variable] !== url || Buffer.byteLength(text + line) > 512 * 1024) throw new Error(unsafeFile);
  await resolveStartup(project, [], identity);
  throwIfCancelled(signal);
  try {
    const handle = await open(file, stat ? constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) : 'wx', 0o600);
    try {
      const current = await handle.stat({ bigint: true });
      if (!sameFile(folderStat, await readStat(folder)) || !sameFile(current, await readStat(file)) || current.nlink !== 1n ||
          (stat && (!sameFile(stat, current) || current.size !== stat.size || current.ctimeNs !== stat.ctimeNs))) throw new Error(unsafeFile);
      await handle.writeFile(line, 'utf8');
    } finally { await handle.close(); }
  } catch { throw new Error(unsafeFile); }
  return { saved: true, file: directory ? `${requirement.directory}/.env` : '.env' };
}
