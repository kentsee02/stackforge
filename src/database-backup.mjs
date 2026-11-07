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

const commands = {
  postgres: {
    accepts: file => file.subarray(0, 5).toString() === 'PGDMP',
    backup: 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump --no-password --format=custom --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"',
    empty: ['export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql --no-psqlrc --no-password -At --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="$1"', postgresEmpty],
    restore: 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore --no-password --single-transaction --exit-on-error --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"',
    emptyValue: 't',
    extension: 'pg.dump'
  },
  mysql: {
    accepts: file => file.subarray(0, 14).toString() === '-- MySQL dump ',
    backup: 'export MYSQL_PWD="$MYSQL_PASSWORD"; exec mysqldump --no-defaults --single-transaction --skip-add-drop-table --skip-add-locks --no-tablespaces --set-gtid-purged=OFF --hex-blob --user="$MYSQL_USER" -- "$MYSQL_DATABASE"',
    empty: ['export MYSQL_PWD="$MYSQL_PASSWORD"; exec mysql --no-defaults --batch --skip-column-names --user="$MYSQL_USER" --database="$MYSQL_DATABASE" --execute="$1"', mysqlEmpty],
    restore: 'test "$MYSQL_USER" != root && export MYSQL_PWD="$MYSQL_PASSWORD" && exec mysql --no-defaults --batch --binary-mode --local-infile=0 --user="$MYSQL_USER" --database="$MYSQL_DATABASE"',
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
      return { data, filename: `${project}-${date}.${format.extension}` };
    } catch (error) {
      if (error.name === 'AbortError' || error.code === 'OUTPUT_LIMIT') throw error;
      throw new Error('The database backup failed. Check the running database and its configuration.');
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
  try { await docker(format.restore, { input: file }); }
  catch (error) {
    if (engine === 'mysql') throw new Error('MySQL restore was interrupted or failed. The database may contain partially restored objects.');
    throw new Error('PostgreSQL restore failed. Check that the backup is valid and compatible with the target database.');
  }
}
