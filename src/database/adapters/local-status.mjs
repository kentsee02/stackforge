import { databaseName, discoverDatabases } from '../discovery.mjs';
import { run } from '../../platform/process.mjs';

const clients = { mongodb: 'mongosh', redis: 'redis-cli', sqlserver: 'sqlcmd' };
const unsupported = 'Configure a supported direct local database connection before checking it.';
const failed = 'The local database did not respond to the connection check. Check the endpoint, credentials and client settings.';
const loopback = new Map([['localhost', '127.0.0.1'], ['127.0.0.1', '127.0.0.1'], ['::1', '::1']]);
const validUser = /^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]{0,127}$/;
const safePassword = value => typeof value === 'string' && value.length <= 1024 && !/[\0\r\n]/.test(value);
const mongoCheck = `const target = new Mongo(process.env.STACKFORGE_MONGO_URI).getDB(process.env.STACKFORGE_MONGO_DB);
if (target.runCommand({ ping: 1 }).ok !== 1) quit(1);
print("STACKFORGE_CONNECTED");`;

export async function inspectLocalConnection(project, binding, command = run, signal) {
  const engine = binding?.instance.engine;
  const name = binding?.instance.name;
  const host = loopback.get(binding?.server?.host);
  const port = binding?.server?.port;
  if (!Object.hasOwn(clients, engine) || binding.instance.provider !== 'local' || !host ||
      !databaseName.test(name ?? '') || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(unsupported);
  const { requirements, connections } = await discoverDatabases(project, { includeConnections: true });
  const selected = requirements.find(item => item.id === binding.requirementId && item.status === 'configured' &&
    item.engine === engine && item.name === name && item.host === binding.server.host && item.port === port);
  const connection = selected && connections.get(selected.id);
  if (!connection || connection.environmentConflict) throw new Error(unsupported);
  let url, credentials;
  if (connection.value) {
    try {
      url = new URL(connection.value);
      credentials = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    } catch { throw new Error(unsupported); }
  } else credentials = connection.sqlServerAuth;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:REDISCLI_|MONGOSH_|OSQLPASSWORD$|SQLCMD|NODE_OPTIONS$)/i.test(key)));
  let args;
  if (engine === 'mongodb') {
    if (url?.protocol !== 'mongodb:' || [...url.searchParams.keys()].some(key => !['authSource', 'tls', 'ssl'].includes(key))) throw new Error(unsupported);
    url.hostname = host.includes(':') ? `[${host}]` : host;
    url.searchParams.set('directConnection', 'true');
    url.searchParams.set('serverSelectionTimeoutMS', '4000');
    env.STACKFORGE_MONGO_URI = url.href;
    env.STACKFORGE_MONGO_DB = name;
    args = ['--nodb', '--norc', '--quiet', '--eval', mongoCheck];
  } else if (engine === 'redis') {
    if (url?.protocol !== 'redis:' || url.search || !/^\d{1,5}$/.test(name) ||
        credentials.user && !validUser.test(credentials.user) || !safePassword(credentials.password)) throw new Error(unsupported);
    if (credentials.password) env.REDISCLI_AUTH = credentials.password;
    args = ['-e', '--raw', '-h', host, '-p', String(port), '-n', name,
      ...(credentials.user && credentials.password ? ['--user', credentials.user] : []), 'PING'];
  } else {
    if (!credentials || url?.search || (!credentials.integrated && (!validUser.test(credentials.user ?? '') ||
        !credentials.password || !safePassword(credentials.password)))) throw new Error(unsupported);
    if (!credentials.integrated) env.SQLCMDPASSWORD = credentials.password;
    const address = host.includes(':') ? `[${host}]` : host;
    args = ['-S', `tcp:${address},${port}`, '-d', name, '-l', '5', '-t', '8', '-C', '-b', '-h', '-1', '-W', '-s', '\t',
      ...(credentials.integrated ? ['-E'] : ['-U', credentials.user]),
      '-Q', "SET NOCOUNT ON; SELECT CONVERT(varchar(64), SERVERPROPERTY('ProductVersion')), DB_NAME();"];
  }
  let output;
  try {
    output = (await command(clients[engine], args, { env, signal, stdoutOnly: true, timeout: 12000 })).trim();
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(/ENOENT|not recognized/i.test(error.message) ? `Install ${clients[engine]} and add it to PATH to check this database.` : failed);
  }
  const [version, database] = output.split('\t');
  const connected = engine === 'mongodb' ? output.endsWith('STACKFORGE_CONNECTED') :
    engine === 'redis' ? output === 'PONG' : database === name && /^\d+(?:\.\d+){1,3}$/.test(version);
  if (!connected) throw new Error(failed);
  return { ...(engine === 'sqlserver' && { version }), capabilities: { connect: true, backup: false, restore: false } };
}
