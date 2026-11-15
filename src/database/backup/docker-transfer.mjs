export const backupLimit = 64 * 1024 * 1024;

const postgresEmpty = `
SELECT NOT EXISTS (
  SELECT 1 FROM pg_namespace WHERE left(nspname, 3) <> 'pg_' AND nspname NOT IN ('public', 'information_schema')
  UNION ALL
  SELECT 1 FROM pg_class WHERE relnamespace = to_regnamespace('public')
  UNION ALL
  SELECT 1 FROM pg_proc WHERE pronamespace = to_regnamespace('public')
  UNION ALL
  SELECT 1 FROM pg_type WHERE typnamespace = to_regnamespace('public')
  UNION ALL
  SELECT 1 FROM pg_largeobject_metadata
);`;
const mysqlEmpty = `
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE()
  UNION ALL
  SELECT 1 FROM information_schema.routines WHERE routine_schema = DATABASE()
  UNION ALL
  SELECT 1 FROM information_schema.events WHERE event_schema = DATABASE()
);`;

const readPassword = name => `password=\${${name}:-}; if [ -z "$password" ] && [ -n "\${${name}_FILE:-}" ]; then password=$(cat "$${name}_FILE") || exit 1; fi;`;
const postgresLogin = `${readPassword('POSTGRES_PASSWORD')} export PGPASSWORD="$password"; user=\${POSTGRES_USER:-postgres}; db=\${POSTGRES_DB:-$user};
unset PGHOST PGHOSTADDR PGPORT PGSERVICE PGSERVICEFILE PGOPTIONS;
case "$db" in *=*|postgres:*|postgresql:*) exit 1;; esac;
pidfile="\${PGDATA:?}/postmaster.pid";
port=$(sed -n '4p' "$pidfile") || exit 1;
socket=$(sed -n '5p' "$pidfile") || exit 1;
case "$port" in ""|*[!0-9]*) exit 1;; esac;
case "$socket" in /*) ;; *) exit 1;; esac;
test -S "$socket/.s.PGSQL.$port" || exit 1;`;
const postgresTarget = '--host="$socket" --port="$port" --username="$user" --dbname="$db"';
const mysqlDatabase = 'case "$(printf \'%s\' "${MYSQL_DATABASE:-}" | tr \'[:upper:]\' \'[:lower:]\')" in ""|mysql|information_schema|performance_schema|sys) exit 1;; esac;';
const mysqlSocket = 'socket=; for path in /var/run/mysqld/mysqld.sock /var/lib/mysql/mysql.sock; do if [ -S "$path" ]; then socket=$path; break; fi; done; test -n "$socket" || exit 1;';
const mysqlTarget = '--no-defaults --no-login-paths --protocol=SOCKET --socket="$socket"';
const mysqlRoot = `${mysqlDatabase} ${mysqlSocket} ${readPassword('MYSQL_ROOT_PASSWORD')} test -n "$password" || exit 1; export MYSQL_PWD="$password";`;
const mysqlUser = `${mysqlDatabase} ${mysqlSocket} case "\${MYSQL_USER:-}" in ""|[rR][oO][oO][tT]) exit 1;; esac; ${readPassword('MYSQL_PASSWORD')} export MYSQL_PWD="$password";`;
const mysqlReady = `${mysqlDatabase} ${mysqlSocket} if [ -n "\${MYSQL_USER:-}" ]; then user=$MYSQL_USER; ${readPassword('MYSQL_PASSWORD')} else user=root; ${readPassword('MYSQL_ROOT_PASSWORD')} fi; export MYSQL_PWD="$password";`;

export const databaseObjects = {
  postgres: `SELECT pg_catalog.json_build_array(kind, namespace, name) FROM (
    SELECT c.relkind::text AS kind,n.nspname AS namespace,c.relname AS name
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','v','m','S','f','p')
    UNION ALL SELECT 'routine',n.nspname,p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    UNION ALL SELECT 'schema',nspname,nspname FROM pg_catalog.pg_namespace WHERE nspname <> 'public'
    UNION ALL SELECT 'extension',n.nspname,e.extname FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname <> 'plpgsql'
    UNION ALL SELECT 'large object','public',oid::text FROM pg_catalog.pg_largeobject_metadata
    ) objects WHERE namespace !~ '^pg_' AND namespace <> 'information_schema' ORDER BY kind,namespace,name`,
  mysql: `SELECT JSON_ARRAY(kind, name) FROM (
    SELECT TABLE_TYPE AS kind,TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE()
    UNION ALL SELECT ROUTINE_TYPE,ROUTINE_NAME FROM information_schema.routines WHERE routine_schema=DATABASE()
    UNION ALL SELECT 'TRIGGER',TRIGGER_NAME FROM information_schema.triggers WHERE trigger_schema=DATABASE()
    UNION ALL SELECT 'EVENT',EVENT_NAME FROM information_schema.events WHERE event_schema=DATABASE()
    ) objects ORDER BY kind,name`
};

// mysql uses account qualifiers in CREATE statements and versioned SQL comments.
// Keep quoted SQL data byte-for-byte while letting objects use the restore account.
const account = "(?:`(?:``|[^`])*`|'(?:\\\\.|''|[^'\\\\])*'|\"(?:\\\\.|\"\"|[^\"\\\\])*\")";
const mysqlGrant = /^GRANT ([A-Z_, ]+) ON (\*\.\*|`(?:``|[^`])+`\.\*) TO `(?:``|[^`])*`@`(?:``|[^`])*`$/;
export const mysqlScopeQuery = "SELECT CONCAT('STACKFORGE_SCOPE:', @@GLOBAL.partial_revokes), DATABASE(); SHOW GRANTS";
const mysqlScopeError = 'MySQL restore requires an account with grants restricted to the target database.';

export function mysqlRestoreIsScoped(output) {
  const [header, ...grants] = output.trimEnd().split(/\r?\n/);
  const [mode, database, extra] = header.split('\t');
  if (!database || extra !== undefined || !['STACKFORGE_SCOPE:0', 'STACKFORGE_SCOPE:1'].includes(mode) || /[\\\r\n]/.test(database)) return false;
  // MySQL treats unescaped underscores and percent signs as grant wildcards
  // unless partial_revokes is enabled.
  const exactName = mode === 'STACKFORGE_SCOPE:0' ? database.replace(/[%_]/g, '\\$&') : database;
  const scope = '`' + exactName.replaceAll('`', '``') + '`.*';
  let targetGrant = false;
  for (const grant of grants) {
    const [, privileges, grantedScope] = mysqlGrant.exec(grant) ?? [];
    if (grantedScope === scope && privileges !== 'USAGE') targetGrant = true;
    else if (grantedScope !== '*.*' || privileges !== 'USAGE') return false;
  }
  return targetGrant;
}

export function mysqlCanBackUp(output) {
  const [header, ...grants] = output.trimEnd().split(/\r?\n/);
  const [mode, database] = header.split('\t');
  if (!database || !['STACKFORGE_SCOPE:0', 'STACKFORGE_SCOPE:1'].includes(mode)) return false;
  const exactName = mode === 'STACKFORGE_SCOPE:0' ? database.replace(/[%_]/g, '\\$&') : database;
  const scope = '`' + exactName.replaceAll('`', '``') + '`.*';
  const global = new Set(), applicable = new Set();
  for (const grant of grants) {
    const [, privileges, grantedScope] = mysqlGrant.exec(grant) ?? [];
    if (grantedScope !== '*.*' && grantedScope !== scope) continue;
    for (const privilege of privileges.split(', ')) {
      applicable.add(privilege);
      if (grantedScope === '*.*') global.add(privilege);
    }
  }
  return (global.has('SELECT') || global.has('ALL PRIVILEGES')) &&
    (applicable.has('ALL PRIVILEGES') || ['SHOW VIEW', 'TRIGGER', 'EVENT'].every(privilege => applicable.has(privilege)));
}

const definer = `\\bDEFINER\\s*=\\s*${account}\\s*@\\s*${account}`;
const dumpTokens = () => new RegExp(`${account}|/\\*![0-9]+[\\s\\S]*?\\*/|/\\*[\\s\\S]*?\\*/|--(?=\\s)[^\\r\\n]*|#[^\\r\\n]*|${definer}`, 'gi');
function removeDefiners(sql) {
  return sql.replace(dumpTokens(), token => {
    if (/^DEFINER\b/i.test(token)) return '';
    const comment = /^(\/\*!\d+\s*)([\s\S]*?)\*\/$/.exec(token);
    if (!comment) return token;
    const body = removeDefiners(comment[2]);
    return body.trim() ? comment[1] + body + '*/' : '';
  });
}

export const portableMysqlDump = data => Buffer.from(removeDefiners(data.toString('latin1')), 'latin1');

const commands = {
  postgres: {
    accepts: file => file.subarray(0, 5).toString() === 'PGDMP',
    ready: `${postgresLogin} exec psql --no-psqlrc --no-password -At ${postgresTarget} --command="SELECT 1"`,
    backup: `${postgresLogin} exec pg_dump --no-password --format=custom ${postgresTarget}`,
    inventory: `${postgresLogin} exec psql --no-psqlrc --no-password -At --set=ON_ERROR_STOP=1 ${postgresTarget} --command="$1"`,
    empty: [`${postgresLogin} exec psql --no-psqlrc --no-password -At --set=ON_ERROR_STOP=1 ${postgresTarget} --command="$1"`, postgresEmpty],
    restore: `${postgresLogin} exec pg_restore --no-password --single-transaction --exit-on-error --no-owner --no-privileges ${postgresTarget}`,
    emptyValue: 't',
    extension: 'pg.dump'
  },
  mysql: {
    accepts: file => file.subarray(0, 14).toString() === '-- MySQL dump ',
    ready: `${mysqlReady} exec mysql ${mysqlTarget} --batch --skip-column-names --user="$user" --database="$MYSQL_DATABASE" --execute="SELECT @@GLOBAL.skip_networking = 0"`,
    backup: `${mysqlRoot} exec mysqldump ${mysqlTarget} --single-transaction --skip-add-drop-table --skip-add-locks --no-tablespaces --set-gtid-purged=OFF --hex-blob --routines --events --triggers --user=root -- "$MYSQL_DATABASE"`,
    inventory: `${mysqlRoot} exec mysql ${mysqlTarget} --batch --raw --skip-column-names --user=root --database="$MYSQL_DATABASE" --execute="$1"`,
    empty: [`${mysqlRoot} exec mysql ${mysqlTarget} --batch --skip-column-names --user=root --database="$MYSQL_DATABASE" --execute="$1"`, mysqlEmpty],
    scope: [`${mysqlUser} exec mysql ${mysqlTarget} --batch --raw --skip-column-names --user="$MYSQL_USER" --database="$MYSQL_DATABASE" --execute="$1"`, mysqlScopeQuery],
    restore: `${mysqlUser} exec mysql ${mysqlTarget} --batch --binary-mode --local-infile=0 --user="$MYSQL_USER" --database="$MYSQL_DATABASE"`,
    portable: portableMysqlDump,
    emptyValue: '1',
    extension: 'mysql.sql'
  }
};

function databaseExec({ container, config, command, signal }) {
  return (script, options = {}, parameter) => command('docker', [
    'exec', ...(options.input ? ['-i'] : []), container, 'sh', '-c', script,
    ...(parameter ? ['stackforge', parameter] : [])
  ], { ...config, ...options, signal });
}

export async function databaseReady(options) {
  try {
    return (await databaseExec(options)(commands[options.engine].ready, { stdoutOnly: true, timeout: 4000 })).trim() === '1';
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return false;
  }
}

export async function databaseInventory(options) {
  const { engine } = options;
  const output = await databaseExec(options)(commands[engine].inventory,
    { stdoutOnly: true, timeout: 10000, stdoutLimit: 512 * 1024 },
    engine === 'postgres' ? `SHOW server_version; ${databaseObjects.postgres};` : `SELECT VERSION(); ${databaseObjects.mysql};`);
  return parseDatabaseInventory(output);
}

export function parseDatabaseInventory(output) {
  const [header, ...objects] = output.trimEnd().split(/\r?\n/);
  const version = /^\d+\.\d+(?:\.\d+)?/.exec(header)?.[0];
  if (!version || output.length >= 512 * 1024) throw new Error('Could not verify the restored database objects.');
  return { version, objects };
}

export async function databaseTransferCapabilities(options) {
  const format = commands[options.engine];
  const docker = databaseExec(options);
  const query = ([script, statement]) => docker(script, { stdoutOnly: true, timeout: 4000, stdoutLimit: 64 * 1024 }, statement);
  try {
    const empty = (await query(format.empty)).trim() === format.emptyValue;
    const restore = empty && (!format.scope || mysqlRestoreIsScoped(await query(format.scope)));
    return { backup: true, restore };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return { backup: options.engine === 'postgres', restore: false };
  }
}

export async function transferDatabase(options) {
  const { engine, project, file } = options;
  const format = commands[engine];
  const docker = databaseExec(options);
  if (file && !format.accepts(file)) throw new Error('Choose a backup file for this database engine.');
  if (!await databaseReady(options)) throw new Error('The database is running but SQL is not ready. Check its logs and retry.');

  if (!file) {
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      const data = await docker(format.backup, { binaryLimit: backupLimit });
      if (!format.accepts(data)) throw new Error();
      const name = project.replace(/[^\w.-]/g, '-').slice(0, 72) || 'project';
      return { data: format.portable ? format.portable(data) : data, filename: `${name}-${date}.${format.extension}` };
    } catch (error) {
      if (error.name === 'AbortError' || error.code === 'OUTPUT_LIMIT') throw error;
      throw new Error(engine === 'mysql' ? 'MySQL backup failed. Check the database name and the container’s root password.' : 'The database backup failed. Check the running database and its configuration.');
    }
  }

  let empty;
  try { empty = (await docker(format.empty[0], { stdoutOnly: true, timeout: 15000 }, format.empty[1])).trim(); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Could not verify that the target database is empty.');
  }
  if (empty !== format.emptyValue) throw new Error('Restore requires an empty database. Start a fresh project database and retry.');
  if (format.scope) {
    let grants;
    try { grants = await docker(format.scope[0], { stdoutOnly: true, timeout: 15000, stdoutLimit: 64 * 1024 }, format.scope[1]); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error(mysqlScopeError);
    }
    if (!mysqlRestoreIsScoped(grants)) throw new Error(mysqlScopeError);
  }
  try { await docker(format.restore, { input: format.portable ? format.portable(file) : file }); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    if (engine === 'mysql' && /ERROR 1419\b|log_bin_trust_function_creators/i.test(error.message)) {
      throw new Error('MySQL blocked stored functions or triggers. Check log_bin_trust_function_creators before retrying on an empty database.');
    }
    if (engine === 'mysql') throw new Error('MySQL restore was interrupted or failed. The database may contain partially restored objects.');
    throw new Error('PostgreSQL restore failed. Check that the backup is valid and compatible with the target database.');
  }
}
