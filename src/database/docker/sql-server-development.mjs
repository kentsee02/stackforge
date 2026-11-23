import { setTimeout as delay } from 'node:timers/promises';

export const sqlServerTerms = 'https://www.microsoft.com/content/dam/microsoft/usetm/documents/sql-server/sql-server-2022-developer-express-evaluation/retail-packaged/SQLServer2022_SQLServer2022DeveloperExpressEvaluation_English.pdf';
const unavailable = 'Could not verify the project SQL Server database.';
const guid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function sqlServerContainerQuery(cli, container, database, sql, options = {}) {
  return cli(['exec', '-i', container, 'sh', '-c',
    'export SQLCMDPASSWORD="$MSSQL_SA_PASSWORD"; exec /opt/mssql-tools18/bin/sqlcmd -S tcp:127.0.0.1,1433 -d "$1" -U sa -C -b -l 4 -h -1 -W -x -X1',
    'stackforge', database], { stdoutLimit: 768 * 1024, timeout: 15000, ...options,
    input: Buffer.from(sql + '\nGO\n', 'utf8') });
}

export const sqlServerDatabaseGuid = "(SELECT CONVERT(varchar(36), database_guid) FROM master.sys.database_recovery_status WHERE database_id=DB_ID())";

export function sqlServerDevelopment(cli, container, record) {
  const query = (sql, options) => sqlServerContainerQuery(cli, container, record.name, sql, options);
  const identity = async () => {
    const result = (await query("SET NOCOUNT ON; SELECT " + sqlServerDatabaseGuid +
      " FROM sys.extended_properties WHERE class=0 AND name=N'StackForgeOwner' AND CONVERT(nvarchar(32),value)=N'" + record.key + "';")).trim();
    if (!guid.test(result) || record.sqlDatabase && result !== record.sqlDatabase) throw new Error(unavailable);
    return result;
  };
  return { query, identity, async initialize(signal) {
    let online = false;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        await sqlServerContainerQuery(cli, container, 'master', 'SET NOCOUNT ON; SELECT 1;');
        online = true;
        break;
      } catch (error) { if (error.name === 'AbortError') throw error; }
      await delay(1000, undefined, { signal });
    }
    if (!online) throw new Error(unavailable);
    if (record.sqlDatabase) return identity();
    await sqlServerContainerQuery(cli, container, 'master', "SET NOCOUNT ON; IF DB_ID(N'" + record.name + "') IS NULL BEGIN " +
      "EXEC(N'CREATE DATABASE [" + record.name + "]'); EXEC [" + record.name +
      "].sys.sp_addextendedproperty @name=N'StackForgeOwner', @value=N'" + record.key + "'; END;");
    return identity();
  }, async cancel(application) {
    const key = /^stackforge_migration_([a-f\d]{24})$/.exec(application)?.[1];
    if (!key) throw new Error(unavailable);
    await sqlServerContainerQuery(cli, container, 'master', "SET NOCOUNT ON; " +
      "DECLARE @kill nvarchar(max); SELECT @kill=STRING_AGG(CONVERT(nvarchar(max),'KILL '+CONVERT(varchar(12),session_id)),';') " +
      "FROM sys.dm_exec_sessions WHERE context_info=0x" + key + " AND database_id=DB_ID(N'" + record.name +
      "') AND session_id<>@@SPID; IF @kill IS NOT NULL EXEC sys.sp_executesql @kill;", { timeout: 10000, signal: null });
  } };
}
