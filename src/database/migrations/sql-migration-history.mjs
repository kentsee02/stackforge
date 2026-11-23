import { posix } from 'node:path';
import { versionKey } from './flyway-preview.mjs';
import { readLocalMigrationHistory } from './postgres-history.mjs';
import { postgresHistoryQuery } from './postgres-history-table.mjs';
import { mysqlHistoryQuery } from './mysql-history.mjs';
import { databaseKey } from '../discovery.mjs';

const maxRows = 1024;
const flywayColumns = { installed_rank: 'integer', version: 'text', script: 'text', type: 'text', checksum: 'integer', success: 'boolean' };
const liquibaseColumns = { id: 'text', author: 'text', filename: 'text', exectype: 'text' };
const bounded = name => `CASE WHEN length(${name}) <= 1024 THEN ${name} END`;

function flywayState({ migrations }, rows, checksums) {
  const byName = new Map(migrations.map(item => [posix.basename(item.file), item]));
  const recorded = new Map(), ranks = new Set();
  let conflict = false, unsupported = false;
  for (const [rank, version, file, type, checksum, success] of rows) {
    if (!Number.isInteger(rank) || ranks.has(rank) || (success !== true && success !== 1)) {
      conflict = true;
      continue;
    }
    ranks.add(rank);
    if (type === 'SCHEMA') continue;
    if (type !== 'SQL') {
      unsupported = true;
      continue;
    }
    const item = byName.get(file);
    if (!item || !['versioned', 'repeatable'].includes(item.kind) ||
        (item.kind === 'versioned' ? versionKey(item.version) !== versionKey(version) : version !== null) ||
        (item.kind === 'versioned' && recorded.has(file))) {
      conflict = true;
      continue;
    }
    if (!recorded.has(file) || rank > recorded.get(file).rank) recorded.set(file, { rank, checksum });
  }
  const items = migrations.map(item => {
    const file = posix.basename(item.file);
    const entry = recorded.get(file);
    if (!entry) return { state: unsupported || !['versioned', 'repeatable'].includes(item.kind) ? 'unverified' : 'pending' };
    const checksum = checksums.get(file);
    if (checksum === undefined || !Number.isInteger(entry.checksum)) return { state: 'recorded' };
    if (checksum !== entry.checksum) {
      if (item.kind === 'versioned') conflict = true;
      return { state: item.kind === 'repeatable' ? 'outdated' : 'changed' };
    }
    return { state: 'applied' };
  });
  return { items, conflict, unsupported };
}

function liquibaseState({ changes }, rows, resourcePrefix) {
  const key = (path, author, id) => JSON.stringify([path, author, id]);
  const paths = new Map();
  for (const [index, item] of changes.entries()) {
    const filename = item.logicalFilePath ?? item.file.slice(resourcePrefix.length);
    const identity = key(filename, item.author, item.id);
    paths.set(identity, paths.has(identity) ? undefined : index);
  }
  const items = changes.map(() => ({ state: 'pending' }));
  const seen = new Set();
  let conflict = false;
  for (const [id, author, file, execution] of rows) {
    const index = typeof file === 'string' && paths.get(key(file.replaceAll('\\', '/').replace(/^\.\//, ''), author, id));
    if (!Number.isInteger(index) || seen.has(index) || !['EXECUTED', 'RERAN', 'MARK_RAN'].includes(execution)) {
      conflict = true;
      continue;
    }
    seen.add(index);
    items[index] = { state: execution === 'MARK_RAN' ? 'marked' : 'recorded' };
  }
  return { items, conflict };
}

export async function compareSqlMigrationHistory({ adapter, preview, history, checksums, resourcePrefix, includeFingerprint, ...options }) {
  const flyway = adapter === 'flyway';
  const engine = options.selection.engine ?? 'postgres';
  const mysql = engine === 'mysql';
  const array = mysql ? 'JSON_ARRAY' : 'jsonb_build_array';
  const columns = flyway ? flywayColumns : liquibaseColumns;
  const row = flyway
    ? `${array}(installed_rank, ${bounded('version')}, ${bounded('script')}, ${bounded('type')}, checksum, ${mysql ? 'CAST(success AS UNSIGNED)' : 'success'})`
    : `${array}(${bounded('id')}, ${bounded('author')}, ${bounded('filename')}, ${bounded('exectype')})`;
  const query = (mysql ? mysqlHistoryQuery : postgresHistoryQuery)(history, columns, {
    maxRows, row, order: flyway ? 'ORDER BY installed_rank' : 'ORDER BY filename, author, id'
  });
  const { target, snapshot, status } = await readLocalMigrationHistory(options, query, engine);
  const respond = (status, fields) => ({ target, history, status, ...fields,
    ...(includeFingerprint && snapshot && { fingerprint: databaseKey(snapshot) }) });
  if (!snapshot) return respond(status);
  if (snapshot.table === 'absent') return respond('history-missing');
  if (snapshot.table !== 'readable' || !Array.isArray(snapshot.rows) || snapshot.rows.length > maxRows ||
      snapshot.rows.some(row => !Array.isArray(row) || row.length !== (flyway ? 6 : 4))) return respond('history-unavailable');
  const { items, conflict, unsupported } = flyway ? flywayState(preview, snapshot.rows, checksums) :
    liquibaseState(preview, snapshot.rows, resourcePrefix);
  return respond(conflict ? 'history-conflict' : unsupported ? 'history-partial' :
    items.some(item => ['pending', 'outdated'].includes(item.state)) ? 'pending' : 'recorded', { items });
}
