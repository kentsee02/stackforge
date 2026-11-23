import { createHmac, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { throwIfCancelled } from '../../platform/process.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { localSession } from '../adapters/local.mjs';
import { migrationImage, runMigrationContainer } from '../docker/migration-container.mjs';
import { databaseKey, discoverDatabases } from '../discovery.mjs';
import { flywayChecksum, previewFlyway } from './flyway-preview.mjs';
import { previewLiquibase } from './liquibase-preview.mjs';
import { readMigrationFile } from './migration-files.mjs';
import { postgresHistoryTable } from './postgres-history-table.mjs';
import { compareSqlMigrationHistory } from './sql-migration-history.mjs';

const badSource = 'The detected configuration needs the project’s own migration tool.';
const changed = 'The migration plan changed or expired. Preview it again.';
const unsafeHistory = 'Check the migration history and target database before preparing a write.';
const noChanges = 'There are no eligible migrations for this operation.';
const tools = {
  flyway: { version: '11.20.3', name: 'Flyway',
    image: 'flyway/flyway@sha256:01605f443e1a891b3762f66e66d92403c33b6e0c29099ad550af94b6c1cbc3c1',
    table: 'flyway_schema_history', config: /^flyway\.(?:locations|url|user|password)$/i },
  liquibase: { version: '4.33.0', name: 'Liquibase',
    image: 'liquibase/liquibase@sha256:e116c935ba22b59a22165207f65c268e363269de30bb1fedacff3755c2abaa8c',
    table: 'databasechangelog', config: /^(?:(?:liquibase\.)?(?:command\.)?)?(?:changelogfile|url|username|password)$/i }
};
const key = randomBytes(32);
const projectId = /^[a-f\d]{64}$/;
const portableName = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

function reviewedConfig(adapter, source, text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^[#!]/.test(line));
  if (adapter === 'flyway' && source.endsWith('flyway.toml')) {
    return lines.length === 2 && lines[0] === '[flyway]' && /^locations\s*=/.test(lines[1]);
  }
  return lines.every(line => {
    const match = /^([\w.]+)\s*[:=]\s*(.*)$/.exec(line);
    return match && !match[2].endsWith('\\') && tools[adapter].config.test(match[1]);
  });
}

function formattedChanges(text, changes) {
  const headers = [...text.matchAll(/^[ \t]*--[ \t]*changeset[ \t]+([\w.-]+):([\w.-]+)[ \t]*\r?$/gmi)];
  if (headers.length !== changes.length || /\$\{/.test(text) ||
      /^[ \t]*--[ \t]*(?:include|includeAll|preconditions?|validCheckSum|rollbackSqlFile|rollbackEnd|rollbackStart|ignore)\b/im.test(text)) {
    throw new Error(badSource);
  }
  return headers.map((header, index) => {
    const item = changes[index];
    if (item.author !== header[1] || item.id !== header[2] || item.logicalFilePath) throw new Error(badSource);
    const body = text.slice(header.index + header[0].length, headers[index + 1]?.index);
    const rollback = [...body.matchAll(/^[ \t]*--[ \t]*rollback[ \t]+([^\r\n]+)$/gmi)].map(match => match[1].trim());
    return rollback.length && rollback.join('\n').length <= 12000 && rollback.every(sql => sql && !/^empty$/i.test(sql)) ? rollback : undefined;
  });
}

async function readSource(project, adapter, sourceId, scanned, signal) {
  const { root, migrationSources } = scanned;
  const source = migrationSources.find(item => item.adapter === adapter && item.id === sourceId);
  if (source?.scope !== 'standalone') throw new Error(badSource);
  const flyway = adapter === 'flyway';
  const preview = await (flyway ? previewFlyway : previewLiquibase)(project, sourceId, signal, { scanned });
  if (preview.status !== 'ready') throw new Error(badSource);
  const folder = source.directory === '.' ? '' : source.directory + '/';
  const files = new Map(), checksums = new Map();
  let rollback, remaining = 8 * 1024 ** 2;
  let config;
  try {
    config = await readMigrationFile(join(root, source.source), 64 * 1024);
    if (!reviewedConfig(adapter, source.source, config)) throw new Error();
    const paths = flyway ? preview.migrations.map(item => item.file) : preview.files;
    if (!flyway && (paths.length !== 1 || !/\.sql$/i.test(paths[0]) || source.resourceRoot)) throw new Error();
    if (flyway && preview.migrations.some(item => !['versioned', 'repeatable'].includes(item.kind))) throw new Error();
    for (const file of paths) {
      throwIfCancelled(signal);
      const path = flyway ? posix.basename(file) : file.slice(folder.length);
      if (!path.split('/').every(part => portableName.test(part)) || files.has(path) || remaining <= 0) throw new Error();
      const sql = await readMigrationFile(join(root, file), Math.min(remaining, 512 * 1024));
      if (flyway && (/\$\{/.test(sql) || await lstat(join(root, file + '.conf')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      }))) throw new Error();
      remaining -= Buffer.byteLength(sql);
      files.set(path, sql);
      if (flyway) checksums.set(path, flywayChecksum(sql));
      else rollback = formattedChanges(sql, preview.changes);
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(badSource);
  }
  return { directory: source.directory, folder, preview, checksums, files, rollback,
    fingerprint: databaseKey(source, config, [...files]) };
}

async function databaseIdentity(session, name, { schema, table }, adapter) {
  const tracking = adapter === 'liquibase' ? "'databasechangeloglock','" + table + "'" : "'" + table + "'";
  const userSchema = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";
  const result = JSON.parse(await session.query("BEGIN READ ONLY; SET LOCAL search_path = pg_catalog; " +
    "SELECT jsonb_build_array(current_database(), pg_postmaster_start_time()::text, " +
    "(SELECT oid::text FROM pg_database WHERE datname=current_database()), " +
    "EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE " + userSchema +
    " AND c.relkind IN ('r','p','v','m','S','f','c') AND NOT (n.nspname='" + schema + "' AND c.relname IN (" + tracking + "))) " +
    "OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE " + userSchema + ") " +
    "OR EXISTS (SELECT FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE " + userSchema +
    " AND t.typtype IN ('e','d','r','m'))); COMMIT;", name));
  if (!Array.isArray(result) || result.length !== 4 || result[0] !== name || !result[1] || !/^\d+$/.test(result[2]) ||
      typeof result[3] !== 'boolean') throw new Error(unsafeHistory);
  return { id: databaseKey(result.slice(0, 3)), populated: result[3] };
}

function reviewedHistory(state, migrations, adapter) {
  if (state.status === 'history-missing') return { applied: 0, pending: migrations };
  if (!['recorded', 'pending'].includes(state.status) || state.items?.length !== migrations.length) throw new Error(unsafeHistory);
  const appliedState = adapter === 'flyway' ? 'applied' : 'recorded';
  const pending = [];
  let applied = 0, gap = false;
  for (const [index, migration] of migrations.entries()) {
    const { state: status } = state.items[index];
    const repeatable = migration.kind === 'repeatable';
    if (status === 'pending' || repeatable && status === 'outdated') {
      pending.push(migration);
      if (status === 'outdated') applied++;
      if (!repeatable) gap = true;
    } else if (status === appliedState && (!gap || repeatable)) {
      applied++;
    } else throw new Error(unsafeHistory);
  }
  return { applied, pending };
}

async function rollbackOrder(session, target, history, migrations, applied, folder) {
  const table = '"' + history.schema + '"."' + history.table + '"';
  const rows = JSON.parse(await session.query(`BEGIN READ ONLY; SET LOCAL search_path = pg_catalog;
    SELECT coalesce(jsonb_agg(jsonb_build_array(id, author, filename, orderexecuted, dateexecuted::text)
      ORDER BY dateexecuted, orderexecuted), '[]')
    FROM (SELECT id, author, filename, dateexecuted, orderexecuted FROM ONLY ${table}
      ORDER BY dateexecuted, orderexecuted LIMIT ${applied + 1}) history; COMMIT;`, target.name));
  if (!Array.isArray(rows) || rows.length !== applied || rows.some(([id, author, file, order, date], index) => {
    const migration = migrations[index];
    return id !== migration.id || author !== migration.author || file !== migration.file.slice(folder.length) ||
      !Number.isInteger(order) || (index && order <= rows[index - 1][3]) || !date;
  })) throw new Error(unsafeHistory);
  return databaseKey(rows);
}

export async function nativeSqlMigration({ project, payload, target, client, signal, directory, verifyShared }) {
  const { adapter, operation, mode, sourceId } = payload;
  if (!Object.hasOwn(tools, adapter) || !['apply', 'rollback'].includes(operation) || !['preview', 'execute'].includes(mode) ||
      !projectId.test(sourceId ?? '') || target.engine !== 'postgres') throw new Error(badSource);
  if (adapter === 'flyway' && operation === 'rollback') throw new Error('Flyway rollback requires an eligible Undo tool and migration.');
  const tool = tools[adapter];
  const scanned = await discoverDatabases(project, { includeMigrations: true, includeConnections: true });
  const { identity } = scanned;
  const source = await readSource(project, adapter, sourceId, scanned, signal);
  const history = postgresHistoryTable(payload.schema, payload.table, tool.table);
  const scope = await client.migrationScope();
  const image = await migrationImage(scope.cli, tool.image, mode === 'preview');
  if (!image) throw new Error(changed);
  const credentials = await client.credentials();
  const session = localSession(target, credentials, client.command, signal);
  const compare = () => compareSqlMigrationHistory({ adapter, preview: source.preview, history, checksums: source.checksums,
    resourcePrefix: source.folder, selection: target, credentials, resolveClient: async () => client, signal, includeFingerprint: true });
  const readIdentity = () => databaseIdentity(session, target.name, history, adapter);
  const before = await readIdentity();
  const state = await compare();
  const migrations = source.preview.migrations ?? source.preview.changes;
  const { applied, pending } = reviewedHistory(state, migrations, adapter);
  if (!applied && before.populated) throw new Error(unsafeHistory);
  const expected = operation === 'apply' ? migrations.length : applied - 1;
  const range = operation === 'apply' ? pending : migrations.slice(applied - 1, applied);
  if (!range.length || expected < 0) throw new Error(noChanges);
  const undo = operation === 'rollback' ? source.rollback?.[expected] : undefined;
  if (operation === 'rollback' && !undo) throw new Error('The last applied changeset needs an explicit rollback statement.');
  const order = undo ? await rollbackOrder(session, target, history, migrations, applied, source.folder) : undefined;
  const expires = mode === 'preview' ? String(Date.now() + 5 * 60_000) : /^(\d{13})\.[a-f\d]{64}$/.exec(payload.planId ?? '')?.[1];
  const signature = createHmac('sha256', key).update(JSON.stringify([
    expires, project.id, identity, sourceId, source.fingerprint, operation, target, scope.container, image,
    history, before, state.fingerprint, applied, expected, order
  ])).digest('hex');
  const planId = expires + '.' + signature;
  const plan = { target, tool: tool.name, version: tool.version, history, directory: source.directory,
    migrations: range.map(item => ({ file: item.file, revision: item.version ?? item.description ?? item.author + ':' + item.id })), ...(undo && { undo }) };
  if (mode === 'preview') return { status: 'planned', planId, ...plan };
  if (!expires || Number(expires) <= Date.now() || payload.planId !== planId || payload.confirmName !== target.name) throw new Error(changed);

  await verifyShared(target);
  const latest = await discoverDatabases(project, { includeMigrations: true, includeConnections: true });
  if ((await readSource(project, adapter, sourceId, latest, signal)).fingerprint !== source.fingerprint) throw new Error(changed);
  await resolveStartup(project, [], identity);
  async function verify() {
    await scope.verify();
    const current = await readIdentity();
    const currentState = await compare();
    if (databaseKey(current) !== databaseKey(before) || currentState.fingerprint !== state.fingerprint) throw new Error(changed);
    if (undo && order !== await rollbackOrder(session, target, history, migrations, applied, source.folder)) throw new Error(changed);
  }
  const application = 'stackforge_migration_' + randomBytes(12).toString('hex');
  const jdbc = 'jdbc:postgresql://127.0.0.1:' + scope.port + '/' + target.name + '?ApplicationName=' + application;
  const invocation = adapter === 'flyway' ? {
    env: { FLYWAY_URL: jdbc, FLYWAY_USER: credentials.user, FLYWAY_PASSWORD: credentials.password },
    args: ['-locations=filesystem:/stackforge', '-defaultSchema=' + history.schema, '-table=' + history.table,
      '-baselineOnMigrate=false', '-validateOnMigrate=true', '-group=true', '-cleanDisabled=true', '-placeholderReplacement=false', 'migrate']
  } : {
    env: { LIQUIBASE_COMMAND_URL: jdbc, LIQUIBASE_COMMAND_USERNAME: credentials.user, LIQUIBASE_COMMAND_PASSWORD: credentials.password },
    args: ['--search-path=/stackforge', '--database-changelog-table-name=' + history.table,
      operation === 'apply' ? 'update' : 'rollback-count',
      '--changelog-file=' + [...source.files.keys()][0], '--default-schema-name=' + history.schema,
      '--liquibase-schema-name=' + history.schema, ...(undo ? ['--count=1'] : [])]
  };
  try {
    await runMigrationContainer({ ...scope, ...invocation, image, files: source.files, directory, signal, verify,
      cancel: () => scope.cancel(application) });
  } catch (error) {
    if (error.name === 'AbortError' || error.message === changed) throw error;
    return { status: 'execution-failed' };
  }
  try {
    const after = await readIdentity();
    const historyAfter = await compare();
    const verified = reviewedHistory(historyAfter, migrations, adapter);
    if (after.id !== before.id || verified.applied !== expected || (operation === 'apply' && verified.pending.length) ||
        historyAfter.fingerprint === state.fingerprint) return { status: 'execution-unverified' };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return { status: 'execution-unverified' };
  }
  return { status: operation === 'apply' ? 'applied' : 'rolled-back', ...plan };
}
