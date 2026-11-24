import { createHash, createHmac, randomBytes } from 'node:crypto';
import { localSession } from '../adapters/local.mjs';
import { mysqlRestoreIsScoped, mysqlScopeQuery } from '../backup/docker-transfer.mjs';
import { discoverDatabases } from '../discovery.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { throwIfCancelled } from '../../platform/process.mjs';

const signingKey = randomBytes(32);
const maxRows = 200;
const marker = '__stackforge_drizzle_pending';
const changed = 'The Drizzle migration preview changed. Check again before applying.';
const charsetText = text => "CONVERT(X'" + Buffer.from(text, 'utf8').toString('hex') + "' USING utf8mb4)";
const jsonValue = value => 'CAST(' + charsetText(JSON.stringify(value)) + ' AS JSON)';
// The server prepares one statement at a time. Project SQL never reaches the CLI command parser.
const prepare = expression => `SET @sf_statement = ${expression}; PREPARE sf_migration FROM @sf_statement;
EXECUTE sf_migration; DEALLOCATE PREPARE sf_migration;`;
const guard = expression => prepare(`IF(${expression}, 'DO 0', 'STACKFORGE MIGRATION CHECK FAILED')`);

function mysqlStatements(sql, table) {
  const tokens = /\s+|-->(?:[ \t]+statement-breakpoint)[ \t]*(?=\r?$)|--(?=\s|$)[^\r\n]*|#[^\r\n]*|\/\*(?![!+])[\s\S]*?\*\/|'(?:[^'\\\x00]|'')*'|"(?:[^"\\\x00]|"")*"|`(?:[^`\\\x00]|``)*`|[\w$]+|[(),;.=+*%<>!?&|^~:/-]/gmy;
  const supported = /^(?:(?:CREATE (?:TABLE|(?:UNIQUE |FULLTEXT |SPATIAL )?INDEX))|(?:ALTER TABLE)|(?:DROP (?:TABLE|INDEX))|(?:RENAME TABLE)|(?:INSERT INTO)|UPDATE|(?:DELETE FROM))\b/;
  const prohibited = new Set([table.toLowerCase(), marker, 'tablespace', 'outfile', 'dumpfile', 'federated', 'directory', 'load_file']);
  const statements = [];
  let parts = [], words = [];
  function finish() {
    const statement = parts.join('').trim();
    if (!statement) return true;
    if (!supported.test(words.join(' ')) || statements.length >= 400) return false;
    statements.push(statement);
    parts = [];
    words = [];
    return true;
  }
  while (tokens.lastIndex < sql.length) {
    const token = tokens.exec(sql)?.[0];
    if (!token || token.startsWith('/') && token === '/' && sql[tokens.lastIndex] === '*' ||
        token === '-' && sql[tokens.lastIndex] === '-') return;
    if (token === ';') {
      if (!finish()) return;
      continue;
    }
    if (token.startsWith('--') || token.startsWith('/*') || token.startsWith('#')) {
      // Preserve separators between literal words without forwarding comments to the server.
      parts.push(' ');
      continue;
    }
    if (/^\s+$/.test(token)) {
      parts.push(token);
      continue;
    }
    const name = token.replace(/^([`"])|([`"])$/g, '').toLowerCase();
    if (prohibited.has(name)) return;
    if (words.length < 4) words.push(token.toUpperCase());
    parts.push(token);
  }
  if (parts.some(part => part.trim()) && !finish()) return;
  return statements.length ? statements : undefined;
}

function historySql(table, named) {
  const relation = '`' + table + '`';
  const columns = Object.entries({
    id: "data_type='bigint' AND column_key='PRI' AND extra='auto_increment'",
    hash: "data_type='text' AND is_nullable='NO'",
    created_at: "data_type='bigint'",
    name: "data_type='text'",
    applied_at: "data_type='timestamp'"
  });
  const count = (fields, length) => `COUNT(CASE WHEN ${fields.map(([name, type]) =>
    `(column_name='${name}' AND ${type})`).join(' OR ')} THEN 1 END)=${length}`;
  const tableIn = "table_schema = DATABASE() AND BINARY table_name = '" + table + "'";
  const entry = `JSON_ARRAY(CAST(created_at AS CHAR), hash${named ? ', name' : ''})`;
  const rows = `SET @sf_rows = JSON_ARRAY();
    ${prepare(`IF(@sf_history = '${named ? 'v1' : 'legacy'}', ${charsetText(
      `SELECT COALESCE((SELECT JSON_ARRAYAGG(entry) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
       FROM (SELECT id, ${entry} AS entry FROM ${relation} ORDER BY id LIMIT ${maxRows + 1}) recent LIMIT 1), JSON_ARRAY()) INTO @sf_rows`
    )}, 'DO 0')`)}`;
  return `SET @sf_marker = EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND lower(table_name)='${marker}');
    SET @sf_objects = EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND BINARY table_name <> '${table}'
      UNION ALL SELECT 1 FROM information_schema.routines WHERE routine_schema=DATABASE()
      UNION ALL SELECT 1 FROM information_schema.events WHERE event_schema=DATABASE()
      UNION ALL SELECT 1 FROM information_schema.triggers WHERE trigger_schema=DATABASE());
    SET @sf_history = CASE
      WHEN NOT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND lower(table_name)=lower('${table}')) THEN 'absent'
      WHEN NOT EXISTS(SELECT 1 FROM information_schema.tables WHERE ${tableIn} AND table_type='BASE TABLE' AND engine='InnoDB')
        OR EXISTS(SELECT 1 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND lower(event_object_table)=lower('${table}'))
        THEN 'unsupported'
      ELSE (SELECT CASE WHEN COUNT(*)=3 AND ${count(columns.slice(0, 3), 3)} THEN 'legacy'
        WHEN COUNT(*)=5 AND ${count(columns, 5)} THEN 'v1' ELSE 'unsupported' END
        FROM information_schema.columns WHERE ${tableIn} AND generation_expression='') END;
    ${rows}`;
}

async function readState(session, target, metadata) {
  const state = JSON.parse(await session.query(`START TRANSACTION READ ONLY;
    ${metadata}
    SELECT JSON_ARRAY(DATABASE(), @@server_uuid, CAST(@sf_marker AS UNSIGNED), CAST(@sf_objects AS UNSIGNED),
      @sf_history, CAST(@sf_rows AS JSON)); COMMIT;`, target.name));
  const [name, uuid, interrupted, populated, history, rows] = state;
  if (name !== target.name || !/^[\da-f-]{36}$/i.test(uuid) || ![0, 1].includes(interrupted) ||
      ![0, 1].includes(populated) || !['absent', 'unsupported', 'legacy', 'v1'].includes(history) || !Array.isArray(rows)) throw new Error();
  return { uuid, interrupted, populated, history, rows };
}

export async function previewMysqlDrizzle({ project, identity, requirement, config, value, url, target, client, command, signal,
  approval, rollback, verifyTarget, readFiles, migration, respond }) {
  if (rollback) throw new Error('Drizzle MySQL recovery uses a verified database backup.');
  const { files, format } = migration;
  const { historyTable: table } = config;
  if (table.toLowerCase() === marker) return respond('history-conflict');
  const named = format === 'v1';
  const layout = named ? 'v1' : 'legacy';
  const metadata = historySql(table, named);
  let session, state;
  try {
    const credentials = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    session = localSession(target, credentials, client?.command ?? command, signal);
    state = await readState(session, target, metadata);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return respond(['authentication', 'server', 'permission', 'client', 'database', 'tls'].includes(error.issue) ? error.issue : 'connection');
  }
  await resolveStartup(project, [], identity);
  const fields = { history: target.name + '.' + table };
  if (state.interrupted) return respond('recovery-required', fields);
  if (named && state.history === 'legacy') return respond('history-upgrade-required', fields);
  const rows = state.rows;
  if (!['absent', layout].includes(state.history) || rows.length > files.length || !rows.length && state.populated) {
    return respond('history-conflict', fields);
  }
  const local = new Map(files.map(file => [file.tag, file]));
  const applied = new Set(rows.map(([when, hash, name], index) => {
    const file = named ? local.get(name) : files[index];
    return file && hash === file.hash && (named ? /^\d+$/.test(when ?? '') : when === String(file.when)) ? file : undefined;
  }));
  if (applied.has(undefined) || applied.size !== rows.length) return respond('history-conflict', fields);
  const pending = files.filter(file => !applied.has(file));
  const entries = file => ({ file: (requirement.directory === '.' ? '' : requirement.directory + '/') + file.file,
    state: applied.has(file) ? 'applied' : 'pending' });
  fields.migrations = files.map(entries);
  if (!pending.length) {
    if (approval) throw new Error(changed);
    return respond('current', fields);
  }
  if (!client?.migrationScope) {
    if (approval) throw new Error(changed);
    return respond('project-mysql-required', fields);
  }
  const batches = pending.map(file => mysqlStatements(file.sql, table));
  const reviewSql = pending.map(file => '-- ' + entries(file).file + '\n' + file.sql).join('\n\n');
  if (batches.some(statements => !statements) || Buffer.byteLength(reviewSql) > 256 * 1024) {
    if (approval) throw new Error(changed);
    return respond('pending', { ...fields, applyBlocked: true });
  }
  const scope = await client.migrationScope();
  const snapshot = await scope.snapshot();
  if (snapshot.uuid !== state.uuid) throw new Error(changed);
  const credentials = await client.credentials();
  const writer = localSession(target, credentials, client.command, signal);
  if (!mysqlRestoreIsScoped(await writer.query(mysqlScopeQuery + ';', target.name))) return respond('unscoped-account', fields);
  const current = await readState(writer, target, metadata);
  const stable = await scope.snapshot();
  if (JSON.stringify(current) !== JSON.stringify(state) || stable.uuid !== snapshot.uuid || stable.cursor !== snapshot.cursor) {
    throw new Error(changed);
  }
  const filesKey = ({ format, files }) => [format, files.map(({ file, when, hash }) => [file, when, hash])];
  const expires = approval ? /^\d{13}(?=\.)/.exec(approval.planId ?? '')?.[0] : String(Date.now() + 300000);
  const planId = expires + '.' + createHmac('sha256', signingKey).update(JSON.stringify([
    expires, project.id, identity, requirement.id, target, value, config.out, table, scope.container, snapshot, state, filesKey(migration)
  ])).digest('hex');
  if (!approval) return respond('pending', { ...fields, planId, reviewSql });
  if (!expires || Number(expires) <= Date.now() || approval.planId !== planId || approval.confirmName !== target.name) throw new Error(changed);
  await verifyTarget(target);
  const latest = (await discoverDatabases(project, { includeConnections: true })).connections.get(requirement.id);
  if (!latest || latest.environmentConflict || latest.value !== value || latest.out !== config.out || latest.historyTable !== table ||
      JSON.stringify(filesKey(await readFiles())) !== JSON.stringify(filesKey(migration))) throw new Error(changed);
  await resolveStartup(project, [], identity);
  await scope.verify();
  const before = await scope.snapshot();
  if (before.uuid !== snapshot.uuid || before.cursor !== snapshot.cursor) throw new Error(changed);
  throwIfCancelled(signal);

  const expected = [...rows, ...pending.map(file => [String(file.when), file.hash, ...(named ? [file.tag] : [])])];
  const relation = '`' + table + '`';
  const lock = createHash('sha256').update('stackforge-drizzle:' + target.name).digest('hex');
  const application = 'stackforge_migration_' + randomBytes(12).toString('hex');
  const setup = state.history === 'absent' ? `CREATE TABLE ${relation} (id SERIAL PRIMARY KEY, hash TEXT NOT NULL,
    created_at BIGINT${named ? ', name TEXT, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : ''}) ENGINE=InnoDB;` : '';
  const operations = pending.flatMap((file, index) => [
    ...batches[index].map(sql => prepare(charsetText(sql))),
    `INSERT INTO ${relation} (hash, created_at${named ? ', name' : ''})
      VALUES ('${file.hash}', ${file.when}${named ? ", '" + file.tag + "'" : ''});`
  ]);
  try {
    // DDL can commit before an error or disconnect. Keep the marker until the complete ledger is verified.
    await writer.query(`SET @stackforge_migration = '${application}', SESSION lock_wait_timeout=5, SESSION innodb_lock_wait_timeout=5;
      ${guard(`GET_LOCK('${lock}', 0) = 1`)}
      ${metadata}
      ${guard(`@@server_uuid = '${state.uuid}' AND @sf_marker=0 AND @sf_objects=${state.populated}
        AND @sf_history='${state.history}' AND CAST(@sf_rows AS JSON)=${jsonValue(rows)}`)}
      CREATE TABLE \`${marker}\` (started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB;
      ${setup}
      ${operations.join('\n')}
      ${metadata}
      ${guard(`@sf_marker=1 AND @sf_history='${layout}' AND CAST(@sf_rows AS JSON)=${jsonValue(expected)}`)}
      DROP TABLE \`${marker}\`;`, target.name, { timeout: 135000 });
  } catch (error) {
    await scope.cancel(application).catch(() => {});
    if (error.name === 'AbortError') throw error;
    const after = await readState(writer, target, metadata).catch(() => undefined);
    return respond(!after || after.interrupted ? 'recovery-required' : 'apply-failed', fields);
  }
  try {
    await scope.verify();
    const after = await readState(writer, target, metadata);
    if (after.interrupted || after.uuid !== state.uuid || after.history !== layout || JSON.stringify(after.rows) !== JSON.stringify(expected)) {
      return respond('apply-unverified', fields);
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return respond('apply-unverified', fields);
  }
  for (const file of pending) applied.add(file);
  return respond('applied', { ...fields, migrations: files.map(entries) });
}
