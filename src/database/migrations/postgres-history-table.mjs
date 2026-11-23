const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function postgresHistoryTable(schema = 'public', table, fallback) {
  if (table === undefined) table = fallback;
  if (typeof schema !== 'string' || typeof table !== 'string' || !identifier.test(schema) || !identifier.test(table) ||
      /^(?:pg_|information_schema$)/i.test(schema)) throw new Error('Enter a valid PostgreSQL history schema and table name.');
  return { schema, table };
}

const historyTypes = {
  text: `('varchar'::regtype, 'text'::regtype)`,
  integer: `('int4'::regtype)`,
  boolean: `('bool'::regtype)`
};

export function postgresHistoryQuery({ schema, table }, columns, { maxRows, row, order = '', extra = '' }) {
  const relation = `"${schema}"."${table}"`;
  const shape = Object.entries(columns).map(([name, type]) => `a.attname = '${name}' AND a.atttypid IN ${historyTypes[type]}`);
  const metadata = `SELECT c.oid,
    c.relkind = 'r' AND NOT c.relrowsecurity AND NOT c.relhassubclass AND NOT c.relispartition
      AND (SELECT count(*) FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
          AND (${shape.map(condition => '(' + condition + ')').join(' OR ')})) = ${shape.length} AS readable
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
    (SELECT coalesce(jsonb_agg(entry), '[]') FROM (
      SELECT ${row} AS entry FROM ONLY ${relation} ${order} LIMIT ${maxRows + 1}
    ) history)${extra});
\\else
  SELECT jsonb_build_object('name', :'sf_name', 'table', CASE WHEN :'sf_oid' <> '' THEN 'unsupported' ELSE 'absent' END,
    'rows', '[]'::jsonb${extra});
\\endif
COMMIT;`;
}
