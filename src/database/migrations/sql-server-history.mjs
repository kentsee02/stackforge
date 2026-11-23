import { databaseKey, databaseName } from '../discovery.mjs';
import { localhostEndpoint } from '../adapters/local.mjs';
import { queryLocalSqlServer, sqlServerAuth } from '../adapters/sql-server-session.mjs';

const loopback = new Set(['localhost', '127.0.0.1', '::1']);
const maxRows = 1024;

export function sqlServerHistoryTargets({ requirements, connections }) {
  const targets = [];
  for (const item of requirements) {
    if (item.engine !== 'sqlserver' || item.status !== 'configured' || !loopback.has(item.host) ||
        !databaseName.test(item.name) || /^(?:master|tempdb|model|msdb)$/i.test(item.name) ||
        !Number.isInteger(item.port) || item.port < 1 || item.port > 65535) continue;
    const auth = sqlServerAuth(connections.get(item.id)?.sqlServerAuth);
    if (!auth) continue;
    const { host, port, name, source, directory } = item;
    targets.push({ public: { id: databaseKey('ef-core-sqlserver', item.id, host, port, name), engine: 'sqlserver',
      host, port, name, source, directory }, credentials: auth });
  }
  return targets;
}

export function sqlServerHistoryTable(schema = 'dbo', table = '__EFMigrationsHistory') {
  const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
  if (!identifier.test(schema) || !identifier.test(table) || typeof schema !== 'string' || typeof table !== 'string' ||
      /^(?:sys|information_schema)$/i.test(schema)) throw new Error('Enter a valid SQL Server history schema and table name.');
  return { schema, table };
}

function tableQuery({ schema, table }) {
  const relation = `[${schema}].[${table}]`;
  return `SET NOCOUNT ON;
SET LOCK_TIMEOUT 4000;
SELECT DB_NAME();
DECLARE @id int = OBJECT_ID(N'${relation}');
IF @id IS NULL SELECT 'absent';
ELSE IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE object_id = @id AND is_memory_optimized = 0)
  OR EXISTS (SELECT 1 FROM sys.security_predicates WHERE target_object_id = @id)
  OR (SELECT COUNT(*) FROM sys.columns WHERE object_id = @id AND is_computed = 0
    AND name IN (N'MigrationId', N'ProductVersion') AND system_type_id IN (167, 231)) <> 2
  SELECT 'unsupported';
ELSE BEGIN
  SELECT 'readable';
  EXEC sys.sp_executesql N'SELECT TOP (${maxRows + 1}) CASE WHEN DATALENGTH(CONVERT(nvarchar(max), MigrationId)) <= 286
    THEN CONVERT(varchar(572), CONVERT(varbinary(286), CONVERT(nvarchar(143), MigrationId)), 2) ELSE ''invalid'' END
    FROM ${relation};';
END;`;
}

export async function readSqlServerHistory({ selection, credentials, command, probe, signal }, history) {
  const { host, port, name } = selection;
  const target = { host, port, name, engine: 'sqlserver' };
  if (host === 'localhost') {
    const address = await localhostEndpoint(port, probe);
    if (!address) return { target, status: 'loopback-ambiguous' };
    target.host = address;
  }
  try {
    const [database, table, ...rows] = (await queryLocalSqlServer(target, credentials, tableQuery(history), { command, signal })).split(/\r?\n/);
    if (database !== name) return { target, status: 'target-changed' };
    return { target, snapshot: { table, rows: rows.map(row => /^(?:[0-9a-f]{4}){1,143}$/i.test(row) ? Buffer.from(row, 'hex').toString('utf16le') : null) } };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return { target, status: error.issue ?? 'connection' };
  }
}
