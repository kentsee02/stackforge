import { sqlServerDatabaseGuid } from '../docker/sql-server-development.mjs';

const lexer = /^[ \t]*GO[ \t]*(?:--[^\r\n]*)?(?=\r?$)|--[^\r\n]*|\/\*|\r?\n|[ \t]+|N?'(?:[^']|'')*'|\[(?:[^\]]|\]\])*\]|"(?:[^"]|"")*"|[A-Za-z_@][\w@$]*|[0-9]+|[();.,:=+\-*/%&|<>~!^]/gimy;
const supported = /^(?:(?:create|alter|drop) (?:table|schema|index|sequence|view)|create (?:unique index|nonclustered index|clustered index)|insert into|update|delete from)\b/;
const unsafe = /\b(?:exec|execute|revert|use|transaction|commit|rollback|grant|deny|revoke|login|database|backup|restore|bulk|openrowset|opendatasource|openquery|waitfor|setuser)\b/;
const wrapper = /^\s*IF\s+OBJECT_ID\s*\(\s*N?'[^']+'\s*\)\s+IS\s+NULL\s+BEGIN\s+([\s\S]+?)\s+END\s*;?\s*$/i;

export function efSqlServerStatements(sql) {
  function scan(text, batchOnly = false) {
    const pattern = new RegExp(lexer);
    const statements = [];
    let start = 0, words = [];
    function finish(end, next) {
      const statement = text.slice(start, end).trim();
      const command = words.join(' ');
      start = next;
      words = [];
      if (!command) return true;
      if (!batchOnly && /^(?:begin tran(?:saction)?|commit(?: tran(?:saction)?)?)$/.test(command)) return true;
      if (!batchOnly && (!supported.test(command) || unsafe.test(command))) return false;
      if (statements.length >= 1024) return false;
      statements.push(statement);
      return true;
    }
    while (pattern.lastIndex < text.length) {
      const match = pattern.exec(text);
      if (!match) return;
      const [token] = match;
      if (token === '/*') {
        const markers = /\/\*|\*\//g;
        markers.lastIndex = pattern.lastIndex;
        let depth = 1;
        while (depth) {
          const boundary = markers.exec(text);
          if (!boundary) return;
          depth += boundary[0] === '/*' ? 1 : -1;
        }
        pattern.lastIndex = markers.lastIndex;
      } else if (/^[ \t]*GO[ \t]*(?:--.*)?$/i.test(token) && (match.index === 0 || text[match.index - 1] === '\n')) {
        if (!batchOnly || !finish(match.index, pattern.lastIndex)) return;
      } else if (token === ';' && !batchOnly) {
        if (!finish(match.index, pattern.lastIndex)) return;
      } else if (token.trim() && !token.startsWith('--')) {
        if (/^[["]#/.test(token)) return;
        words.push(/^(?:N?'|\[|")/i.test(token) ? 'literal' : token.toLowerCase());
      }
    }
    if (!finish(text.length, text.length)) return;
    return statements;
  }
  const batches = scan(sql.replace(/^\uFEFF/, ''), true);
  const statements = [];
  for (const batch of batches ?? []) {
    const conditional = wrapper.exec(batch);
    const entries = scan(conditional?.[1] ?? batch);
    if (!entries || conditional && (entries.length !== 1 || !/^\s*CREATE\s+TABLE\b/i.test(entries[0]))) return;
    statements.push(...(conditional ? [batch] : entries));
  }
  return statements.length && statements.length <= 1024 ? statements : undefined;
}

const literal = value => "N'" + value.replaceAll("'", "''") + "'";

export async function efSqlServerIdentity(query, target, history) {
  const relation = '[' + history.schema + '].[' + history.table + ']';
  const output = (await query("SET NOCOUNT ON; SELECT DB_NAME(), " + sqlServerDatabaseGuid +
    ", IIF(EXISTS (SELECT 1 FROM sys.objects WHERE is_ms_shipped=0 AND type IN ('U','V','SO','P','FN','IF','TF','SN','TT')" +
    " AND schema_id=SCHEMA_ID(N'" + history.schema + "') AND object_id<>ISNULL(OBJECT_ID(N'" + relation + "'),-1)), 1, 0);")).trim();
  const [name, id, populated] = output.split(/\s+/);
  if (name !== target.name || !/^[a-f\d-]{36}$/i.test(id ?? '') || !/^[01]$/.test(populated ?? '')) {
    throw new Error('Could not verify the project SQL Server database.');
  }
  return { id, populated: populated === '1' };
}

export function efSqlServerTransaction({ target, history, before, relationId, current, expected, statements, applicationName }) {
  const relation = '[' + history.schema + '].[' + history.table + ']';
  const lookup = "OBJECT_ID(N'" + relation + "')";
  function verify(ids, original) {
    const query = 'SELECT @rows=(SELECT MigrationId FROM ' + relation +
      ' WITH (TABLOCKX,HOLDLOCK) ORDER BY MigrationId COLLATE Latin1_General_100_BIN2 FOR JSON PATH);';
    const match = literal(JSON.stringify([...ids].sort().map(MigrationId => ({ MigrationId }))));
    return `IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE object_id=${lookup} AND is_memory_optimized=0)
      OR EXISTS (SELECT 1 FROM sys.security_predicates WHERE target_object_id=${lookup})
      OR (SELECT count(*) FROM sys.columns WHERE object_id=${lookup} AND is_computed=0
        AND name IN (N'MigrationId',N'ProductVersion') AND system_type_id IN (167,231))<>2
      ${original ? 'OR ' + lookup + '<>' + original : ''} THROW 51000, 'History table changed', 1;
      EXEC sys.sp_executesql ${literal(query)},N'@rows nvarchar(max) OUTPUT',@rows OUTPUT;
      IF ISNULL(@rows,N'[]') COLLATE Latin1_General_100_BIN2<>${match} THROW 51000, 'Unexpected history', 1;`;
  }
  const statementsSql = statements.map(sql =>
    "SET @sql=CONVERT(nvarchar(max),0x" + Buffer.from(sql, 'utf16le').toString('hex') + "); EXEC sys.sp_executesql @sql;");
  return `SET NOCOUNT ON; SET XACT_ABORT ON; SET LOCK_TIMEOUT 5000;
  SET CONTEXT_INFO 0x${applicationName.slice(-24)};
  BEGIN TRY
    BEGIN TRANSACTION;
    DECLARE @lock int, @rows nvarchar(max), @sql nvarchar(max);
    EXEC @lock=sys.sp_getapplock @Resource=N'StackForge:EF Core',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
    IF @lock<0 OR DB_NAME()<>${literal(target.name)} OR ISNULL(${sqlServerDatabaseGuid},'')<>${literal(before.id)}
      OR EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND (is_trustworthy_on=1 OR is_db_chaining_on=1))
      OR EXISTS(SELECT 1 FROM sys.configurations WHERE name=N'cross db ownership chaining' AND CONVERT(int,value_in_use)<>0)
      THROW 51000, 'Database target changed', 1;
    ${relationId ? verify(current, relationId) : `IF ${lookup} IS NOT NULL THROW 51000, 'History table changed', 1;`}
    EXECUTE AS USER=N'dbo';
    ${statementsSql.join('\n')}
    REVERT;
    ${verify(expected, relationId)}
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH;`;
}
