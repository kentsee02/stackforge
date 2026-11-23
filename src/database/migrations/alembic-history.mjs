import { readPostgresHistory } from './postgres-history.mjs';
import { postgresHistoryQuery, postgresHistoryTable } from './postgres-history-table.mjs';
import { databaseKey } from '../discovery.mjs';

const userSchema = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";
const hasUserObjects = `EXISTS (SELECT FROM pg_catalog.pg_namespace n WHERE ${userSchema} AND n.nspname <> 'public'
  UNION ALL SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f','S') AND c.oid::text <> :'sf_oid'
  UNION ALL SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE ${userSchema}
  UNION ALL SELECT FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE ${userSchema} AND t.typtype IN ('e', 'd', 'r', 'm'))`;

export async function compareAlembicHistory({ revisions, history = postgresHistoryTable('public', 'alembic_version'), includeFingerprint, ...options }) {
  const query = postgresHistoryQuery(history, { version_num: 'text' }, {
    maxRows: 200, row: 'CASE WHEN length(version_num) <= 64 THEN version_num ELSE NULL END', order: 'ORDER BY version_num',
    extra: ", 'hasObjects', " + hasUserObjects
  });
  const { target, snapshot, status } = await readPostgresHistory(options, query);
  const respond = (status, fields) => ({ target, history, status, ...fields,
    ...(includeFingerprint && snapshot && { fingerprint: databaseKey(snapshot) }) });
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
