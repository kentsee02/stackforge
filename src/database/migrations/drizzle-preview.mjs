import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { localSession, localhostEndpoint, validateLocalTarget } from '../adapters/local.mjs';
import { databaseConnectionValue, discoverDatabases } from '../discovery.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { throwIfCancelled } from '../../platform/process.mjs';

const maxEntries = 200;
const localHosts = ['127.0.0.1', '::1', 'localhost'];
const invalid = 'Choose a detected Drizzle PostgreSQL configuration.';

async function readBounded(path, limit) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.size > BigInt(limit) || await realpath(path) !== path) throw new Error();
  const handle = await open(path, 'r');
  try {
    const start = await handle.stat({ bigint: true });
    if (start.dev !== info.dev || start.ino !== info.ino || start.ctimeNs !== info.ctimeNs) throw new Error();
    const buffer = Buffer.alloc(Number(info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = await handle.stat({ bigint: true });
    if (bytesRead !== buffer.length || start.ctimeNs !== end.ctimeNs || start.size !== end.size) throw new Error();
    const text = buffer.toString('utf8');
    if (!Buffer.from(text).equals(buffer)) throw new Error();
    return text;
  } finally { await handle.close(); }
}

async function migrationFiles(folder, out, signal) {
  const directory = join(folder, out);
  const journal = JSON.parse(await readBounded(join(directory, 'meta', '_journal.json'), 256 * 1024));
  if (journal.version !== '7' || journal.dialect !== 'postgresql' ||
      !Array.isArray(journal.entries) || !journal.entries.length || journal.entries.length > maxEntries) throw new Error();
  const tags = new Set();
  const result = [];
  let previous = 0, bytes = 16 * 1024 * 1024;
  for (const [index, entry] of journal.entries.entries()) {
    throwIfCancelled(signal);
    const { tag, when, idx, version } = entry;
    if (idx !== index || version !== '7' || !Number.isSafeInteger(when) || when <= previous ||
        typeof tag !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(tag) || tags.has(tag.toLowerCase())) throw new Error();
    tags.add(tag.toLowerCase());
    previous = when;
    const file = tag + '.sql';
    const sql = await readBounded(join(directory, file), Math.min(bytes, 1024 * 1024));
    if (!sql.trim()) throw new Error();
    bytes -= Buffer.byteLength(sql);
    result.push({ file: out + '/' + file, when, hash: createHash('sha256').update(sql).digest('hex') });
  }
  return result;
}

async function historyState(session, target, { historySchema, historyTable }) {
  const read = text => session.query('BEGIN READ ONLY; SET LOCAL search_path = pg_catalog; ' + text + '; COMMIT;', target.name);
  const header = await read(`WITH history AS (
    SELECT c.oid, c.relkind = 'r' AND NOT c.relrowsecurity AND NOT c.relhassubclass AND
      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND
        ((a.attname='hash' AND a.atttypid='text'::regtype) OR (a.attname='created_at' AND a.atttypid='bigint'::regtype)))=2 AS eligible
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='${historySchema}' AND c.relname='${historyTable}'
  ) SELECT current_database(),
    coalesce((SELECT CASE WHEN eligible THEN 'readable' ELSE 'unsupported' END FROM history), 'absent'),
    EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND c.relkind IN ('r','p','v','m','S','f') AND NOT EXISTS(SELECT FROM history h WHERE h.oid=c.oid)
      AND NOT EXISTS(SELECT FROM history h WHERE c.relkind='S' AND EXISTS(
        SELECT FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass
          AND d.objid=c.oid AND d.refobjid=h.oid AND d.deptype='a')))`);
  const [database, history, objects] = header.split('\t');
  if (database !== target.name || !['readable', 'unsupported', 'absent'].includes(history) || !['t', 'f'].includes(objects)) throw new Error();
  if (history === 'unsupported') return { conflict: true };
  if (history === 'absent') return { rows: [], hasObjects: objects === 't' };
  const output = await read(`SELECT created_at, hash FROM ONLY "${historySchema}"."${historyTable}" ORDER BY created_at LIMIT ${maxEntries + 1}`);
  return { rows: output ? output.split(/\r?\n/).map(row => row.split('\t')) : [], hasObjects: objects === 't' };
}

export async function previewDrizzle({ project, requirementId, command, resolveClient, probe, signal }) {
  const { root, identity, requirements, connections } = await discoverDatabases(project, { includeConnections: true });
  const requirement = requirements.find(item => item.id === requirementId && item.migrationAdapter === 'drizzle');
  if (!requirement) throw new Error(invalid);
  const config = connections.get(requirement.id);
  const { source, directory, environmentVariable: variable } = requirement;
  const location = directory === '.' ? '' : directory + '/';
  const result = { source, variable, history: config.historySchema + '.' + config.historyTable };
  const respond = (status, fields) => ({ ...result, status, ...fields });
  let files;
  try { files = await migrationFiles(resolve(root, directory), config.out, signal); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    return respond('files-unavailable');
  }
  result.migrations = files.map(({ file }) => ({ file: location + file, state: 'unverified' }));
  if (config.environmentConflict) return respond('environment-conflict', { sources: config.environmentSources });
  if (requirement.status !== 'configured') return respond('configuration-needed');
  if (!localHosts.includes(requirement.host)) return respond('remote-target');
  const value = databaseConnectionValue(config.value, 'postgres');
  if (!value) return respond('configuration-needed');
  const url = new URL(value);
  const sslmode = url.searchParams.get('sslmode') ?? 'prefer';
  if (!['disable', 'prefer', 'require'].includes(sslmode) || [...url.searchParams.keys()].some(key => key !== 'sslmode')) {
    return respond('configuration-needed');
  }
  const address = requirement.host === 'localhost' ? await localhostEndpoint(requirement.port, probe) : requirement.host;
  if (!address) return respond('loopback-ambiguous');
  const target = validateLocalTarget({ host: address, port: requirement.port }, requirement);
  Object.assign(result, { target: { host: target.host, port: target.port, name: target.name } });
  await resolveStartup(project, [], identity);
  const client = await resolveClient?.(target);
  if (client && !(await client.installation(probe)).portOpen) return respond('docker-unreachable');
  let state;
  try {
    const credentials = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    state = await historyState(localSession({ ...target, sslmode }, credentials, client?.command ?? command, signal), target, config);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return respond(['authentication', 'server', 'permission', 'client', 'database', 'tls'].includes(error.issue) ? error.issue : 'connection');
  }
  await resolveStartup(project, [], identity);
  const { rows } = state;
  if (state.conflict || rows.length > files.length || !rows.length && state.hasObjects ||
      !rows.every(([when, hash, extra], i) => extra === undefined && when === String(files[i].when) && hash === files[i].hash)) {
    return respond('history-conflict');
  }
  const migrations = result.migrations.map((item, index) => ({ ...item, state: index < rows.length ? 'applied' : 'pending' }));
  return respond(rows.length < files.length ? 'pending' : 'current', { migrations });
}
