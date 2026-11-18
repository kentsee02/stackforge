import { readPostgresHistory } from './postgres-history.mjs';

const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const maxRows = 1024;

export function efCoreHistoryTable(schema = 'public', table = '__EFMigrationsHistory') {
  if (typeof schema !== 'string' || typeof table !== 'string' || !identifier.test(schema) || !identifier.test(table) ||
      /^(?:pg_|information_schema$)/i.test(schema)) throw new Error('Enter a valid PostgreSQL history schema and table name.');
  return { schema, table };
}

function historyQuery({ schema, table }) {
  const relation = '"' + schema + '"."' + table + '"';
  const metadata = `SELECT c.oid,
    c.relkind = 'r' AND NOT c.relrowsecurity AND NOT c.relhassubclass AND NOT c.relispartition
      AND (SELECT count(*) FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
          AND a.attname IN ('MigrationId', 'ProductVersion') AND a.atttypid IN ('varchar'::regtype, 'text'::regtype)) = 2 AS readable
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '${schema}' AND c.relname = '${table}'`;
  return `BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog;
SELECT current_database() AS sf_name,
  coalesce((SELECT oid::text FROM (${metadata}) h), '') AS sf_oid,
  coalesce((SELECT readable FROM (${metadata}) h), false) AS sf_readable \\gset
\\if :sf_readable
  LOCK TABLE ONLY ${relation} IN ACCESS SHARE MODE;
  SELECT EXISTS (SELECT FROM (${metadata}) h WHERE h.readable AND h.oid::text = :'sf_oid') AS sf_locked \\gset
\\else
  \\set sf_locked false
\\endif
\\if :sf_locked
  SELECT jsonb_build_object('name', :'sf_name', 'table', 'readable', 'rows',
    (SELECT coalesce(jsonb_agg(CASE WHEN length("MigrationId") <= 143 THEN "MigrationId" ELSE NULL END), '[]')
      FROM (SELECT "MigrationId" FROM ONLY ${relation} LIMIT ${maxRows + 1}) history));
\\else
  SELECT jsonb_build_object('name', :'sf_name', 'table', CASE WHEN :'sf_oid' <> '' THEN 'unsupported' ELSE 'absent' END);
\\endif
COMMIT;`;
}

export async function compareEfCoreHistory({ group, history, ...options }) {
  const { target, snapshot, status } = await readPostgresHistory(options, historyQuery(history));
  const respond = (status, fields) => ({ target, history, groupId: group.id, status, ...fields });
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
