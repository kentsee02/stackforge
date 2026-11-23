import { validateLocalTarget } from '../adapters/local.mjs';
import { databaseConnectionValue, databaseKey, sqlName } from '../discovery.mjs';

export function mysqlHistoryTargets({ requirements, connections }) {
  const targets = [];
  const seen = new Set();
  for (const item of requirements) {
    if (item.engine !== 'mysql' || item.status !== 'configured' || item.variant === 'mariadb') continue;
    const connection = connections.get(item.id);
    if (connection?.environmentConflict) continue;
    const value = databaseConnectionValue(connection?.value?.replace(/^jdbc:/i, ''), 'mysql');
    if (!value) continue;
    try {
      validateLocalTarget(item, item);
      const url = new URL(value);
      const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
      if (url.search || !sqlName.test(user) || password.length > 1024 || /[\0\r\n]/.test(password)) continue;
      const { host, port, name, source, environmentVariable: variable } = item;
      const fingerprint = databaseKey(host, port, name, user, password);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      targets.push({ public: { id: databaseKey('mysql-migrations', item.id, host, port, name), engine: 'mysql', host, port, name, source, variable },
        credentials: { user, password } });
    } catch { /* Ambiguous and non-local connections stay outside the selector. */ }
  }
  return targets;
}

export function mysqlHistoryTable(name, table) {
  if (typeof table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) throw new Error('Enter a valid MySQL history table name.');
  return { schema: name, table };
}

const types = {
  text: "('varchar', 'text')",
  integer: "('int', 'bigint', 'smallint', 'mediumint')",
  boolean: "('tinyint', 'bit')"
};

export function mysqlHistoryQuery({ table }, columns, { maxRows, row, order }) {
  const conditions = Object.entries(columns).map(([name, type]) => `column_name = '${name}' AND data_type IN ${types[type]}`);
  const relation = '`' + table + '`';
  const select = `SELECT JSON_OBJECT('name', DATABASE(), 'table', 'readable', 'rows',
    COALESCE(JSON_ARRAYAGG(entry), JSON_ARRAY())) FROM
    (SELECT ${row} AS entry FROM ${relation} ${order} LIMIT ${maxRows + 1}) history`;
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  return `START TRANSACTION READ ONLY;
SET @sf_table = (SELECT table_type FROM information_schema.tables WHERE table_schema = DATABASE() AND BINARY table_name = '${table}');
SET @sf_readable = @sf_table = 'BASE TABLE' AND
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND BINARY table_name = '${table}'
    AND generation_expression = '' AND (${conditions.map(condition => '(' + condition + ')').join(' OR ')})) = ${conditions.length};
SET @sf_sql = IF(@sf_readable, ${literal(select)}, ${literal(
  "SELECT JSON_OBJECT('name', DATABASE(), 'table', IF(@sf_table IS NULL, 'absent', 'unsupported'), 'rows', JSON_ARRAY())")});
PREPARE sf_history FROM @sf_sql;
EXECUTE sf_history;
DEALLOCATE PREPARE sf_history;
COMMIT;`;
}
