import { databaseConnectionValue, databaseKey, discoverDatabases, sqlName } from '../discovery.mjs';
import { localhostEndpoint, validateLocalTarget } from './local.mjs';
import { remoteSession } from './remote.mjs';

export async function localTransferSession(project, binding, command, signal) {
  const error = 'Configure a direct local PostgreSQL or MySQL URL before using database transfers.';
  const target = validateLocalTarget(binding.server, binding.instance);
  const { requirements, connections, identity } = await discoverDatabases(project, { includeConnections: true });
  const requirement = requirements.find(item => item.id === binding.requirementId);
  const connection = connections.get(binding.requirementId);
  const value = databaseConnectionValue(connection?.value, target.engine);
  if (!value || connection.environmentConflict || requirement?.status !== 'configured' || requirement.host !== binding.server.host ||
      requirement.port !== target.port || requirement.name !== target.name) throw new Error(error);
  const url = new URL(value);
  const sslmode = url.searchParams.get('sslmode') ?? 'prefer';
  const options = ['connection_limit', 'connect_timeout', 'pool_timeout', ...(target.engine === 'postgres' ? ['schema', 'sslmode'] : [])];
  if (![...url.searchParams.keys()].every(key => options.includes(key)) || !['disable', 'prefer', 'require'].includes(sslmode)) throw new Error(error);
  let user, password;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch { throw new Error(error); }
  if (!sqlName.test(user)) throw new Error(error);
  if (binding.server.host === 'localhost') {
    const address = await localhostEndpoint(target.port);
    if (!address) throw new Error('Both IPv4 and IPv6 are listening. Use an explicit loopback address in the database URL.');
    target.host = address;
  }
  const session = remoteSession({ ...target, user, sslmode }, password, { command, signal, loopback: true });
  return { session, credentialRef: databaseKey(identity, value) };
}
