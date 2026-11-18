import { localSession, localhostEndpoint, validateLocalTarget } from '../adapters/local.mjs';
import { databaseConnectionValue, databaseKey, sqlName } from '../discovery.mjs';

const localHosts = ['127.0.0.1', '::1', 'localhost'];

function postgresUrlAuth(connection) {
  const value = databaseConnectionValue(connection?.value, 'postgres');
  if (!value) return;
  const url = new URL(value);
  const sslmode = url.searchParams.get('sslmode') ?? 'prefer';
  if (url.searchParams.size > 1 || [...url.searchParams.keys()].some(key => key !== 'sslmode')) return;
  return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), sslmode };
}

export function postgresHistoryTargets({ requirements, connections }, { efCore = false } = {}) {
  const targets = [], seen = new Set();
  for (const item of requirements) {
    if (item.engine !== 'postgres' || item.status !== 'configured' || !localHosts.includes(item.host)) continue;
    const connection = connections.get(item.id);
    if (!connection || connection.environmentConflict) continue;
    try {
      validateLocalTarget(item, item);
      const auth = postgresUrlAuth(connection) ?? (efCore && connection.postgresHistoryAuth);
      if (!auth) continue;
      const { user, password, sslmode } = auth;
      if (!sqlName.test(user ?? '') || typeof password !== 'string' || password.length > 1024 || password.includes('\0') ||
          !['disable', 'prefer', 'require'].includes(sslmode)) continue;
      const { host, port, name, source, environmentVariable: variable } = item;
      const fingerprint = databaseKey(host, port, name, user, password, sslmode);
      if (seen.has(fingerprint)) continue;
      targets.push({ public: { id: databaseKey(efCore ? 'ef-core-local' : 'alembic-local', item.id, host, port, name),
        host, port, name, source, variable }, credentials: { user, password }, sslmode });
      seen.add(fingerprint);
    } catch { /* Invalid targets stay outside the selector. */ }
  }
  return targets;
}

export async function readPostgresHistory({ selection, credentials, sslmode, command, probe, resolveClient, signal }, sql) {
  const { host, port, name } = selection;
  const target = { host, port, name };
  try {
    const address = host === 'localhost' ? await localhostEndpoint(port, probe) : host;
    if (!address) return { target, status: 'loopback-ambiguous' };
    target.host = address;
    const endpoint = validateLocalTarget({ host: address, port }, { engine: 'postgres', name });
    const client = await resolveClient(endpoint);
    if (selection.projectPostgres && !client) return { target, status: 'target-changed' };
    const auth = credentials ?? await client.credentials();
    const session = localSession({ ...endpoint, sslmode }, auth, client?.command ?? command, signal);
    const snapshot = JSON.parse(await session.query(sql, name));
    if (snapshot?.name !== name) return { target, status: 'target-changed' };
    return { target, snapshot };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const issue = error.issue ?? error.code;
    return { target, status: ['client', 'authentication', 'permission', 'tls', 'server', 'database',
      'container-stopped', 'target-changed'].includes(issue) ? issue : 'connection' };
  }
}
