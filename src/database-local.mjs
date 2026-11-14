import { connect } from 'node:net';
import { run } from './process.mjs';
import { databaseKey, sqlName } from './database-discovery.mjs';

const localHosts = new Map([['localhost', '127.0.0.1'], ['127.0.0.1', '127.0.0.1'], ['::1', '::1']]);
const engineConfig = {
  postgres: { client: 'psql', server: 'postgres', service: 'postgresql', help: 'https://www.postgresql.org/download/' },
  mysql: { client: 'mysql', server: 'mysqld', service: 'mysql', help: 'https://dev.mysql.com/downloads/mysql/' }
};
const unsupported = 'Choose a detected local PostgreSQL or MySQL database.';
const authentication = 'The database client could not authenticate or connect. Check the credentials, port, and local service.';
const versionNumber = output => /\b\d+\.\d+(?:\.\d+)?\b/.exec(output)?.[0];
const postgresEmpty = `NOT EXISTS (
  SELECT FROM pg_catalog.pg_namespace WHERE left(nspname, 3) <> 'pg_' AND nspname NOT IN ('public', 'information_schema')
  UNION ALL SELECT FROM pg_catalog.pg_class WHERE relnamespace = pg_catalog.to_regnamespace('public')
  UNION ALL SELECT FROM pg_catalog.pg_proc WHERE pronamespace = pg_catalog.to_regnamespace('public')
  UNION ALL SELECT FROM pg_catalog.pg_type WHERE typnamespace = pg_catalog.to_regnamespace('public')
  UNION ALL SELECT FROM pg_catalog.pg_largeobject_metadata
  UNION ALL SELECT FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql'
)`;
const mysqlEmpty = `NOT EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE()
  UNION ALL SELECT 1 FROM information_schema.routines WHERE routine_schema = DATABASE()
  UNION ALL SELECT 1 FROM information_schema.events WHERE event_schema = DATABASE()
)`;

export function validateLocalTarget(server, instance) {
  const host = localHosts.get(server?.host);
  const port = server?.port;
  const engine = instance?.engine;
  const name = instance?.name;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !Object.hasOwn(engineConfig, engine) ||
      !sqlName.test(name ?? '') || /^(?:mysql|information_schema|performance_schema|sys|postgres|template[01])$/i.test(name)) {
    throw new Error(unsupported);
  }
  return { engine, host, port, name };
}

function listening(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1200, () => finish(false));
  });
}

export async function localInstallation(target, { command = run, platform = process.platform, probe = listening } = {}) {
  const { engine, host, port } = target;
  const { client, server, service, help } = engineConfig[engine];
  async function version(program) {
    try { return versionNumber(await command(program, ['--version'], { timeout: 2500, stdoutOnly: true })); }
    catch { return; }
  }
  async function serviceState() {
    if (platform === 'win32') {
      const expression = engine === 'postgres' ? '^postgresql' : '^(mysql|mariadb)';
      const script = `Get-Service | Where-Object { $_.Name -match '${expression}' } | ForEach-Object { $_.Status.ToString() }`;
      try {
        const output = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, stdoutOnly: true });
        const states = output.trim().split(/\s+/);
        return states.includes('Running') ? 'running' : states.includes('Stopped') ? 'stopped' : 'unknown';
      } catch { return 'unknown'; }
    }
    if (platform === 'linux') {
      const unitNames = engine === 'mysql' ? ['mysql.service', 'mysqld.service', 'mariadb.service'] : [`${service}.service`];
      try {
        const states = await command('systemctl', ['show', '--property=LoadState,ActiveState', ...unitNames], { timeout: 2500, stdoutOnly: true });
        const units = states.trim().split(/\r?\n\s*\r?\n/).filter(unit => /(?:^|\n)LoadState=loaded(?:\r?$|\r?\n)/m.test(unit));
        if (units.some(unit => /^ActiveState=active$/m.test(unit))) return 'running';
        if (units.length && units.every(unit => /^ActiveState=(?:inactive|failed)$/m.test(unit))) return 'stopped';
      } catch { /* systemd is optional on Linux. */ }
    }
    return 'unknown';
  }
  const [clientVersion, serverVersion, serviceStatus, portOpen] = await Promise.all([version(client), version(server), serviceState(), probe(host, port)]);
  return { clientVersion, serverVersion, serviceStatus, portOpen, help };
}

const sqlEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PG|MYSQL|MARIADB)/i.test(key)));

export function localSession(target, credentials, command = run, signal) {
  const { engine, host, port, name } = target;
  const user = credentials?.user;
  const password = credentials?.password ?? '';
  if (typeof user !== 'string' || !sqlName.test(user) || typeof password !== 'string' || password.length > 1024 || password.includes('\0')) {
    throw new Error('Enter a valid database user and password.');
  }
  const env = sqlEnvironment();
  if (engine === 'postgres') Object.assign(env, { PGPASSWORD: password, PGCONNECT_TIMEOUT: '4', PGOPTIONS: '-c statement_timeout=12000 -c lock_timeout=4000' });
  else Object.assign(env, { MYSQL_PWD: password });
  const client = engineConfig[engine].client;
  const query = async (sql, database) => {
    const args = engine === 'postgres'
      ? ['-X', '-w', '-qAt', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-h', host, '-p', String(port), '-U', user, '-d', database ?? 'postgres']
      : ['--no-defaults', '--no-login-paths', '--protocol=TCP', '--connect-timeout=4', '--batch', '--raw', '--skip-column-names',
        '--binary-mode', '--local-infile=0', '--host=' + host, '--port=' + port, '--user=' + user, ...(database ? ['--database=' + database] : [])];
    try {
      return (await command(client, args, { env, input: Buffer.from(sql + '\n'), timeout: 20000, stdoutOnly: true, stdoutLimit: 256 * 1024, signal })).trimEnd();
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (/ENOENT|not recognized/i.test(error.message)) throw new Error('Install the database command-line client and add it to PATH.');
      throw new Error(authentication);
    }
  };
  const quote = identifier => engine === 'postgres' ? `"${identifier}"` : '`' + identifier + '`';
  const emptySql = engine === 'postgres' ? postgresEmpty : mysqlEmpty;

  async function inspect() {
    if (engine === 'postgres') {
      const output = await query(`SELECT current_setting('server_version_num'), current_setting('port'), pg_is_in_recovery(),
        EXISTS(SELECT FROM pg_catalog.pg_database WHERE datname='${name}'),
        EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolcreatedb OR rolsuper)),
        CASE WHEN has_function_privilege('pg_catalog.pg_control_system()', 'EXECUTE') THEN
          (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) ELSE '' END;`);
      const [version, actualPort, standby, present, create, serverIdentity] = output.split('\t');
      if (!/^\d{5,6}$/.test(version) || !/^\d+$/.test(actualPort) || !/^[tf]$/.test(present)) throw new Error(authentication);
      const exists = present === 't';
      const fingerprint = /^\d+$/.test(serverIdentity ?? '') ? databaseKey(engine, host, port, serverIdentity) : undefined;
      let schema;
      if (exists) {
        const [empty, allowed] = (await query(`SELECT ${emptySql}, has_schema_privilege(current_user, 'public', 'CREATE');`, name)).split('\t');
        schema = { empty: empty === 't', initialize: Boolean(fingerprint && standby === 'f' && empty === 't' && allowed === 't') };
      }
      return { exists, version: String(Math.floor(Number(version) / 10000)) + '.' + String(Number(version) % 10000), fingerprint, serverIdentity,
        permissions: { connect: true, inspectSchema: true, create: Boolean(fingerprint && standby === 'f' && create === 't'),
          initialize: Boolean(schema?.initialize) }, empty: schema?.empty };
    }
    const [header, ...grants] = (await query(`SELECT VERSION(), @@port, @@server_uuid, @@global.read_only, @@global.partial_revokes,
      EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name='${name}'); SHOW GRANTS;`)).split(/\r?\n/);
    const [version, actualPort, serverIdentity, readonly, partialRevokes, present] = header.split('\t');
    if (!/^\d+\.\d+\.\d+/.test(version) || !/^\d+$/.test(actualPort) || !/^[01]$/.test(present)) throw new Error(authentication);
    const fingerprint = /^[\da-f-]{36}$/i.test(serverIdentity ?? '') ? databaseKey(engine, host, port, serverIdentity) : undefined;
    const exists = present === '1';
    const exact = name.includes('_') && partialRevokes !== '1' ? [] : [quote(name) + '.*'];
    exact.push(quote(name.replaceAll('_', '\\_')) + '.*');
    const grantLevel = grants.reduce((level, line) => {
      const match = /^GRANT ([A-Z_, ]+) ON (.*?) TO /.exec(line);
      if (!match || !exact.includes(match[2]) && match[2] !== '*.*') return level;
      const permissions = match[1].split(', ');
      const canInspect = ['SELECT', 'SHOW VIEW', 'TRIGGER', 'EVENT', 'ALTER ROUTINE'].every(item => permissions.includes(item));
      if (permissions.includes('ALL PRIVILEGES') || canInspect && permissions.includes('CREATE')) return 2;
      return permissions.includes('CREATE') ? Math.max(level, 1) : level;
    }, 0);
    const schemaRead = exists && grantLevel === 2 ? (await query(`SELECT ${emptySql};`, name)) === '1' : undefined;
    return { exists, version: versionNumber(version), fingerprint, serverIdentity,
      permissions: { connect: true, inspectSchema: grantLevel === 2, create: Boolean(fingerprint && readonly === '0' && grantLevel && !grants.some(line => /^REVOKE /.test(line))),
        initialize: Boolean(fingerprint && readonly === '0' && grantLevel === 2 && schemaRead && !grants.some(line => /^REVOKE /.test(line))) },
      empty: exists ? schemaRead : undefined };
  }

  function guardedCreate(serverIdentity) {
    const statement = `CREATE DATABASE ${quote(name)}`;
    if (engine === 'postgres') return `SELECT system_identifier::text = '${serverIdentity}' AND NOT pg_is_in_recovery() AS sf_verified FROM pg_catalog.pg_control_system() \\gset
\\if :sf_verified
${statement};
\\else
SELECT 1/0;
\\endif`;
    return `SET @sf_sql = IF(@@server_uuid = '${serverIdentity}' AND @@global.read_only = 0, '${statement}', 'SELECT 1 FROM information_schema.stackforge_identity_changed');
PREPARE sf_create FROM @sf_sql;
EXECUTE sf_create;
DEALLOCATE PREPARE sf_create;`;
  }

  function guardedSchema(serverIdentity, statements) {
    if (engine === 'postgres') return `BEGIN;
DO $verify$ BEGIN
  IF (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) <> '${serverIdentity}'
     OR pg_is_in_recovery() OR NOT (${emptySql}) THEN RAISE EXCEPTION 'StackForge target changed'; END IF;
END $verify$;
${statements}
COMMIT;`;
    return `SET @sf_sql = IF(@@server_uuid = '${serverIdentity}' AND @@global.read_only = 0 AND (${emptySql}),
      'DO 0', 'SELECT 1 FROM information_schema.stackforge_identity_changed');
PREPARE sf_verify FROM @sf_sql;
EXECUTE sf_verify;
DEALLOCATE PREPARE sf_verify;
${statements}`;
  }

  return { inspect, query, quote, guardedCreate, guardedSchema };
}
