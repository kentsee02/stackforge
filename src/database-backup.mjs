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
const postgresLogin = `${readPassword('POSTGRES_PASSWORD')} export PGPASSWORD="$password"; user=\${POSTGRES_USER:-postgres}; db=\${POSTGRES_DB:-$user};`;
const mysqlDatabase = 'case "$(printf \'%s\' "${MYSQL_DATABASE:-}" | tr \'[:upper:]\' \'[:lower:]\')" in ""|mysql|information_schema|performance_schema|sys) exit 1;; esac;';
const mysqlRoot = `${mysqlDatabase} ${readPassword('MYSQL_ROOT_PASSWORD')} test -n "$password" || exit 1; export MYSQL_PWD="$password";`;
const mysqlUser = `${mysqlDatabase} case "\${MYSQL_USER:-}" in ""|[rR][oO][oO][tT]) exit 1;; esac; ${readPassword('MYSQL_PASSWORD')} export MYSQL_PWD="$password";`;

// mysql uses account qualifiers in CREATE statements and versioned SQL comments.
// Keep quoted SQL data byte-for-byte while letting objects use the restore account.
const account = "(?:`(?:``|[^`])*`|'(?:\\\\.|''|[^'\\\\])*'|\"(?:\\\\.|\"\"|[^\"\\\\])*\")";
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

const commands = {
  postgres: {
    accepts: file => file.subarray(0, 5).toString() === 'PGDMP',
    backup: `${postgresLogin} exec pg_dump --no-password --format=custom --username="$user" --dbname="$db"`,
    empty: [`${postgresLogin} exec psql --no-psqlrc --no-password -At --set=ON_ERROR_STOP=1 --username="$user" --dbname="$db" --command="$1"`, postgresEmpty],
    restore: `${postgresLogin} exec pg_restore --no-password --single-transaction --exit-on-error --no-owner --no-privileges --username="$user" --dbname="$db"`,
    emptyValue: 't',
    extension: 'pg.dump'
  },
  mysql: {
    accepts: file => file.subarray(0, 14).toString() === '-- MySQL dump ',
    backup: `${mysqlRoot} exec mysqldump --no-defaults --single-transaction --skip-add-drop-table --skip-add-locks --no-tablespaces --set-gtid-purged=OFF --hex-blob --routines --events --triggers --user=root -- "$MYSQL_DATABASE"`,
    empty: [`${mysqlRoot} exec mysql --no-defaults --batch --skip-column-names --user=root --database="$MYSQL_DATABASE" --execute="$1"`, mysqlEmpty],
    restore: `${mysqlUser} exec mysql --no-defaults --batch --binary-mode --local-infile=0 --user="$MYSQL_USER" --database="$MYSQL_DATABASE"`,
    portable: data => Buffer.from(removeDefiners(data.toString('latin1')), 'latin1'),
    emptyValue: '1',
    extension: 'mysql.sql'
  }
};

export async function transferDatabase({ engine, project, container, config, command, file, signal }) {
  const format = commands[engine];
  const docker = (script, options = {}, parameter) => command('docker', [
    'exec', ...(options.input ? ['-i'] : []), container, 'sh', '-c', script,
    ...(parameter ? ['stackforge', parameter] : [])
  ], { ...config, ...options, signal });

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

  if (!format.accepts(file)) throw new Error('Choose a backup file for this database engine.');
  let empty;
  try { empty = (await docker(format.empty[0], { stdoutOnly: true, timeout: 15000 }, format.empty[1])).trim(); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Could not verify that the target database is empty.');
  }
  if (empty !== format.emptyValue) throw new Error('Restore requires an empty database. Start a fresh project database and retry.');
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
