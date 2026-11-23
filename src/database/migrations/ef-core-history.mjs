import { readPostgresHistory } from './postgres-history.mjs';
import { postgresHistoryQuery, postgresHistoryTable } from './postgres-history-table.mjs';
import { readSqlServerHistory } from './sql-server-history.mjs';

const maxRows = 1024;
export const efCoreHistoryColumns = { MigrationId: 'text', ProductVersion: 'text' };

export const efCoreHistoryTable = (schema, table) => postgresHistoryTable(schema, table, '__EFMigrationsHistory');

export async function compareEfCoreHistory({ group, history, includeRelation, ...options }) {
  const query = postgresHistoryQuery(history, efCoreHistoryColumns, {
    maxRows, row: 'CASE WHEN length("MigrationId") <= 143 THEN "MigrationId" ELSE NULL END',
    ...(includeRelation && { extra: ", 'oid', :'sf_oid'" })
  });
  const { target, snapshot, status } = await (options.selection.engine === 'sqlserver' ?
    readSqlServerHistory(options, history) : readPostgresHistory(options, query));
  const respond = (status, fields) => ({ target, history, groupId: group.id, status, ...fields,
    ...(includeRelation && { relation: snapshot?.oid }) });
  if (!snapshot) return respond(status);
  if (snapshot.table === 'absent') return respond('history-missing');
  if (snapshot.table !== 'readable' || !Array.isArray(snapshot.rows) || snapshot.rows.length > maxRows) return respond('history-unavailable');
  const known = new Set(group.migrations.map(item => item.id));
  const applied = new Set(snapshot.rows);
  if (applied.size !== snapshot.rows.length || !snapshot.rows.every(id => known.has(id))) return respond('history-conflict');
  return respond(applied.size === known.size ? 'current' : 'pending', {
    migrations: group.migrations.map(({ id }) => ({ id, state: applied.has(id) ? 'applied' : 'pending' }))
  });
}
