import { readPostgresHistory } from './postgres-history.mjs';

const historyTable = `SELECT c.oid,
  c.relkind = 'r' AND NOT c.relrowsecurity AND NOT c.relhassubclass AND NOT c.relispartition
    AND EXISTS (SELECT FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0
      AND NOT a.attisdropped AND a.attname = 'version_num' AND a.atttypid IN ('varchar'::regtype, 'text'::regtype)) AS readable
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'alembic_version'`;
const userSchema = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";
const hasObjects = `EXISTS (SELECT FROM pg_catalog.pg_namespace n WHERE ${userSchema} AND n.nspname <> 'public'
  UNION ALL SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f','S') AND c.oid::text <> :'sf_oid'
  UNION ALL SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE ${userSchema}
  UNION ALL SELECT FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE ${userSchema} AND t.typtype IN ('e', 'd', 'r', 'm'))`;

// The access-share lock keeps the checked relation in place through the read.
// Check the OID and shape again after locking, in case it changed before the lock.
const readHistory = `BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog;
SELECT current_database() AS sf_name,
  coalesce((SELECT oid::text FROM (${historyTable}) h), '') AS sf_oid,
  coalesce((SELECT readable FROM (${historyTable}) h), false) AS sf_readable \\gset
\\if :sf_readable
  LOCK TABLE ONLY public.alembic_version IN ACCESS SHARE MODE;
  SELECT EXISTS (SELECT FROM (${historyTable}) h WHERE h.readable AND h.oid::text = :'sf_oid') AS sf_locked \\gset
\\else
  \\set sf_locked false
\\endif
\\if :sf_locked
  SELECT jsonb_build_object('name', :'sf_name', 'table', 'readable', 'hasObjects', ${hasObjects},
    'rows', (SELECT coalesce(jsonb_agg(CASE WHEN length(version_num) <= 64 THEN version_num ELSE NULL END), '[]')
      FROM (SELECT version_num FROM ONLY public.alembic_version LIMIT 201) history));
\\else
  SELECT jsonb_build_object('name', :'sf_name', 'table', CASE WHEN :'sf_oid' <> '' THEN 'unsupported' ELSE 'absent' END,
    'hasObjects', ${hasObjects}, 'rows', '[]'::jsonb);
\\endif
COMMIT;`;

export async function compareAlembicHistory({ revisions, ...options }) {
  const { target, snapshot, status } = await readPostgresHistory(options, readHistory);
  const respond = (status, fields) => ({ target, status, ...fields });
  if (!snapshot) return respond(status);
  const { table, rows, hasObjects } = snapshot;
  if (table === 'unsupported' || !['readable', 'absent'].includes(table) || typeof hasObjects !== 'boolean' || !Array.isArray(rows)) {
    return respond('history-unavailable');
  }
  if (!rows.length && hasObjects) return respond('history-missing');
  const nodes = new Map(revisions.map(node => [node.revision, node]));
  const recorded = new Set(rows);
  if (recorded.size !== rows.length || rows.length > revisions.length || !rows.every(id => nodes.has(id))) return respond('history-conflict');
  function ancestors(ids, includeDependencies) {
    const seen = new Set();
    function visit(id) {
      if (seen.has(id)) return;
      seen.add(id);
      const node = nodes.get(id);
      node.parents.forEach(visit);
      if (includeDependencies) node.dependencies.forEach(visit);
    }
    ids.forEach(visit);
    return seen;
  }
  if (rows.some(id => [...ancestors(nodes.get(id).parents, false)].some(parent => recorded.has(parent)))) return respond('history-conflict');
  const applied = ancestors(rows, true);
  return respond(applied.size === revisions.length ? 'current' : 'pending', {
    heads: [...recorded].sort(), revisions: revisions.map(({ revision }) => ({ revision, state: applied.has(revision) ? 'applied' : 'pending' }))
  });
}
