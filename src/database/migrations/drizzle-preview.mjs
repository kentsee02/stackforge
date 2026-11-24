import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { localSession, localhostEndpoint, validateLocalTarget } from '../adapters/local.mjs';
import { databaseConnectionValue, discoverDatabases } from '../discovery.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { throwIfCancelled } from '../../platform/process.mjs';
import { drizzleStatements } from './drizzle-sql.mjs';
import { previewMysqlDrizzle } from './drizzle-mysql.mjs';
import { readMigrationFile } from './migration-files.mjs';

const maxEntries = 200;
const localHosts = ['127.0.0.1', '::1', 'localhost'];
const invalid = 'Choose a detected Drizzle migration configuration.';
const changed = 'The Drizzle migration preview changed. Check again before applying.';
const badRollback = 'Choose a verified project PostgreSQL database, a prior Drizzle revision, and a supported rollback SQL file inside the project.';
const signingKey = randomBytes(32);

async function migrationFiles(folder, { out, engine }, signal) {
  const directory = join(folder, out);
  let text;
  try { text = await readMigrationFile(join(directory, 'meta', '_journal.json'), 256 * 1024); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { format: 'v1', files: await folderMigrations(directory, out, signal) };
  }
  if ((await readdir(directory)).some(name => /^\d{14}_/.test(name))) throw new Error();
  const journal = JSON.parse(text);
  const mysql = engine === 'mysql';
  if (!(mysql ? ['5', '7'].includes(journal.version) && journal.dialect === 'mysql' :
      journal.version === '7' && journal.dialect === 'postgresql') ||
      !Array.isArray(journal.entries) || !journal.entries.length || journal.entries.length > maxEntries) throw new Error();
  const tags = new Set();
  const result = [];
  let previous = 0, bytes = 16 * 1024 * 1024;
  for (const [index, entry] of journal.entries.entries()) {
    throwIfCancelled(signal);
    const { tag, when, idx, version } = entry;
    if (idx !== index || version !== (mysql ? '5' : '7') || !Number.isSafeInteger(when) || when <= previous ||
        typeof tag !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(tag) || tags.has(tag.toLowerCase())) throw new Error();
    tags.add(tag.toLowerCase());
    previous = when;
    const file = tag + '.sql';
    const sql = await readMigrationFile(join(directory, file), Math.min(bytes, 1024 * 1024));
    if (!sql.trim()) throw new Error();
    bytes -= Buffer.byteLength(sql);
    result.push({ file: out + '/' + file, tag, when, hash: createHash('sha256').update(sql).digest('hex'), sql });
  }
  return { format: 'journal-v' + journal.version, files: result };
}

async function folderMigrations(directory, out, signal) {
  if (await realpath(directory) !== directory) throw new Error();
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.filter(item => /^\d{14}/.test(item.name));
  if (!names.length || names.length > maxEntries || entries.some(item => item.name.endsWith('.sql'))) throw new Error();
  const seen = new Set();
  let remaining = 16 * 1024 * 1024;
  const files = [];
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    throwIfCancelled(signal);
    const tag = entry.name;
    const stamp = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-zA-Z0-9_-]{1,120}$/.exec(tag);
    if (!entry.isDirectory() || !stamp || seen.has(tag.toLowerCase()) || remaining <= 0) throw new Error();
    seen.add(tag.toLowerCase());
    const [, year, month, day, hour, minute, second] = stamp;
    const iso = year + '-' + month + '-' + day + 'T' + hour + ':' + minute + ':' + second + '.000Z';
    const when = Date.parse(iso);
    if (!Number.isFinite(when) || new Date(when).toISOString() !== iso) throw new Error();
    const sql = await readMigrationFile(join(directory, tag, 'migration.sql'), Math.min(remaining, 1024 * 1024));
    if (!sql.trim()) throw new Error();
    remaining -= Buffer.byteLength(sql);
    files.push({ file: out + '/' + tag + '/migration.sql', tag, when, sql,
      hash: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}

function stateQuery({ historySchema, historyTable }, named) {
  return `WITH history AS (
    SELECT c.oid, c.relkind = 'r' AND NOT c.relrowsecurity AND NOT c.relhassubclass AND
      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND
        ((a.attname='hash' AND a.atttypid='text'::regtype) OR (a.attname='created_at' AND a.atttypid='bigint'::regtype)
        ${named ? "OR (a.attname='name' AND a.atttypid='text'::regtype) OR (a.attname='id' AND a.atttypid='int4'::regtype) OR (a.attname='applied_at' AND a.atttypid='timestamptz'::regtype)" : ''}))=${named ? 5 : 2}
      ${named ? '' : "AND NOT EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attname IN ('name', 'applied_at'))"} AS eligible
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

function historyRows(config, named, limit = '') {
  const columns = named ? 'created_at, hash, name, id' : 'created_at, hash';
  const sort = named ? 'id' : 'created_at';
  return `SELECT coalesce(jsonb_agg(jsonb_build_array(created_at::text, hash${named ? ', name' : ''}) ORDER BY ${sort}), '[]')
    FROM (SELECT ${columns} FROM ONLY ${historyName(config)} ORDER BY ${sort} ${limit}) history_rows`;
}

async function historyState(session, target, config, named) {
  const read = text => session.query('BEGIN READ ONLY; SET LOCAL search_path = pg_catalog; ' + text + '; COMMIT;', target.name);
  const header = JSON.parse(await read(stateQuery(config, named)));
  const [database, user, oid, started, history, hasObjects] = header;
  if (database !== target.name || !user || !/^\d+$/.test(oid) || !started ||
      !['readable', 'unsupported', 'absent'].includes(history) || typeof hasObjects !== 'boolean') throw new Error();
  if (history === 'unsupported') return { conflict: true };
  const rows = history === 'absent' ? [] : JSON.parse(await read(historyRows(config, named, 'LIMIT ' + (maxEntries + 1))));
  return { rows, hasObjects, header, history };
}

const pgText = text => "pg_catalog.convert_from(pg_catalog.decode('" + Buffer.from(text, 'utf8').toString('hex') + "', 'hex'), 'UTF8')";

async function writeMigration(session, target, config, state, operations, expectedRows, named) {
  const table = historyName(config);
  const existing = state.history === 'readable';
  const previous = pgText(JSON.stringify(state.rows)) + '::jsonb';
  const header = pgText(JSON.stringify(state.header)) + '::jsonb';
  const expected = pgText(JSON.stringify(expectedRows)) + '::jsonb';
  const readRows = historyRows(config, named);
  const prepareHistory = existing
    ? `IF (${readRows}) IS DISTINCT FROM ${previous} THEN RAISE EXCEPTION 'Drizzle migration history changed'; END IF;`
    : `CREATE SCHEMA IF NOT EXISTS "${config.historySchema}";
       CREATE TABLE ${table} (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint${named ? ', name text, applied_at timestamp with time zone DEFAULT now()' : ''});`;
  await session.query(`BEGIN;
    SET LOCAL search_path = pg_catalog;
    SET LOCAL standard_conforming_strings = on;
    SET LOCAL statement_timeout = '120s';
    SELECT pg_advisory_xact_lock(hashtext('stackforge:drizzle'), hashtext('${table}'));
    ${existing ? 'LOCK TABLE ' + table + ' IN ACCESS EXCLUSIVE MODE;' : ''}
    DO $stackforge_drizzle$
    BEGIN
      IF (${stateQuery(config, named)}) IS DISTINCT FROM ${header} THEN
        RAISE EXCEPTION 'Drizzle migration target changed';
      END IF;
      ${prepareHistory}
      SET LOCAL search_path TO DEFAULT;
      ${operations.join('\n')}
      SET LOCAL search_path = pg_catalog;
      IF (${stateQuery(config, named)}) ->> 4 IS DISTINCT FROM 'readable'
        ${existing ? `OR (${stateQuery(config, named)}) ->> 6 IS DISTINCT FROM (${header} ->> 6)` : ''} THEN
        RAISE EXCEPTION 'Drizzle history table changed';
      END IF;
      IF (${readRows}) IS DISTINCT FROM ${expected} THEN
        RAISE EXCEPTION 'Drizzle SQL did not record the expected history';
      END IF;
    END;
    $stackforge_drizzle$;
    COMMIT;`, target.name, { timeout: 135000 });
}

async function reviewedRollback(root, selection, revisions, applied, signal) {
  const { revision, scriptFile } = selection;
  const next = revision === null ? 0 : revisions.findIndex(item => item.tag === revision) + 1;
  if ((!next && revision !== null) || next >= applied || typeof scriptFile !== 'string' || scriptFile.length > 380 ||
      !/\.sql$/i.test(scriptFile) || !scriptFile.split('/').every(part => /^[\w][\w .-]*$/.test(part) && !/[. ]$/.test(part))) {
    throw new Error(badRollback);
  }
  try {
    throwIfCancelled(signal);
    const sql = await readMigrationFile(join(root, scriptFile), 256 * 1024);
    const statements = drizzleStatements(sql, { expanded: true });
    if (!statements) throw new Error(badRollback);
    return { sql, statements, next, scriptFile, revision };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(badRollback);
  }
}

export async function previewDrizzle({ project, requirementId, command, resolveClient, probe, signal, approval, rollback, verifyTarget }) {
  const { root, identity, requirements, connections } = await discoverDatabases(project, { includeConnections: true });
  const requirement = requirements.find(item => item.id === requirementId && item.migrationAdapter === 'drizzle');
  if (!requirement) throw new Error(invalid);
  const config = connections.get(requirement.id);
  const { source, directory, environmentVariable: variable } = requirement;
  const location = directory === '.' ? '' : directory + '/';
  const result = { source, variable, ...(config.engine === 'mysql' ? { engine: 'mysql', history: config.historyTable } :
    { history: config.historySchema + '.' + config.historyTable }) };
  const respond = (status, fields) => ({ ...result, status, ...fields });
  let migration;
  const readFiles = () => migrationFiles(resolve(root, directory), config, signal);
  try { migration = await readFiles(); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    return respond('files-unavailable');
  }
  const { files, format } = migration;
  const named = format === 'v1';
  result.format = format;
  result.migrations = files.map(({ file }) => ({ file: location + file, state: 'unverified' }));
  if (config.environmentConflict) return respond('environment-conflict', { sources: config.environmentSources });
  if (requirement.status !== 'configured') return respond('configuration-needed');
  if (!localHosts.includes(requirement.host)) return respond('remote-target');
  const value = databaseConnectionValue(config.value, requirement.engine);
  if (!value) return respond('configuration-needed');
  const url = new URL(value);
  const sslmode = url.searchParams.get('sslmode') ?? 'prefer';
  if (config.engine === 'mysql' ? Boolean(url.search) :
      !['disable', 'prefer', 'require'].includes(sslmode) || [...url.searchParams.keys()].some(key => key !== 'sslmode')) {
    return respond('configuration-needed');
  }
  const address = requirement.host === 'localhost' ? await localhostEndpoint(requirement.port, probe) : requirement.host;
  if (!address) return respond('loopback-ambiguous');
  const target = validateLocalTarget({ host: address, port: requirement.port }, requirement);
  Object.assign(result, { target: { host: target.host, port: target.port, name: target.name } });
  await resolveStartup(project, [], identity);
  const client = await resolveClient?.(target);
  if (client && !(await client.installation(probe)).portOpen) return respond('docker-unreachable');
  if (config.engine === 'mysql') return previewMysqlDrizzle({ project, identity, requirement, config, value, url, target, client,
    command, signal, approval, rollback, verifyTarget, readFiles, migration, respond });
  const applicationName = client && 'stackforge_migration_' + randomBytes(12).toString('hex');
  let state, session;
  try {
    const credentials = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    session = localSession({ ...target, sslmode, applicationName }, credentials, client?.command ?? command, signal);
    state = await historyState(session, target, config, named);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return respond(['authentication', 'server', 'permission', 'client', 'database', 'tls'].includes(error.issue) ? error.issue : 'connection');
  }
  await resolveStartup(project, [], identity);
  const { rows } = state;
  if (state.conflict || rows.length > files.length || !rows.length && state.hasObjects) {
    return respond('history-conflict');
  }
  const local = new Map(files.map(file => [file.tag, file]));
  const applied = rows.map(([when, hash, tag], index) => {
    const file = named ? local.get(tag) : files[index];
    return file && hash === file.hash && (named ? /^\d+$/.test(when ?? '') : when === String(file.when)) ? file : undefined;
  });
  const appliedSet = new Set(applied);
  if (appliedSet.has(undefined) || appliedSet.size !== rows.length) return respond('history-conflict');
  const entries = selected => result.migrations.map((item, index) => ({ ...item, state: selected.has(files[index]) ? 'applied' : 'pending' }));
  const migrations = entries(appliedSet);
  if (rows.length && client?.migrationScope) result.rollbackTargets = [null, ...applied.slice(0, -1).map(file => file.tag)];
  if (rollback && !result.rollbackTargets) throw new Error(badRollback);
  const reverse = rollback && await reviewedRollback(root, rollback, applied, rows.length, signal);
  const pending = files.filter(file => !appliedSet.has(file));
  if (!reverse && !pending.length) {
    if (approval) throw new Error(changed);
    return respond('current', { migrations });
  }
  const additions = reverse ? [] : pending.map(file => drizzleStatements(file.sql));
  const review = additions.some(items => !items) && Boolean(client?.migrationScope);
  const statements = review ? pending.map(file => drizzleStatements(file.sql, { expanded: true })) : additions;
  if (statements.some(items => !items)) {
    if (approval) throw new Error(changed);
    return respond('pending', { migrations, applyBlocked: true });
  }
  const reviewSql = reverse ? '-- ' + reverse.scriptFile + '\n' + reverse.sql :
    review ? pending.map(({ file, sql }) => '-- ' + location + file + '\n' + sql).join('\n\n') : undefined;
  if (reviewSql && Buffer.byteLength(reviewSql) > 256 * 1024) {
    if (approval) throw new Error(changed);
    return respond('pending', { migrations, applyBlocked: true });
  }
  const scope = client?.migrationScope && await client.migrationScope();
  const expiry = approval ? /^\d{13}(?=\.)/.exec(approval.planId ?? '')?.[0] : String(Date.now() + 300000);
  const signature = createHmac('sha256', signingKey).update(JSON.stringify([
    expiry, project.id, identity, requirement.id, target, value, config.historySchema, config.historyTable, scope?.container,
    state.header, rows, format, files.map(({ file, when, hash }) => [file, when, hash]),
    reverse && [reverse.revision, reverse.scriptFile, createHash('sha256').update(reverse.sql).digest('hex')]
  ])).digest('hex');
  const planId = expiry + '.' + signature;
  const range = reverse && { fromRevision: applied.at(-1).tag, toRevision: reverse.revision ?? 'base' };
  if (!approval) return respond(reverse ? 'rollback-planned' : 'pending', { migrations, planId, ...range, ...(reviewSql && { reviewSql }) });
  if (!expiry || Number(expiry) <= Date.now() || approval.planId !== planId || approval.confirmName !== target.name) throw new Error(changed);
  await verifyTarget(target);
  const latest = (await discoverDatabases(project, { includeConnections: true })).connections.get(requirement.id);
  if (!latest || latest.environmentConflict || latest.value !== value || latest.out !== config.out ||
      historyName(latest) !== historyName(config)) throw new Error(changed);
  await resolveStartup(project, [], identity);
  await scope?.verify();
  throwIfCancelled(signal);
  const execute = sql => 'EXECUTE ' + pgText(sql) + ';';
  const table = historyName(config);
  const remaining = reverse ? applied.slice(0, reverse.next) : [...applied, ...pending];
  const newEntries = pending.map(file => [String(file.when), file.hash, ...(named ? [file.tag] : [])]);
  const expectedRows = reverse ? rows.slice(0, reverse.next) : [...rows, ...newEntries];
  const removed = reverse && (named ? 'name IN (' + applied.slice(reverse.next).map(file => "'" + file.tag + "'").join(',') + ')' :
    'created_at >= ' + applied[reverse.next].when);
  const commands = reverse ? [...reverse.statements.map(execute), 'DELETE FROM ' + table + ' WHERE ' + removed + ';'] :
    pending.flatMap((file, index) => [
      ...statements[index].map(execute), `INSERT INTO ${table} (hash, created_at${named ? ', name' : ''}) VALUES
        ('${file.hash}', ${file.when}${named ? ", '" + file.tag + "'" : ''});`
    ]);
  try {
    await writeMigration(session, target, config, state, commands, expectedRows, named);
  } catch (error) {
    await scope?.cancel(applicationName).catch(() => {});
    if (error.name === 'AbortError') throw error;
    return respond('apply-failed');
  }
  try {
    const after = await historyState(session, target, config, named);
    if (JSON.stringify(after.rows) !== JSON.stringify(expectedRows) ||
        JSON.stringify(after.header?.slice(0, 4)) !== JSON.stringify(state.header.slice(0, 4))) {
      return respond('apply-unverified');
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return respond('apply-unverified');
  }
  if (scope) result.rollbackTargets = remaining.length ? [null, ...remaining.slice(0, -1).map(file => file.tag)] : [];
  return respond(reverse ? 'rolled-back' : 'applied', { migrations: entries(new Set(remaining)) });
}
