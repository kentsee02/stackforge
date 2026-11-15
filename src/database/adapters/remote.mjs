import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { run } from '../../platform/process.mjs';
import { databaseKey, databaseName, sqlName } from '../discovery.mjs';
import { backupLimit, databaseObjects, mysqlCanBackUp, mysqlRestoreIsScoped, mysqlScopeQuery, parseDatabaseInventory, portableMysqlDump } from '../backup/docker-transfer.mjs';

const unsupported = 'Remote connections support PostgreSQL and MySQL profiles.';
const failed = 'The remote database operation failed. Check the client, TLS certificate, database permissions, and connectivity.';
const hostName = /^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/i;
const versionText = output => /\b\d+\.\d+(?:\.\d+)?\b/.exec(output)?.[0];
const remoteEmpty = {
  postgres: `NOT EXISTS (
    SELECT FROM pg_catalog.pg_namespace WHERE left(nspname, 3) <> 'pg_' AND nspname NOT IN ('public','information_schema')
    UNION ALL SELECT FROM pg_catalog.pg_class WHERE relnamespace=pg_catalog.to_regnamespace('public')
    UNION ALL SELECT FROM pg_catalog.pg_proc WHERE pronamespace=pg_catalog.to_regnamespace('public')
    UNION ALL SELECT FROM pg_catalog.pg_type WHERE typnamespace=pg_catalog.to_regnamespace('public')
    UNION ALL SELECT FROM pg_catalog.pg_largeobject_metadata
    UNION ALL SELECT FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql')`,
  mysql: `NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE()
    UNION ALL SELECT 1 FROM information_schema.routines WHERE routine_schema=DATABASE()
    UNION ALL SELECT 1 FROM information_schema.events WHERE event_schema=DATABASE())`
};

export async function remoteProfile(server, instance, { user, ca }) {
  if (instance?.provider !== 'remote' || !['postgres', 'mysql'].includes(instance.engine) ||
      !(isIP(server?.host ?? '') || hostName.test(server?.host ?? '')) ||
      !Number.isInteger(server?.port) || server.port < 1 || server.port > 65535 ||
      !databaseName.test(instance.name ?? '') || !sqlName.test(user ?? '') ||
      /^(?:postgres|template[01]|mysql|information_schema|performance_schema|sys)$/i.test(instance.name)) {
    throw new Error(unsupported);
  }
  const certificate = typeof ca === 'string' && isAbsolute(ca) && await realpath(ca).catch(() => '');
  const stat = certificate && await lstat(certificate).catch(() => null);
  if (!stat?.isFile() || stat.size > 1024 * 1024) throw new Error('Choose an absolute path to a trusted CA certificate file.');
  return { engine: instance.engine, name: instance.name, host: server.host, port: server.port, user, ca: certificate };
}

export function remoteSession(profile, password, { command = run, signal } = {}) {
  if (typeof password !== 'string' || !password || password.length > 1024 || /[\0\r\n]/.test(password)) {
    throw new Error('Enter a valid remote database password.');
  }
  const { engine, host, port, name, user, ca } = profile;
  const postgres = engine === 'postgres';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PG|MYSQL|MARIADB)/i.test(key)));
  if (postgres) Object.assign(env, { PGPASSWORD: password, PGCONNECT_TIMEOUT: '4', PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: ca, PGGSSENCMODE: 'disable', PGOPTIONS: '-c statement_timeout=12000 -c lock_timeout=4000' });
  else Object.assign(env, { MYSQL_PWD: password });
  const endpoint = postgres ? ['-w', '-h', host, '-p', String(port), '-U', user, '-d', name] :
    ['--no-defaults', '--no-login-paths', '--protocol=TCP', '--ssl-mode=VERIFY_IDENTITY', '--ssl-ca=' + ca,
      '--host=' + host, '--port=' + port, '--user=' + user];
  async function invoke(program, args, options) {
    try { return await command(program, args, { env, signal, timeout: 30000, ...options }); }
    catch (error) { if (error.name === 'AbortError') throw error; throw new Error(failed); }
  }
  const query = async sql => (await invoke(postgres ? 'psql' : 'mysql', postgres ?
    ['-X', '-qAt', '-F', '\t', '-v', 'ON_ERROR_STOP=1', ...endpoint] :
    [...endpoint, '--connect-timeout=4', '--batch', '--raw', '--skip-column-names', '--binary-mode', '--local-infile=0', '--database=' + name],
  { input: Buffer.from(sql + '\n'), stdoutOnly: true, stdoutLimit: 512 * 1024 })).trimEnd();
  async function test() {
    if (postgres) {
      const result = await query(`SELECT current_setting('server_version'), current_database(),
        NOT EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','m','p','S')
          AND NOT has_table_privilege(c.oid,'SELECT')),
        ${remoteEmpty.postgres}, has_schema_privilege('public','CREATE'),
        CASE WHEN has_function_privilege('pg_catalog.pg_control_system()', 'EXECUTE')
          THEN (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) ELSE 'unavailable' END,
        pg_is_in_recovery(), NOT EXISTS(SELECT FROM pg_catalog.pg_foreign_server),
        NOT EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
          AND NOT pg_has_role('pg_execute_server_program', 'MEMBER')
          AND NOT pg_has_role('pg_write_server_files', 'MEMBER'),
        (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database());`);
      const [rawVersion, database, read, empty, create, identity, standby, noForeignServer, limitedRole, databaseOid] = result.split('\t');
      const version = versionText(rawVersion);
      if (!version || database !== name) throw new Error(failed);
      const verifiedIdentity = /^\d+$/.test(identity ?? '') && /^\d+$/.test(databaseOid ?? '') ? databaseKey(host, port, identity, databaseOid) : undefined;
      return { version, identity: verifiedIdentity,
        capabilities: { connect: true, backup: read === 't', restore: Boolean(verifiedIdentity && empty === 't' &&
          create === 't' && standby === 'f' && noForeignServer === 't' && limitedRole === 't') },
        providerPermissions: { start: false, stop: false, delete: false } };
    }
    const [header, ...grants] = (await query(`SELECT VERSION(), DATABASE(), ${remoteEmpty.mysql}, @@server_uuid, @@global.read_only;
      ${mysqlScopeQuery};`)).split(/\r?\n/);
    const [rawVersion, database, empty, identity, readOnly] = header.split('\t');
    const version = versionText(rawVersion);
    if (!version || database !== name) throw new Error(failed);
    const scope = grants.join('\n');
    const scoped = mysqlRestoreIsScoped(scope);
    const backup = mysqlCanBackUp(scope);
    return { version, identity: /^[a-f\d-]{36}$/i.test(identity ?? '') ? databaseKey(host, port, identity) : undefined,
      capabilities: { connect: true, backup, restore: scoped && empty === '1' && readOnly === '0' && /^[a-f\d-]{36}$/i.test(identity ?? '') },
      providerPermissions: { start: false, stop: false, delete: false } };
  }
  async function backup() {
    const state = await test();
    if (!state.capabilities.backup) throw new Error('The remote account does not have verified backup permissions.');
    const data = await invoke(postgres ? 'pg_dump' : 'mysqldump', postgres ?
      [...endpoint, '--format=custom', '--no-owner', '--no-privileges'] :
      [...endpoint, '--single-transaction', '--no-tablespaces', '--set-gtid-purged=OFF', '--skip-add-drop-table', '--skip-add-locks', '--skip-column-statistics', '--routines', '--events', '--triggers', '--hex-blob', '--', name],
    { binaryLimit: backupLimit, timeout: 120000 });
    return { data: postgres ? data : portableMysqlDump(data), version: state.version, engine };
  }
  async function restore(data, expectedIdentity) {
    const state = await test();
    if (!state.capabilities.restore || !state.identity || state.identity !== expectedIdentity) {
      throw new Error('The remote database is not a verified empty restore target.');
    }
    if (postgres) await invoke('pg_restore', [...endpoint, '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges'], { input: data, timeout: 120000 });
    else await invoke('mysql', [...endpoint, '--connect-timeout=4', '--batch', '--binary-mode', '--local-infile=0', '--database=' + name],
      { input: portableMysqlDump(data), timeout: 120000 });
  }
  const inventory = async () => parseDatabaseInventory(await query(`SELECT ${postgres ? "current_setting('server_version')" : 'VERSION()'}; ${databaseObjects[engine]};`));
  return { test, backup, restore, inventory };
}
