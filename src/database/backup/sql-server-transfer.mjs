import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { throwIfCancelled } from '../../platform/process.mjs';
import { sqlServerContainerQuery, sqlServerDatabaseGuid, sqlServerDevelopment } from '../docker/sql-server-development.mjs';
import { backupLimit } from './docker-transfer.mjs';

const label = 'io.stackforge.sqlserver-restore-check';
const invalidBackup = 'SQL Server backup verification requires a checksummed full backup with one data file and one log file.';
const changed = 'Could not verify the project SQL Server database.';
const limit = 1024 * 1024 * 1024;
const guid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const containerId = /^[a-f\d]{64}$/;
const dataDirectory = '/var/opt/mssql/data/';
const quote = value => "N'" + value.replaceAll("'", "''") + "'";
const ident = value => '[' + value.replaceAll(']', ']]') + ']';

const objects = db => `SELECT o.type, QUOTENAME(s.name) AS schema_name, QUOTENAME(o.name) AS object_name
  FROM ${db}sys.objects AS o INNER JOIN ${db}sys.schemas AS s ON o.schema_id=s.schema_id WHERE o.is_ms_shipped=0`;
const empty = db => `NOT EXISTS (${objects(db)}) AND
  NOT EXISTS (SELECT 1 FROM ${db}sys.schemas WHERE schema_id BETWEEN 5 AND 16383) AND
  NOT EXISTS (SELECT 1 FROM ${db}sys.database_principals WHERE principal_id>4 AND is_fixed_role=0 AND name<>N'public') AND
  NOT EXISTS (SELECT 1 FROM ${db}sys.triggers WHERE parent_class=0 AND is_ms_shipped=0) AND
  NOT EXISTS (SELECT 1 FROM ${db}sys.types WHERE is_user_defined=1) AND
  NOT EXISTS (SELECT 1 FROM ${db}sys.assemblies WHERE is_user_defined=1) AND
  NOT EXISTS (SELECT 1 FROM ${db}sys.partition_functions) AND
  NOT EXISTS (SELECT 1 FROM ${db}sys.fulltext_catalogs) AND
  NOT EXISTS (SELECT 1 FROM ${db}sys.database_scoped_credentials) AND
  NOT EXISTS (SELECT 1 FROM ${db}sys.extended_properties WHERE class<>0 OR name<>N'StackForgeOwner')`;
const ownership = record => `EXISTS (SELECT 1 FROM master.sys.database_recovery_status
  WHERE database_id=DB_ID(${quote(record.name)}) AND database_guid=${quote(record.sqlDatabase)}) AND
  EXISTS (SELECT 1 FROM ${ident(record.name)}.sys.extended_properties
  WHERE class=0 AND name=N'StackForgeOwner' AND CONVERT(nvarchar(32),value)=${quote(record.key)})`;

async function inventory(query) {
  const output = (await query(`SET NOCOUNT ON;
    SELECT CONVERT(varchar(15),COUNT_BIG(*))+'|'+CONVERT(varchar(64),HASHBYTES('SHA2_256',
      COALESCE(STRING_AGG(CONVERT(nvarchar(max),RTRIM(type)+schema_name+object_name),NCHAR(10))
       WITHIN GROUP (ORDER BY type,schema_name COLLATE Latin1_General_100_BIN2,object_name COLLATE Latin1_General_100_BIN2),N'')),2)
    FROM (${objects('')}) AS items;`)).trim();
  const result = /^(\d{1,12})\|([a-f\d]{64})$/i.exec(output);
  if (!result) throw new Error(changed);
  return { count: Number(result[1]), objects: [result[2]], limited: false };
}

async function withBackupFile(cli, container, data, task) {
  const path = '/tmp/stackforge-' + randomBytes(16).toString('hex') + '.bak';
  try {
    if (data !== undefined) {
      if (!Buffer.isBuffer(data)) throw new Error(invalidBackup);
      await cli(['exec', '-i', container, 'sh', '-c', 'umask 077; set -C; cat > "$1"', 'stackforge', path],
        { input: data, timeout: 90000 });
    }
    return await task(path);
  } finally {
    await cli(['exec', container, 'rm', '-f', '--', path], { signal: null, timeout: 10000 }).catch(() => {});
  }
}

async function filesIn(query, path) {
  const output = await query(`SET NOCOUNT ON;
    DECLARE @files TABLE (LogicalName nvarchar(128), PhysicalName nvarchar(260), Type char(1), FileGroupName nvarchar(128),
      Size numeric(20,0), MaxSize numeric(20,0), FileId bigint, CreateLSN numeric(25,0), DropLSN numeric(25,0),
      UniqueId uniqueidentifier, ReadOnlyLSN numeric(25,0), ReadWriteLSN numeric(25,0), BackupSizeInBytes bigint,
      SourceBlockSize int, FileGroupId int, LogGroupGUID uniqueidentifier, DifferentialBaseLSN numeric(25,0),
      DifferentialBaseGUID uniqueidentifier, IsReadOnly bit, IsPresent bit, TDEThumbprint varbinary(32), SnapshotURL nvarchar(360));
    DECLARE @statement nvarchar(max)=${quote('RESTORE FILELISTONLY FROM DISK=' + quote(path) + ' WITH FILE=1')};
    INSERT @files EXEC(@statement);
    IF (SELECT COUNT(*) FROM @files)<>2 OR (SELECT SUM(Size) FROM @files)>${limit}
      OR EXISTS(SELECT 1 FROM @files WHERE IsPresent<>1 OR TDEThumbprint IS NOT NULL OR SnapshotURL IS NOT NULL)
      THROW 51000,'Unsupported backup file layout.',1;
    SELECT CONVERT(nvarchar(140),Type+N'|'+LogicalName) FROM @files ORDER BY Type;`, { timeout: 30000 });
  const rows = output.trim().split(/\r?\n/);
  const data = /^D\|([\w .-]{1,128})$/.exec(rows[0])?.[1];
  const log = /^L\|([\w .-]{1,128})$/.exec(rows[1])?.[1];
  if (rows.length !== 2 || !data || !log) throw new Error(invalidBackup);
  return { data, log };
}

function restoreSql(name, path, files, data, log, options = '') {
  return `RESTORE DATABASE ${ident(name)} FROM DISK=${quote(path)} WITH FILE=1, CHECKSUM, RECOVERY,
    MOVE ${quote(files.data)} TO ${quote(data)}, MOVE ${quote(files.log)} TO ${quote(log)}${options};`;
}

async function isolatedRestore(cli, image, backup, signal) {
  const nonce = randomBytes(12).toString('hex');
  const name = 'stackforge-sql-restore-' + nonce;
  const database = 'stackforge_check';
  try {
    const container = (await cli(['run', '-d', '--pull=never', '--network', 'none', '--name', name,
      '--label', label + '=' + nonce, '--memory', '2g', '--pids-limit', '512', '--env', 'ACCEPT_EULA=Y',
      '--env', 'MSSQL_PID=Developer', '--env', 'MSSQL_MEMORY_LIMIT_MB=1400', '--env', 'MSSQL_SA_PASSWORD', image],
      { extraEnv: { MSSQL_SA_PASSWORD: 'Aa1!' + randomBytes(24).toString('hex') }, timeout: 30000 })).trim();
    if (!containerId.test(container)) throw new Error(invalidBackup);
    const master = (sql, options) => sqlServerContainerQuery(cli, container, 'master', sql, options);
    const query = sql => sqlServerContainerQuery(cli, container, database, sql, { timeout: 120000 });
    const deadline = Date.now() + 90000;
    for (;;) {
      try { await master('SET NOCOUNT ON; SELECT 1;'); break; }
      catch (error) { if (error.name === 'AbortError' || Date.now() >= deadline) throw error; }
      await delay(600, undefined, { signal });
    }
    return await withBackupFile(cli, container, backup, async path => {
      const files = await filesIn(master, path);
      await master(restoreSql(database, path, files, dataDirectory + nonce + '.mdf', dataDirectory + nonce + '.ldf'), { timeout: 120000 });
      await query(`DBCC CHECKDB (${ident(database)}) WITH NO_INFOMSGS, ALL_ERRORMSGS;`);
      return inventory(query);
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('The SQL Server backup could not be restored and verified in isolation.');
  } finally {
    try {
      const [container, marker] = (await cli(['container', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "' + label + '"}}', name],
        { signal: null, timeout: 10000 })).trim().split(' ');
      if (containerId.test(container) && marker === nonce) await cli(['container', 'rm', '-fv', container], { signal: null, timeout: 30000 });
    } catch { /* Recheck ownership before cleaning up a partial start. */ }
  }
}

export async function sqlServerRestoreAllowed(cli, container, record) {
  const result = await sqlServerContainerQuery(cli, container, 'master',
    `SET NOCOUNT ON; SELECT CASE WHEN ${empty(ident(record.name) + '.')} THEN 1 ELSE 0 END;`);
  return result.trim() === '1';
}

export async function sqlServerArchiveTarget({ cli, record, verify, identity, beginWrite, updateIdentity, signal }) {
  if (!guid.test(record.sqlDatabase)) throw new Error(changed);
  const checked = await verify();
  const container = checked.container;
  const master = (sql, options) => sqlServerContainerQuery(cli, container, 'master', sql, options);
  const query = (sql, options) => sqlServerContainerQuery(cli, container, record.name, sql, options);
  const database = ident(record.name);
  const prefix = database + '.';
  const image = (await cli(['container', 'inspect', '--format', '{{.Image}}', container])).trim();
  const version = (await master(`SET NOCOUNT ON; SELECT CONCAT(SERVERPROPERTY('ProductMajorVersion'),'.',
    PARSENAME(CONVERT(varchar(40),SERVERPROPERTY('ProductVersion')),3),'.',
    PARSENAME(CONVERT(varchar(40),SERVERPROPERTY('ProductVersion')),2));`)).trim();
  if (!/^sha256:[a-f\d]{64}$/.test(image) || !/^16\.\d+\.\d+$/.test(version)) throw new Error(changed);
  const canRestore = await sqlServerRestoreAllowed(cli, container, record);
  return { engine: 'sqlserver', name: record.name, version, identity, canRestore,
    check: data => isolatedRestore(cli, image, data, signal),
    async inventory() { await verify(); return inventory(query); },
    async export() {
      await verify();
      return withBackupFile(cli, container, undefined, async path => {
        try {
          await master(`SET NOCOUNT ON; IF NOT (${ownership(record)}) THROW 51000,'Database ownership changed.',1;
            BACKUP DATABASE ${database} TO DISK=${quote(path)} WITH COPY_ONLY, CHECKSUM, COMPRESSION, INIT;`, { timeout: 120000 });
          return { data: await cli(['exec', container, 'cat', '--', path], { binaryLimit: backupLimit, timeout: 90000 }) };
        } catch (error) {
          if (error.name === 'AbortError' || error.code === 'OUTPUT_LIMIT') throw error;
          throw new Error('Could not create the SQL Server backup. Check the project database and available disk space.');
        }
      });
    },
    async restore(data) {
      await verify();
      return withBackupFile(cli, container, data, async path => {
        const files = await filesIn(master, path);
        const output = (await master(`SET NOCOUNT ON; SELECT CONVERT(varchar(240),type_desc+'|'+physical_name)
          FROM sys.master_files WHERE database_id=DB_ID(${quote(record.name)}) ORDER BY type;`)).trim();
        const [dataFile, logFile, ...other] = output.split(/\r?\n/);
        const dataPath = /^ROWS\|(\/var\/opt\/mssql\/data\/[\w.-]+\.mdf)$/.exec(dataFile)?.[1];
        const logPath = /^LOG\|(\/var\/opt\/mssql\/data\/[\w.-]+\.ldf)$/.exec(logFile)?.[1];
        if (!dataPath || !logPath || other.length) throw new Error(changed);
        await verify();
        throwIfCancelled(signal);
        beginWrite();
        try {
          await master(`SET NOCOUNT ON; DECLARE @locked bit=0;
            BEGIN TRY
              IF NOT (${ownership(record)}) OR NOT (${empty(prefix)}) THROW 51000,'Database target changed.',1;
              ALTER DATABASE ${database} SET SINGLE_USER WITH NO_WAIT;
              SET @locked=1;
              IF NOT (${ownership(record)}) OR NOT (${empty(prefix)}) THROW 51000,'Database target changed.',1;
              ${restoreSql(record.name, path, files, dataPath, logPath, ', REPLACE, RESTRICTED_USER')}
              ALTER DATABASE ${database} SET TRUSTWORTHY OFF;
              ALTER DATABASE ${database} SET DB_CHAINING OFF;
              IF EXISTS (SELECT 1 FROM ${prefix}sys.extended_properties WHERE class=0 AND name=N'StackForgeOwner')
                EXEC ${prefix}sys.sp_updateextendedproperty @name=N'StackForgeOwner', @value=${quote(record.key)};
              ELSE EXEC ${prefix}sys.sp_addextendedproperty @name=N'StackForgeOwner', @value=${quote(record.key)};
            END TRY
            BEGIN CATCH
              IF @locked=1 AND (${ownership(record)}) ALTER DATABASE ${database} SET MULTI_USER WITH NO_WAIT;
              THROW;
            END CATCH;`, { timeout: 120000 });
          const sqlDatabase = await sqlServerDevelopment(cli, container, { ...record, sqlDatabase: undefined }).identity();
          await updateIdentity(sqlDatabase);
          await master(`ALTER DATABASE ${database} SET MULTI_USER WITH NO_WAIT;`);
          await verify();
        } catch {
          throw new Error('SQL Server could not finish the restore. Check that the target is empty and has no active connections, then review its state.');
        }
      });
    }
  };
}
