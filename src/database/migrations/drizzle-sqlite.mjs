import { createHmac, randomBytes } from 'node:crypto';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteTarget } from '../adapters/sqlite.mjs';
import { discoverDatabases } from '../discovery.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { run, throwIfCancelled } from '../../platform/process.mjs';

const worker = fileURLToPath(new URL('./drizzle-sqlite-worker.mjs', import.meta.url));
const signingKey = randomBytes(32);
const changed = 'The Drizzle migration preview changed. Check again before applying.';
const runtimeSupportsApply = Number(process.versions.node.split('.')[0]) > 24 ||
  process.versions.node.startsWith('24.') && Number(process.versions.node.split('.')[1]) >= 10;

async function native(action, file, input, signal) {
  try {
    const result = await run(process.execPath, ['--experimental-sqlite', worker, action, file],
      { input: Buffer.from(JSON.stringify(input)), signal, timeout: 20000, stdoutOnly: true, stdoutLimit: 256 * 1024 });
    return JSON.parse(result);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const match = /SQLITE_DRIZZLE_(CHANGED|LOCKED|UNSUPPORTED|FAILED)/.exec(error.message);
    return { error: match?.[1] ?? 'FAILED' };
  }
}

export async function previewSqliteDrizzle({ project, identity, config, requirement, databaseFile, approval, rollback, migration,
  readFiles, respond, signal, verifyTarget }) {
  if (rollback) throw new Error('Drizzle SQLite recovery uses a verified database backup.');
  const defaultPath = requirement.path;
  const selectedPath = typeof databaseFile === 'string' ? databaseFile.replaceAll('\\', '/').replace(/^\.\//, '') : databaseFile;
  if (config.value !== undefined && !defaultPath || defaultPath && selectedPath !== undefined && defaultPath !== selectedPath) {
    return respond('configuration-needed');
  }
  const path = defaultPath ?? selectedPath;
  const fields = { chooseFile: !defaultPath };
  if (!path) return respond('configuration-needed', fields);
  if (typeof path !== 'string' || path.length > 320 || path.split('/').some(part =>
    /[<>:"|?*%\x00-\x1f]/.test(part) || part.toLowerCase() === '.git' || part.toLowerCase() === '.stackforge')) {
    return respond('sqlite-file-invalid', fields);
  }
  if (/^sqlite_/i.test(config.historyTable)) return respond('history-conflict', fields);
  const binding = { instance: { provider: 'sqlite', path } };
  const checkTarget = () => sqliteTarget(project, binding);
  const target = await checkTarget().catch(() => undefined);
  if (!target || target.orphaned) return respond('sqlite-file-invalid', fields);
  fields.target = { path, name: path.split('/').at(-1) };
  const { files, format } = migration;
  const table = config.historyTable;
  const named = format === 'v1';
  const layout = named ? 'v1' : 'legacy';
  const fileVersion = value => ({ identity: value.fileIdentity, revision: value.revision });
  const original = fileVersion(target);
  const absent = { layout: 'absent', populated: false, rows: [] };
  const info = target.main ? await native('preview', target.file, { table, named, original }, signal) :
    { state: absent, canWrite: runtimeSupportsApply };
  if (info.error === 'CHANGED') throw new Error(changed);
  if (info.error) return respond(info.error === 'LOCKED' ? 'sqlite-locked' : 'sqlite-file-invalid', fields);
  const { state } = info;
  if (named && state.layout === 'legacy') return respond('history-upgrade-required', fields);
  if (!['absent', layout].includes(state.layout) || state.rows.length > files.length || !state.rows.length && state.populated) {
    return respond('history-conflict', fields);
  }
  const local = new Map(files.map(file => [file.tag, file]));
  const applied = new Set(state.rows.map(([when, hash, revision], index) => {
    const file = named ? local.get(revision) : files[index];
    return file && hash === file.hash && (named ? /^\d+$/.test(when ?? '') : when === String(file.when)) ? file : undefined;
  }));
  if (applied.has(undefined) || applied.size !== state.rows.length) return respond('history-conflict', fields);
  const pathOf = file => (requirement.directory === '.' ? '' : requirement.directory + '/') + file.file;
  const entries = () => files.map(file => ({ file: pathOf(file), state: applied.has(file) ? 'applied' : 'pending' }));
  fields.migrations = entries();
  const pending = files.filter(file => !applied.has(file));
  if (!pending.length) {
    if (approval) throw new Error(changed);
    return respond('current', fields);
  }
  if (!info.canWrite) return respond('sqlite-runtime', fields);
  const reviewSql = pending.map(file => '-- ' + pathOf(file) + '\n' + file.sql).join('\n\n');
  if (Buffer.byteLength(reviewSql) > 256 * 1024 || !target.main && !target.writable) {
    if (approval) throw new Error(changed);
    return respond('pending', { ...fields, applyBlocked: true });
  }
  const filesKey = ({ format, files }) => JSON.stringify([format, files.map(({ file, when, hash }) => [file, when, hash])]);
  const expires = approval ? /^\d{13}(?=\.)/.exec(approval.planId ?? '')?.[0] : String(Date.now() + 300000);
  const planId = expires + '.' + createHmac('sha256', signingKey).update(JSON.stringify([
    expires, project.id, identity, requirement.id, config.out, table, path, original, state, filesKey(migration)
  ])).digest('hex');
  if (!approval) return respond('pending', { ...fields, reviewSql, planId });
  if (!expires || Number(expires) <= Date.now() || approval.planId !== planId || approval.confirmName !== fields.target.name) throw new Error(changed);
  await verifyTarget({ engine: 'sqlite', file: target.file });
  const latest = await discoverDatabases(project, { includeConnections: true });
  const currentRequirement = latest.requirements.find(item => item.id === requirement.id);
  const currentConfig = latest.connections.get(requirement.id);
  if (!currentConfig || currentConfig.environmentConflict || currentConfig.out !== config.out || currentConfig.historyTable !== table ||
      currentConfig.value !== config.value || currentRequirement?.path !== defaultPath || filesKey(await readFiles()) !== filesKey(migration)) {
    throw new Error(changed);
  }
  await resolveStartup(project, [], identity);
  const current = await checkTarget();
  if (current.fileIdentity !== original.identity || current.revision !== original.revision) throw new Error(changed);
  throwIfCancelled(signal);
  const input = { table, named, expected: state, pending };
  let result;
  if (target.main) result = await native('apply', target.file, { ...input, original }, signal);
  else {
    const staging = await mkdtemp(join(target.parent, '.stackforge-sqlite-'));
    const temporary = join(staging, 'database.sqlite');
    try {
      await writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
      result = await native('apply', temporary, { ...input, staged: true }, signal);
      if (!result.error) {
        await resolveStartup(project, [], identity);
        const destination = await checkTarget();
        throwIfCancelled(signal);
        if (!destination.writable || destination.fileIdentity !== original.identity) throw new Error(changed);
        await link(temporary, target.file).catch(() => { throw new Error(changed); });
      }
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  if (result.error === 'CHANGED') throw new Error(changed);
  if (result.error) return respond(({ LOCKED: 'sqlite-locked', UNSUPPORTED: 'sqlite-sql-blocked' })[result.error] ?? 'apply-failed', fields);
  const appliedTarget = await checkTarget().catch(() => undefined);
  if (!appliedTarget || target.main && appliedTarget.fileIdentity !== original.identity) return respond('apply-unverified', fields);
  const after = await native('preview', target.file, { table, named, original: fileVersion(appliedTarget) }, signal);
  for (const file of pending) applied.add(file);
  if (!after.state || after.state.layout !== layout || after.state.rows.length !== files.length ||
      JSON.stringify(after.state.rows) !== JSON.stringify([...state.rows,
        ...pending.map(file => [String(file.when), file.hash, ...(named ? [file.tag] : [])])])) return respond('apply-unverified', fields);
  return respond('applied', { ...fields, migrations: entries() });
}
