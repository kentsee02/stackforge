import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { databaseConnectionValue, discoverDatabases, environmentRevision } from './discovery.mjs';
import { resolveStartup } from '../projects/project-startup.mjs';
import { run, throwIfCancelled } from '../platform/process.mjs';

const missing = 'Rescan and choose a missing PostgreSQL or MySQL connection variable.';
const unsafeFile = 'The project environment file could not be safely edited.';
const existing = 'This variable is already configured. Rescan database configuration.';
const gitProtection = 'To save here, ensure Git ignores this environment file and that the file is untracked.';
const editChanged = 'The stored connection changed. Rescan before editing it.';
const readStat = file => lstat(file, { bigint: true }).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});
const sameFile = (a, b) => a && b && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev && a.birthtimeNs === b.birthtimeNs;

async function verifyGit(folder, file) {
  let parent = folder;
  while (!await readStat(join(parent, '.git'))) {
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))), LC_ALL: 'C' };
  try { await run('git', ['check-ignore', '--quiet', '--', file], { cwd: folder, env, timeout: 5000 }); }
  catch { throw new Error(gitProtection); }
  return parent;
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
    if (text.includes('\0') || !Buffer.from(text).equals(data)) throw new Error(unsafeFile);
    return text;
  } finally { await handle.close(); }
}

async function replaceConnection({ file, text, stat, folder, folderStat, gitRoot, variable, url, revision, signal }) {
  const assignment = new RegExp(`^([ \\t]*(?:export[ \\t]+)?${variable}[ \\t]*=[ \\t]*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^"'#\\r\\n]*?)([ \\t]*(?:#[^\\r\\n]*)?)$`, 'gm');
  const definitions = [...text.matchAll(assignment)];
  const before = parseEnv(text);
  if (definitions.length !== 1 || parseEnv(definitions[0][0])[variable] !== before[variable]) throw new Error(unsafeFile);
  const updated = text.replace(assignment, (_, prefix, suffix) => `${prefix}"${url}"${suffix}`);
  const after = parseEnv(updated);
  if (after[variable] !== url || Buffer.byteLength(updated) > 512 * 1024 ||
      JSON.stringify(after) !== JSON.stringify({ ...before, [variable]: url })) throw new Error(unsafeFile);
  const gitDirectory = gitRoot && join(gitRoot, '.git');
  const metadata = gitDirectory && await readStat(gitDirectory);
  const staging = !gitRoot ? folder : metadata?.isDirectory() && metadata.dev === folderStat.dev ? gitDirectory : await realpath(tmpdir());
  const stagingStat = await readStat(staging);
  if (!stagingStat?.isDirectory() || stagingStat.dev !== folderStat.dev || await realpath(staging) !== staging) throw new Error(unsafeFile);
  const temporary = join(staging, `.stackforge-env-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, updated, { flag: 'wx', mode: 0o600 });
    const latest = await readStat(file);
    if (!sameFile(folderStat, await readStat(folder)) || !sameFile(stagingStat, await readStat(staging)) || !sameFile(stat, latest) ||
        latest.nlink !== 1n || environmentRevision(latest, variable) !== revision) throw new Error(editChanged);
    throwIfCancelled(signal);
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function saveDatabaseEnvironment(project, { requirementId, value, revision }, signal) {
  const { root, identity, requirements } = await discoverDatabases(project);
  const requirement = requirements.find(item => item.id === requirementId);
  const variable = requirement?.environmentVariable;
  const edit = revision !== undefined;
  if (edit && (!requirement?.environmentEdit || revision !== requirement.environmentEdit.revision)) throw new Error(editChanged);
  if ((!edit && requirement?.status !== 'missing') || !/^[A-Z_][A-Z0-9_]*$/.test(variable ?? '') ||
      !['postgres', 'mysql'].includes(requirement.engine)) throw new Error(missing);
  const url = databaseConnectionValue(value, requirement.engine);
  if (!url) throw new Error('Enter a complete connection URL for the detected database engine. URL-encode special characters in credentials.');
  const folder = resolve(root, requirement.directory);
  const directory = relative(root, folder);
  if (directory.split(sep)[0] === '..' || await realpath(folder) !== folder) throw new Error(unsafeFile);
  const folderStat = await readStat(folder);
  const name = edit ? requirement.environmentEdit.file : '.env';
  const file = join(folder, name);
  const stat = await readStat(file);
  const text = await readEnvironment(file, stat);
  const saved = { saved: true, file: directory ? `${requirement.directory}/${name}` : name };
  if (edit) {
    if (!stat || environmentRevision(stat, variable) !== revision) throw new Error(editChanged);
    const gitRoot = await verifyGit(folder, name);
    await resolveStartup(project, [], identity);
    await replaceConnection({ file, text, stat, folder, folderStat, gitRoot, variable, url, revision, signal });
    return saved;
  }
  if (parseEnv(text)[variable]?.trim()) throw new Error(existing);
  const local = join(folder, '.env.local');
  const overridden = parseEnv(await readEnvironment(local, await readStat(local)))[variable];
  if (overridden !== undefined && !(requirement.environmentFile === '.env' && overridden === url)) {
    throw new Error('This variable is defined in .env.local. Update it there and rescan.');
  }
  await verifyGit(folder, name);
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
  return saved;
}
