import { localSession, localhostEndpoint, validateLocalTarget } from '../adapters/local.mjs';
import { databaseConnectionValue, databaseKey, sqlName } from '../discovery.mjs';

const localHosts = ['127.0.0.1', '::1', 'localhost'];
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

export function alembicLocalTargets({ requirements, connections }) {
  const targets = [];
  const seen = new Set();
  for (const item of requirements) {
    if (item.engine !== 'postgres' || item.status !== 'configured' || !localHosts.includes(item.host)) continue;
    const connection = connections.get(item.id);
    const value = databaseConnectionValue(connection?.value, 'postgres');
    if (!value || connection.environmentConflict || seen.has(value)) continue;
    const url = new URL(value);
    const sslmode = url.searchParams.get('sslmode') ?? 'prefer';
    if (!['disable', 'prefer', 'require'].includes(sslmode) || url.searchParams.size > 1 || [...url.searchParams.keys()].some(key => key !== 'sslmode')) continue;
    try {
      validateLocalTarget(item, item);
      const user = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      if (!sqlName.test(user) || password.length > 1024 || password.includes('\0')) continue;
      const { host, port, name, source, environmentVariable: variable } = item;
      targets.push({ public: { id: databaseKey('alembic-local', item.id, host, port, name), host, port, name, source, variable },
        credentials: { user, password }, sslmode });
      seen.add(value);
    } catch { /* Invalid targets stay outside the selector. */ }
  }
  return targets;
}

export async function compareAlembicHistory({ revisions, selection, credentials, sslmode, command, probe, resolveClient, signal }) {
  const { host, port, name } = selection;
  const publicTarget = { host, port, name };
  const respond = (status, fields) => ({ target: publicTarget, status, ...fields });
  let snapshot;
  try {
    const address = host === 'localhost' ? await localhostEndpoint(port, probe) : host;
    if (!address) return respond('loopback-ambiguous');
    publicTarget.host = address;
    const target = validateLocalTarget({ host: address, port }, { engine: 'postgres', name });
    const client = await resolveClient(target);
    if (selection.projectPostgres && !client) return respond('target-changed');
    const auth = credentials ?? await client.credentials();
    const session = localSession({ ...target, sslmode }, auth, client?.command ?? command, signal);
    snapshot = JSON.parse(await session.query(readHistory, name));
    if (snapshot?.name !== name) return respond('target-changed');
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const issue = error.issue ?? error.code;
    return respond(['client', 'authentication', 'permission', 'tls', 'server', 'database', 'container-stopped', 'target-changed'].includes(issue) ? issue : 'connection');
  }
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
