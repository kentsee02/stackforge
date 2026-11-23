import { createHash, createHmac, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { throwIfCancelled } from '../../platform/process.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { localSession } from '../adapters/local.mjs';
import { databaseKey } from '../discovery.mjs';
import { compareEfCoreHistory, efCoreHistoryColumns, efCoreHistoryTable } from './ef-core-history.mjs';
import { scanEfCore } from './ef-core-preview.mjs';
import { efPostgresStatements } from './ef-core-sql.mjs';
import { efSqlServerIdentity, efSqlServerStatements, efSqlServerTransaction } from './ef-core-tsql.mjs';
import { sqlServerHistoryTable } from './sql-server-history.mjs';
import { readMigrationFile } from './migration-files.mjs';
import { migrationDatabaseIdentity } from './native-sql-migrations.mjs';
import { postgresHistoryMetadata } from './postgres-history-table.mjs';

const signingKey = randomBytes(32);
const changed = 'The migration plan changed or expired. Preview it again.';
const unsupported = 'Choose a supported PostgreSQL EF Core migration SQL file inside the project.';
const invalidHistory = 'Check the migration history and target database before preparing a write.';

const pgText = text => "pg_catalog.convert_from(pg_catalog.decode('" + Buffer.from(text, 'utf8').toString('hex') + "', 'hex'), 'UTF8')";
const jsonSql = value => pgText(JSON.stringify(value)) + '::jsonb';

async function sourceFiles(root, source, file, migrations, signal, parse, invalid) {
  if (typeof file !== 'string' || file.length > 380 || !/\.sql$/i.test(file) ||
      file.split('/').some(part => !/^[\w][\w .-]*$/.test(part) || /[. ]$/.test(part))) throw new Error(invalid);
  try {
    const sql = (await readMigrationFile(join(root, file), 256 * 1024)).replace(/^\uFEFF/, '');
    const statements = parse(sql);
    if (!statements) throw new Error();
    const files = new Set([source, ...migrations.map(item => item.file)]);
    const contents = [];
    let budget = 12 * 1024 ** 2;
    for (const path of files) {
      throwIfCancelled(signal);
      const encoded = await readMigrationFile(join(root, path), Math.min(budget, 512 * 1024), buffer => buffer);
      budget -= encoded.length;
      contents.push([path, createHash('sha256').update(encoded).digest('hex')]);
    }
    return { sql, statements, digest: databaseKey(sql, contents) };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(invalid);
  }
}

function appliedIds(state, migrations) {
  if (state.status === 'history-missing') return [];
  if (!['current', 'pending'].includes(state.status)) throw new Error(invalidHistory);
  const applied = state.migrations.filter(item => item.state === 'applied').map(item => item.id);
  if (!migrations.slice(0, applied.length).every(({ id }, index) => id === applied[index])) throw new Error(invalidHistory);
  return applied;
}

function guardedScript(history, before, relationId, current, expected, statements) {
  const relation = '"' + history.schema + '"."' + history.table + '"';
  const metadata = postgresHistoryMetadata(history, efCoreHistoryColumns);
  const ids = `SELECT COALESCE(jsonb_agg("MigrationId" ORDER BY "MigrationId" COLLATE "C"), '[]') FROM ONLY ${relation}`;
  const verifyBefore = relationId ? `
    IF NOT EXISTS (SELECT FROM (${metadata}) h WHERE h.readable AND h.oid::text = '${relationId}')
      THEN RAISE EXCEPTION 'History relation changed'; END IF;
    LOCK TABLE ONLY ${relation} IN SHARE ROW EXCLUSIVE MODE;
    IF NOT EXISTS (SELECT FROM (${metadata}) h WHERE h.readable AND h.oid::text = '${relationId}')
      OR (${ids}) IS DISTINCT FROM ${jsonSql([...current].sort())} THEN RAISE EXCEPTION 'History changed'; END IF;` :
    `IF EXISTS (SELECT FROM (${metadata}) h) THEN RAISE EXCEPTION 'History changed'; END IF;`;
  return `BEGIN;
  SET LOCAL search_path = pg_catalog;
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '130s';
  SELECT pg_advisory_xact_lock(hashtext('stackforge:ef-core'));
  DO $stackforge_ef$ BEGIN
    IF pg_postmaster_start_time()::text IS DISTINCT FROM ${pgText(before.startedAt)}
      OR (SELECT oid::text FROM pg_database WHERE datname=current_database()) IS DISTINCT FROM ${pgText(before.oid)}
      THEN RAISE EXCEPTION 'Database target changed'; END IF;
    ${verifyBefore}
    SET LOCAL search_path TO DEFAULT;
    ${statements.map(sql => 'EXECUTE ' + pgText(sql) + ';').join('\n    ')}
    SET LOCAL search_path = pg_catalog;
    IF NOT EXISTS (SELECT FROM (${metadata}) h WHERE h.readable)
      THEN RAISE EXCEPTION 'History could not be verified'; END IF;
    IF (${ids}) IS DISTINCT FROM ${jsonSql([...expected].sort())}
      THEN RAISE EXCEPTION 'SQL did not record the expected EF Core migrations'; END IF;
  END $stackforge_ef$;
  COMMIT;`;
}

export async function nativeEfCoreMigration({ project, payload, target, client, signal, verifyShared }) {
  const { mode, operation, sourceId, groupId, scriptFile } = payload;
  const sqlServer = target.engine === 'sqlserver';
  const invalid = sqlServer ? 'Choose a supported SQL Server EF Core migration SQL file inside the project.' : unsupported;
  if (!['preview', 'execute'].includes(mode) || !['apply', 'rollback'].includes(operation)) throw new Error(invalid);
  const { root, identity } = await resolveStartup(project, []);
  const preview = await scanEfCore(project, { sourceId, signal });
  const group = preview.groups?.find(item => item.id === groupId);
  if (preview.status !== 'ready' || !group || group.migrations.some(item => !item.verified)) {
    throw new Error('Choose a verified EF Core DbContext and rescan if it changed.');
  }
  const readSource = () => sourceFiles(root, preview.source, scriptFile, group.migrations, signal,
    sqlServer ? efSqlServerStatements : efPostgresStatements, invalid);
  const source = await readSource();
  const history = (sqlServer ? sqlServerHistoryTable : efCoreHistoryTable)(payload.schema, payload.table);
  const scope = await client.migrationScope();
  const credentials = sqlServer ? undefined : await client.credentials();
  const applicationName = 'stackforge_migration_' + randomBytes(12).toString('hex');
  const session = sqlServer ? undefined : localSession({ ...target, applicationName }, credentials, client.command, signal);
  const readIdentity = () => sqlServer ? efSqlServerIdentity(scope.query, target, history) :
    migrationDatabaseIdentity(session, target.name, history, 'ef-core');
  const compare = () => compareEfCoreHistory({ group, history, selection: { ...target, ...(sqlServer && { projectSqlServer: true }) }, credentials,
    resolveClient: async () => sqlServer ? { sqlServerQuery: scope.query } : client,
    signal, includeRelation: true });
  const before = await readIdentity();
  const state = await compare();
  const current = appliedIds(state, group.migrations);
  if (state.relation === undefined || !/^(?:\d+)?$/.test(state.relation) || !current.length && before.populated) throw new Error(invalidHistory);
  const { migrations } = group;
  const selected = payload.revision ?? (operation === 'apply' ? migrations.at(-1).id : migrations[current.length - 2]?.id ?? 'base');
  const next = selected === 'base' ? 0 : migrations.findIndex(item => item.id === selected) + 1;
  if (selected !== 'base' && !next || (operation === 'apply' ? next <= current.length : next >= current.length)) {
    throw new Error('Choose a revision in the requested migration direction.');
  }
  const expected = migrations.slice(0, next).map(item => item.id);
  const range = operation === 'apply' ? migrations.slice(current.length, next) : migrations.slice(next, current.length).reverse();
  const expires = mode === 'preview' ? String(Date.now() + 300000) : /^(\d{13})\.[a-f\d]{64}$/.exec(payload.planId ?? '')?.[1];
  const signature = createHmac('sha256', signingKey).update(JSON.stringify([
    expires, project.id, identity, sourceId, groupId, source.digest, scriptFile, operation, selected,
    target, scope.container, history, before, state.relation, current
  ])).digest('hex');
  const planId = expires + '.' + signature;
  const plan = { target, history, tool: 'EF Core', version: '', directory: dirname(preview.source).replaceAll('\\', '/'),
    fromRevision: current.at(-1) ?? 'base', toRevision: selected, scriptFile,
    migrations: range.map(({ file, id }) => ({ file, revision: id })) };
  if (mode === 'preview') return { status: 'planned', planId, ...plan, sql: source.sql };
  if (!expires || Number(expires) <= Date.now() || payload.planId !== planId || payload.confirmName !== target.name) throw new Error(changed);
  await verifyShared(target);
  const refreshed = await scanEfCore(project, { sourceId, signal });
  if (refreshed.status !== 'ready' || !refreshed.groups?.some(item => item.id === groupId) ||
      (await readSource()).digest !== source.digest) throw new Error(changed);
  await resolveStartup(project, [], identity);
  await scope.verify();
  if (databaseKey(await readIdentity()) !== databaseKey(before)) throw new Error(changed);
  throwIfCancelled(signal);
  try {
    if (sqlServer) await scope.query(efSqlServerTransaction({ target, history, before, relationId: state.relation,
      current, expected, statements: source.statements, applicationName }), { timeout: 140000 });
    else await session.query(guardedScript(history, before, state.relation, current, expected, source.statements), target.name, { timeout: 140000 });
  } catch (error) {
    await scope.cancel(applicationName).catch(() => {});
    if (error.name === 'AbortError') throw error;
    return { status: 'execution-failed' };
  }
  try {
    if ((await readIdentity()).id !== before.id || databaseKey(appliedIds(await compare(), migrations)) !== databaseKey(expected)) {
      return { status: 'execution-unverified' };
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return { status: 'execution-unverified' };
  }
  return { status: operation === 'apply' ? 'applied' : 'rolled-back', ...plan };
}
