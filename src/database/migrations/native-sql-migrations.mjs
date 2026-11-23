import { createHmac, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { throwIfCancelled } from '../../platform/process.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { localSession } from '../adapters/local.mjs';
import { migrationImage, runMigrationContainer } from '../docker/migration-container.mjs';
import { databaseKey, discoverDatabases } from '../discovery.mjs';
import { flywayChecksum, previewFlyway } from './flyway-preview.mjs';
import { implicitSpringFlywayProperties } from './flyway-config.mjs';
import { previewLiquibase } from './liquibase-preview.mjs';
import { validLiquibaseTag } from './liquibase-changelog.mjs';
import { reviewedStructuredLiquibase } from './liquibase-execution-source.mjs';
import { readMigrationFile } from './migration-files.mjs';
import { mysqlHistoryTable } from './mysql-history.mjs';
import { postgresHistoryTable } from './postgres-history-table.mjs';
import { compareSqlMigrationHistory } from './sql-migration-history.mjs';

const badSource = 'The detected configuration needs the project’s own migration tool.';
const changed = 'The migration plan changed or expired. Preview it again.';
const unsafeHistory = 'Check the migration history and target database before preparing a write.';
const noChanges = 'There are no eligible migrations for this operation.';
const badTag = 'Choose a unique Liquibase tag recorded in the selected database.';
const badRollback = 'Liquibase could not generate reviewable rollback SQL for this range.';
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
  if (adapter === 'flyway' && source.implicitLocations) return implicitSpringFlywayProperties(text);
  let lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim());
  if (source.scope === 'spring') {
    if (lines.some(line => /^[#!]---$|^spring\.config\.(?:import|activate)\b/i.test(line))) return false;
    const prefix = 'spring.' + adapter + '.';
    lines = lines.filter(line => line.toLowerCase().startsWith(prefix)).map(line => line.slice('spring.'.length));
    if (!lines.length) return false;
  } else lines = lines.filter(line => line && !/^[#!]/.test(line));
  if (adapter === 'flyway' && source.source.endsWith('flyway.toml')) {
    return lines.length === 2 && lines[0] === '[flyway]' && /^locations\s*=/.test(lines[1]);
  }
  return lines.every(line => {
    const match = /^([\w.-]+)\s*[:=]\s*(.*)$/.exec(line);
    return match && !match[2].endsWith('\\') && (tools[adapter].config.test(match[1]) ||
      source.scope === 'spring' && (match[1] === adapter + '.enabled' && match[2].trim() === 'true' ||
        adapter === 'liquibase' && /^liquibase\.change-?log$/i.test(match[1])));
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
  const flyway = adapter === 'flyway';
  const spring = source?.scope === 'spring' && !source.profile && /(?:^|\/)application\.properties$/i.test(source.source);
  if (source?.scope !== 'standalone' && !spring) throw new Error(badSource);
  const preview = await (flyway ? previewFlyway : previewLiquibase)(project, sourceId, signal, { scanned });
  if (preview.status !== 'ready') throw new Error(badSource);
  const folder = [source.directory === '.' ? '' : source.directory, source.resourceRoot].filter(Boolean).map(dir => dir + '/').join('');
  const entrypoint = preview.changelog?.slice(folder.length);
  const files = new Map(), checksums = new Map();
  const undoByFile = new Map();
  let structured = false, remaining = 8 * 1024 ** 2;
  let config;
  try {
    config = await readMigrationFile(join(root, source.source), 64 * 1024);
    if (!reviewedConfig(adapter, source, config)) throw new Error();
    const paths = flyway ? preview.migrations.map(item => item.file) : preview.files;
    if (!flyway && (!entrypoint || !preview.changelog.startsWith(folder))) throw new Error();
    if (flyway && preview.migrations.some(item => !['versioned', 'repeatable'].includes(item.kind))) throw new Error();
    for (const file of paths) {
      throwIfCancelled(signal);
      const path = flyway ? posix.basename(file) : file.slice(folder.length);
      if (!file.startsWith(folder) || !path.split('/').every(part => portableName.test(part)) || files.has(path) || remaining <= 0) throw new Error();
      const sql = await readMigrationFile(join(root, file), Math.min(remaining, 512 * 1024));
      if (flyway && (/\$\{/.test(sql) || await lstat(join(root, file + '.conf')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      }))) throw new Error();
      remaining -= Buffer.byteLength(sql);
      files.set(path, sql);
      if (flyway) checksums.set(path, flywayChecksum(sql));
      else if (/\.sql$/i.test(path)) {
        undoByFile.set(file, formattedChanges(sql, preview.changes.filter(item => item.file === file)).slice());
      } else {
        if (!reviewedStructuredLiquibase(path, sql)) throw new Error();
        structured = true;
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(badSource);
  }
  const rollback = preview.changes?.map(item => undoByFile.get(item.file)?.shift());
  return { directory: source.directory, folder, preview, checksums, files, rollback, structured, entrypoint,
    fingerprint: databaseKey(source, config, [...files]) };
}

export async function migrationDatabaseIdentity(session, name, { schema, table }, adapter) {
  const tracking = adapter === 'liquibase' ? "'databasechangeloglock','" + table + "'" : "'" + table + "'";
  const userSchema = adapter === 'ef-core' && schema !== 'public' ? "n.nspname='" + schema + "'" :
    "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";
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
  return { id: databaseKey(result.slice(0, 3)), startedAt: result[1], oid: result[2], populated: result[3] };
}

async function mysqlDatabaseIdentity(session, scope, name, history, adapter) {
  const first = await scope.snapshot();
  const tracked = adapter === 'liquibase' ? "'DATABASECHANGELOGLOCK','" + history.table + "'" : "'" + history.table + "'";
  const raw = await session.query("SELECT JSON_ARRAY(DATABASE(), @@server_uuid, CAST(EXISTS(" +
    "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND BINARY table_name NOT IN (" + tracked + ") " +
    "UNION ALL SELECT 1 FROM information_schema.routines WHERE routine_schema = DATABASE() " +
    "UNION ALL SELECT 1 FROM information_schema.events WHERE event_schema = DATABASE() " +
    "UNION ALL SELECT 1 FROM information_schema.triggers WHERE trigger_schema = DATABASE()) AS UNSIGNED));", name);
  const [database, uuid, populated] = JSON.parse(raw);
  const last = await scope.snapshot();
  if (database !== name || uuid !== first.uuid || uuid !== last.uuid || ![0, 1].includes(populated)) throw new Error(unsafeHistory);
  if (first.cursor !== last.cursor) throw new Error(changed);
  return { id: databaseKey(uuid, name), cursor: last.cursor, populated: populated === 1 };
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
  const mysql = target.engine === 'mysql';
  const table = mysql ? '`' + history.table + '`' : '"' + history.schema + '"."' + history.table + '"';
  const rows = mysql ? (await session.query(`START TRANSACTION READ ONLY;
    SELECT JSON_ARRAY(id, author, filename, orderexecuted, CAST(dateexecuted AS CHAR), tag)
    FROM ${table} ORDER BY dateexecuted, orderexecuted LIMIT ${applied + 1}; COMMIT;`, target.name))
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) :
    JSON.parse(await session.query(`BEGIN READ ONLY; SET LOCAL search_path = pg_catalog;
    SELECT coalesce(jsonb_agg(jsonb_build_array(id, author, filename, orderexecuted, dateexecuted::text, tag)
      ORDER BY dateexecuted, orderexecuted), '[]')
    FROM (SELECT id, author, filename, dateexecuted, orderexecuted, tag FROM ONLY ${table}
      ORDER BY dateexecuted, orderexecuted LIMIT ${applied + 1}) history; COMMIT;`, target.name));
  if (!Array.isArray(rows) || rows.length !== applied || rows.some(([id, author, file, order, date, tag], index) => {
    const migration = migrations[index];
    return id !== migration.id || author !== migration.author || file !== migration.file.slice(folder.length) ||
      !Number.isInteger(order) || !date || (tag !== null && typeof tag !== 'string') ||
      (index && date === rows[index - 1][4] && order === rows[index - 1][3]);
  })) throw new Error(unsafeHistory);
  return rows;
}

function liquibaseInvocation({ credentials, jdbc, history, entrypoint, command, count, tag, mysql, readOnly = false }) {
  const readOnlyOption = mysql ? '&sessionVariables=transaction_read_only=1' : '&options=-c%20default_transaction_read_only%3Don';
  const url = readOnly ? jdbc + readOnlyOption : jdbc;
  return {
    env: { LIQUIBASE_COMMAND_URL: url, LIQUIBASE_COMMAND_USERNAME: credentials.user, LIQUIBASE_COMMAND_PASSWORD: credentials.password },
    args: ['--secure-parsing=true', '--search-path=/stackforge', '--database-changelog-table-name=' + history.table,
      command, '--changelog-file=' + entrypoint, ...(mysql ? ['--driver=org.mariadb.jdbc.Driver'] :
        ['--default-schema-name=' + history.schema, '--liquibase-schema-name=' + history.schema]),
      ...(tag ? ['--tag=' + tag] : count ? ['--count=' + count] : [])]
  };
}

function rollbackSql(output, ranges, folder, tag) {
  const header = tag ? /^--[ \t]*rollback to '([^\r\n]+)' Script[ \t]*\r?$/mi :
    /^--[ \t]+Rollback \d+ Change\(s\) Script[ \t]*\r?$/m;
  const script = header.exec(output);
  const rows = [...output.matchAll(/^--[ \t]+Rolling Back ChangeSet:[ \t]+([^\r\n]+)/gm)].map(item => item[1].trimEnd());
  const range = ranges.find(items => items.length === rows.length && items.every((item, index) =>
    [item.file.slice(folder.length), item.id, item.author].join('::') === rows[index]));
  if (!script || (tag && script[1] !== tag) || output.length > 256 * 1024 || !range) throw new Error(badRollback);
  const sql = output.slice(script.index).replace(/^--[ \t]+(?:Ran at|Against):[^\r\n]*\r?\n/gm, '').trim();
  return { sql, range };
}

export async function nativeSqlMigration({ project, payload, target, client, signal, directory, verifyShared }) {
  const { adapter, operation, mode, sourceId } = payload;
  if (!Object.hasOwn(tools, adapter) || !['apply', 'rollback'].includes(operation) || !['preview', 'execute'].includes(mode) ||
      !projectId.test(sourceId ?? '') || !['mysql', 'postgres'].includes(target.engine)) throw new Error(badSource);
  const mysql = target.engine === 'mysql';
  if (adapter === 'flyway' && operation === 'rollback') throw new Error('Flyway rollback requires an eligible Undo tool and migration.');
  const tag = payload.rollbackTag;
  if (tag !== undefined && (adapter !== 'liquibase' || operation !== 'rollback' || payload.rollbackCount !== undefined ||
      !validLiquibaseTag(tag))) throw new Error(badTag);
  const tool = tools[adapter];
  const scanned = await discoverDatabases(project, { includeMigrations: true, includeConnections: true });
  const { identity } = scanned;
  const source = await readSource(project, adapter, sourceId, scanned, signal);
  const history = mysql ? mysqlHistoryTable(target.name, payload.table ?? (adapter === 'liquibase' ? 'DATABASECHANGELOG' : tool.table)) :
    postgresHistoryTable(payload.schema, payload.table, tool.table);
  const scope = await client.migrationScope();
  const image = await migrationImage(scope.cli, tool.image, mode === 'preview');
  if (!image) throw new Error(changed);
  const credentials = await client.credentials();
  const session = localSession(target, credentials, client.command, signal);
  const compare = () => compareSqlMigrationHistory({ adapter, preview: source.preview, history, checksums: source.checksums,
    resourcePrefix: source.folder, selection: target, credentials, resolveClient: async () => client, signal, includeFingerprint: true });
  const readIdentity = () => mysql ? mysqlDatabaseIdentity(session, scope, target.name, history, adapter) :
    migrationDatabaseIdentity(session, target.name, history, adapter);
  const before = await readIdentity();
  const state = await compare();
  const migrations = source.preview.migrations ?? source.preview.changes;
  const { applied, pending } = reviewedHistory(state, migrations, adapter);
  if (!applied && before.populated) throw new Error(unsafeHistory);
  const rollback = operation === 'rollback';
  const flywayTarget = adapter === 'flyway' && payload.revision !== undefined;
  let applyLimit = migrations.length;
  if (flywayTarget) {
    if (migrations.some(item => item.kind !== 'versioned')) throw new Error('Use Automatic when the Flyway source contains repeatable migrations.');
    applyLimit = migrations.findIndex(item => item.version === payload.revision) + 1;
    if (applyLimit <= applied) throw new Error('Choose a revision in the requested migration direction.');
  }
  const count = rollback && !tag ? payload.rollbackCount ?? 1 : 0;
  if (rollback && !tag && (!Number.isInteger(count) || count < 1 || count > applied)) {
    throw new Error('Choose a rollback count within the applied Liquibase changesets.');
  }
  if (tag && !applied) throw new Error(badTag);
  const order = rollback ? await rollbackOrder(session, target, history, migrations, applied, source.folder) : undefined;
  const orderKey = rollback ? databaseKey(order) : undefined;
  const taggedRows = tag ? order.flatMap((row, index) => row[5] === tag ? [index] : []) : [];
  if (tag && taggedRows.length !== 1) throw new Error(badTag);
  let expected = rollback ? applied - count : applyLimit;
  let range = rollback ? migrations.slice(expected, applied).reverse() :
    flywayTarget ? pending.slice(0, expected - applied) : pending;
  if (!tag && (!range.length || expected < 0)) throw new Error(noChanges);
  const undoGroups = rollback && !tag ? source.rollback?.slice(expected, applied).reverse() : undefined;
  const explicit = undoGroups?.length === count && undoGroups.every(group => group);
  async function verify() {
    await scope.verify();
    const current = await readIdentity();
    const currentState = await compare();
    if (databaseKey(current) !== databaseKey(before) || currentState.fingerprint !== state.fingerprint) throw new Error(changed);
    if (rollback && orderKey !== databaseKey(await rollbackOrder(session, target, history, migrations, applied, source.folder))) throw new Error(changed);
  }
  const application = 'stackforge_migration_' + randomBytes(12).toString('hex');
  const location = '://127.0.0.1:' + scope.port + '/' + target.name;
  const jdbc = mysql ? 'jdbc:mysql' + location + '?permitMysqlScheme=true&sslMode=trust&useSsl=true&trustServerCertificate=true' +
    '&allowLocalInfile=false&connectionAttributes=stackforgeMigration:' + application :
    'jdbc:postgresql' + location + '?ApplicationName=' + application;
  const runJob = invocation => runMigrationContainer({ ...scope, ...invocation, image, files: source.files, directory, signal, verify,
    cancel: () => scope.cancel(application) });
  const liquibase = ({ command, readOnly }) => liquibaseInvocation({ credentials, jdbc, history, entrypoint: source.entrypoint, command, count, tag, mysql, readOnly });
  let undo = explicit ? undoGroups.flat() : undefined;
  if (rollback && !undo) {
    if (!tag && !source.structured) throw new Error('Each selected changeset needs an explicit rollback statement.');
    const ranges = tag ? [taggedRows[0] + 1, taggedRows[0]].map(index => migrations.slice(index, applied).reverse()) : [range];
    try {
      const output = await runJob(liquibase({ command: tag ? 'rollback-sql' : 'rollback-count-sql', readOnly: true }));
      const result = rollbackSql(output, ranges, source.folder, tag);
      if (result.sql.includes(credentials.password)) throw new Error(badRollback);
      range = result.range;
      expected = applied - range.length;
      undo = [result.sql];
    } catch (error) {
      if (error.name === 'AbortError' || error.message === changed) throw error;
      throw new Error(badRollback);
    }
    if (!range.length) throw new Error(noChanges);
    await verify();
  }
  const expires = mode === 'preview' ? String(Date.now() + 5 * 60_000) : /^(\d{13})\.[a-f\d]{64}$/.exec(payload.planId ?? '')?.[1];
  const signature = createHmac('sha256', key).update(JSON.stringify([
    expires, project.id, identity, sourceId, source.fingerprint, operation, target, scope.container, image,
    history, before, state.fingerprint, applied, expected, orderKey, tag, undo
  ])).digest('hex');
  const planId = expires + '.' + signature;
  const plan = { target, tool: tool.name, version: tool.version, history, directory: source.directory, ...(tag && { rollbackTag: tag }),
    ...(flywayTarget && { fromRevision: migrations[applied - 1]?.version ?? 'base', toRevision: payload.revision }),
    migrations: range.map(item => ({ file: item.file, revision: item.version ?? item.description ?? item.author + ':' + item.id })), ...(undo && { undo }) };
  if (mode === 'preview') return { status: 'planned', planId, ...plan };
  if (!expires || Number(expires) <= Date.now() || payload.planId !== planId || payload.confirmName !== target.name) throw new Error(changed);

  await verifyShared(target);
  const latest = await discoverDatabases(project, { includeMigrations: true, includeConnections: true });
  if ((await readSource(project, adapter, sourceId, latest, signal)).fingerprint !== source.fingerprint) throw new Error(changed);
  await resolveStartup(project, [], identity);
  const invocation = adapter === 'flyway' ? {
    env: { FLYWAY_URL: jdbc, FLYWAY_USER: credentials.user, FLYWAY_PASSWORD: credentials.password },
    args: ['-locations=filesystem:/stackforge', '-defaultSchema=' + history.schema, '-table=' + history.table,
      '-baselineOnMigrate=false', '-validateOnMigrate=true', '-group=' + !mysql, '-cleanDisabled=true', '-placeholderReplacement=false',
      ...(mysql ? ['-driver=org.mariadb.jdbc.Driver'] : []),
      ...(flywayTarget ? ['-target=' + payload.revision] : []), 'migrate']
  } : liquibase({ command: rollback ? tag ? 'rollback' : 'rollback-count' : 'update' });
  try {
    await runJob(invocation);
  } catch (error) {
    if (error.name === 'AbortError' || error.message === changed) throw error;
    return { status: 'execution-failed' };
  }
  try {
    await scope.verify();
    const after = await readIdentity();
    const historyAfter = await compare();
    const verified = reviewedHistory(historyAfter, migrations, adapter);
    if (after.id !== before.id || verified.applied !== expected ||
        (operation === 'apply' && verified.pending.length !== migrations.length - expected) ||
        historyAfter.fingerprint === state.fingerprint) return { status: 'execution-unverified' };
    if (rollback && databaseKey(await rollbackOrder(session, target, history, migrations, expected, source.folder)) !==
        databaseKey(order.slice(0, expected))) return { status: 'execution-unverified' };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return { status: 'execution-unverified' };
  }
  return { status: operation === 'apply' ? 'applied' : 'rolled-back', ...plan };
}
