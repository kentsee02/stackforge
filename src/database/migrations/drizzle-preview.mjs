import { createHash, createHmac, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { localSession, localhostEndpoint, validateLocalTarget } from '../adapters/local.mjs';
import { databaseConnectionValue, discoverDatabases } from '../discovery.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { throwIfCancelled } from '../../platform/process.mjs';
import { drizzleStatements } from './drizzle-sql.mjs';
import { readMigrationFile } from './migration-files.mjs';

const maxEntries = 200;
const localHosts = ['127.0.0.1', '::1', 'localhost'];
const invalid = 'Choose a detected Drizzle PostgreSQL configuration.';
const changed = 'The Drizzle migration preview changed. Check again before applying.';
const signingKey = randomBytes(32);

async function migrationFiles(folder, out, signal) {
  const directory = join(folder, out);
  const journal = JSON.parse(await readMigrationFile(join(directory, 'meta', '_journal.json'), 256 * 1024));
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
    const sql = await readMigrationFile(join(directory, file), Math.min(bytes, 1024 * 1024));
    if (!sql.trim()) throw new Error();
    bytes -= Buffer.byteLength(sql);
    result.push({ file: out + '/' + file, when, hash: createHash('sha256').update(sql).digest('hex'), sql });
  }
  return result;
}

function stateQuery({ historySchema, historyTable }) {
  return `WITH history AS (
    SELECT c.oid, c.relkind = 'r' AND NOT c.relrowsecurity AND NOT c.relhassubclass AND
      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND
        ((a.attname='hash' AND a.atttypid='text'::regtype) OR (a.attname='created_at' AND a.atttypid='bigint'::regtype)))=2 AS eligible
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='${historySchema}' AND c.relname='${historyTable}'
  ) SELECT jsonb_build_array(current_database(), current_user,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()), pg_postmaster_start_time()::text,
    coalesce((SELECT CASE WHEN eligible THEN 'readable' ELSE 'unsupported' END FROM history), 'absent'),
    EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND c.relkind IN ('r','p','v','m','S','f','c') AND NOT EXISTS(SELECT FROM history h WHERE h.oid=c.oid)
      AND NOT EXISTS(SELECT FROM history h WHERE c.relkind='S' AND EXISTS(
        SELECT FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass
          AND d.objid=c.oid AND d.refobjid=h.oid AND d.deptype='a')))
    OR EXISTS(SELECT FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND t.typtype IN ('e','d','r','m'))
    OR EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'),
    (SELECT oid::text FROM history))`;
}

const historyName = ({ historySchema, historyTable }) => '"' + historySchema + '"."' + historyTable + '"';

async function historyState(session, target, config) {
  const read = text => session.query('BEGIN READ ONLY; SET LOCAL search_path = pg_catalog; ' + text + '; COMMIT;', target.name);
  const header = JSON.parse(await read(stateQuery(config)));
  const [database, user, oid, started, history, hasObjects] = header;
  if (database !== target.name || !user || !/^\d+$/.test(oid) || !started ||
      !['readable', 'unsupported', 'absent'].includes(history) || typeof hasObjects !== 'boolean') throw new Error();
  if (history === 'unsupported') return { conflict: true };
  const rows = history === 'absent' ? [] : JSON.parse(await read(`SELECT coalesce(jsonb_agg(jsonb_build_array(created_at::text, hash) ORDER BY created_at), '[]')
    FROM (SELECT created_at, hash FROM ONLY ${historyName(config)} ORDER BY created_at LIMIT ${maxEntries + 1}) history_rows`));
  return { rows, hasObjects, header, history };
}

const pgText = text => "pg_catalog.convert_from(pg_catalog.decode('" + Buffer.from(text, 'utf8').toString('hex') + "', 'hex'), 'UTF8')";

async function applyMigration(session, target, config, state, pending, statements) {
  const table = historyName(config);
  const existing = state.history === 'readable';
  const previous = pgText(JSON.stringify(state.rows)) + '::jsonb';
  const header = pgText(JSON.stringify(state.header)) + '::jsonb';
  const prepareHistory = existing
    ? `IF (SELECT coalesce(jsonb_agg(jsonb_build_array(created_at::text, hash) ORDER BY created_at), '[]') FROM ONLY ${table})
         IS DISTINCT FROM ${previous} THEN RAISE EXCEPTION 'Drizzle migration history changed'; END IF;`
    : `CREATE SCHEMA IF NOT EXISTS "${config.historySchema}";
       CREATE TABLE ${table} (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);`;
  const operations = pending.flatMap((file, index) => [
    ...statements[index].map(sql => 'EXECUTE ' + pgText(sql) + ';'),
    `INSERT INTO ${table} (hash, created_at) VALUES ('${file.hash}', ${file.when});`
  ]);
  await session.query(`BEGIN;
    SET LOCAL search_path = pg_catalog;
    SET LOCAL standard_conforming_strings = on;
    SET LOCAL statement_timeout = '120s';
    SELECT pg_advisory_xact_lock(hashtext('stackforge:drizzle'), hashtext('${table}'));
    ${existing ? 'LOCK TABLE ' + table + ' IN ACCESS EXCLUSIVE MODE;' : ''}
    DO $stackforge_drizzle$
    BEGIN
      IF (${stateQuery(config)}) IS DISTINCT FROM ${header} THEN
        RAISE EXCEPTION 'Drizzle migration target changed';
      END IF;
      ${prepareHistory}
      SET LOCAL search_path TO DEFAULT;
      ${operations.join('\n')}
    END;
    $stackforge_drizzle$;
    COMMIT;`, target.name, { timeout: 135000 });
}

export async function previewDrizzle({ project, requirementId, command, resolveClient, probe, signal, approval, verifyTarget }) {
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
  let state, session;
  try {
    const credentials = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    session = localSession({ ...target, sslmode }, credentials, client?.command ?? command, signal);
    state = await historyState(session, target, config);
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
  const pending = files.slice(rows.length);
  if (!pending.length) {
    if (approval) throw new Error(changed);
    return respond('current', { migrations });
  }
  const statements = pending.map(file => drizzleStatements(file.sql));
  if (statements.some(items => !items)) {
    if (approval) throw new Error(changed);
    return respond('pending', { migrations, applyBlocked: true });
  }
  const expiry = approval ? /^\d{13}(?=\.)/.exec(approval.planId ?? '')?.[0] : String(Date.now() + 300000);
  const signature = createHmac('sha256', signingKey).update(JSON.stringify([
    expiry, project.id, identity, requirement.id, target, value, config.historySchema, config.historyTable,
    state.header, rows, files.map(({ file, when, hash }) => [file, when, hash])
  ])).digest('hex');
  const planId = expiry + '.' + signature;
  if (!approval) return respond('pending', { migrations, planId });
  if (!expiry || Number(expiry) <= Date.now() || approval.planId !== planId || approval.confirmName !== target.name) throw new Error(changed);
  await verifyTarget(target);
  const latest = (await discoverDatabases(project, { includeConnections: true })).connections.get(requirement.id);
  if (!latest || latest.environmentConflict || latest.value !== value || latest.out !== config.out ||
      historyName(latest) !== historyName(config)) throw new Error(changed);
  await resolveStartup(project, [], identity);
  throwIfCancelled(signal);
  try {
    await applyMigration(session, target, config, state, pending, statements);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return respond('apply-failed');
  }
  try {
    const after = await historyState(session, target, config);
    const expected = files.map(file => [String(file.when), file.hash]);
    if (JSON.stringify(after.rows) !== JSON.stringify(expected) ||
        JSON.stringify(after.header?.slice(0, 4)) !== JSON.stringify(state.header.slice(0, 4))) {
      return respond('apply-unverified');
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return respond('apply-unverified');
  }
  return respond('applied', { migrations: migrations.map(item => ({ ...item, state: 'applied' })) });
}
