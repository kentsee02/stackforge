import { databaseKey } from '../discovery.mjs';

const unsafe = 'Could not verify the project MySQL binary log. Check the database and preview the migration again.';

export function mysqlMigrationScope(cli, container, name, user) {
  const rootSql = (sql, options) => cli(['exec', container, 'sh', '-c',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --no-defaults --no-login-paths --protocol=SOCKET -uroot --batch --raw --skip-column-names -e "$1"',
    'stackforge', sql], options);
  return {
    async snapshot() {
      try {
        const raw = await rootSql("SELECT @@server_uuid, @@global.log_bin, @@global.read_only; SHOW BINARY LOG STATUS;");
        const [settings, status] = raw.split(/\r?\n/);
        const [uuid, logging, readonly] = settings.split('\t');
        const [file, position, include, exclude] = status?.trimEnd().split('\t') ?? [];
        if (!/^[\da-f-]{36}$/i.test(uuid) || logging !== '1' || readonly !== '0' ||
            !/^[\w.-]+\.\d+$/.test(file ?? '') || !/^[1-9]\d*$/.test(position ?? '') || include || exclude) throw new Error();
        return { uuid, cursor: databaseKey(file, position) };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error(unsafe);
      }
    },
    async cancel(application) {
      if (!/^stackforge_migration_[a-f\d]{24}$/.test(application)) throw new Error(unsafe);
      const sessions = await rootSql(
        "SELECT DISTINCT attr.PROCESSLIST_ID FROM performance_schema.session_connect_attrs attr " +
        "JOIN performance_schema.threads thread ON thread.PROCESSLIST_ID=attr.PROCESSLIST_ID " +
        "WHERE attr.ATTR_NAME='stackforgeMigration' AND attr.ATTR_VALUE='" + application +
        "' AND thread.PROCESSLIST_USER='" + user + "' AND thread.PROCESSLIST_DB='" + name + "';",
        { signal: null, timeout: 8000 });
      const ids = sessions.trim().split(/\r?\n/).filter(id => /^[1-9]\d*$/.test(id));
      if (ids.length) await rootSql(ids.map(id => 'KILL CONNECTION ' + id + ';').join('\n'), { signal: null, timeout: 8000 });
    }
  };
}
