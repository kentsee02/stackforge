import * as sqlite from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sqliteFileState } from '../adapters/sqlite-file.mjs';
import { drizzleSqliteRebuild } from './drizzle-sqlite-rebuild.mjs';

const supported = [
  'CREATE_INDEX', 'CREATE_TABLE', 'CREATE_TRIGGER', 'CREATE_VIEW', 'DELETE', 'DROP_INDEX', 'DROP_TABLE', 'DROP_TRIGGER',
  'DROP_VIEW', 'INSERT', 'READ', 'SELECT', 'UPDATE', 'ALTER_TABLE', 'REINDEX', 'ANALYZE', 'FUNCTION', 'RECURSIVE'
];
const allowed = new Set(supported.map(name => sqlite.constants?.['SQLITE_' + name]));
const invalid = () => new Error('SQLITE_DRIZZLE_CHANGED');

function history(db, table, named) {
  const schema = db.prepare("SELECT type FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE").get(table);
  const populated = Boolean(db.prepare(`SELECT 1 FROM main.sqlite_schema WHERE name <> ? COLLATE NOCASE
    AND name NOT LIKE 'sqlite!_%' ESCAPE '!' LIMIT 1`).get(table));
  const empty = layout => ({ layout, populated, rows: [] });
  if (!schema) return empty('absent');
  if (schema.type !== 'table' || db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=? COLLATE NOCASE").get(table)) {
    return empty('unsupported');
  }
  const columns = db.prepare("SELECT name, upper(type) AS type, pk, [notnull], hidden FROM pragma_table_xinfo(?, 'main')").all(table);
  const expectedTypes = { id: 'INTEGER', hash: 'TEXT', created_at: 'NUMERIC', name: 'TEXT', applied_at: 'TEXT' };
  if (![3, 5].includes(columns.length) || columns.some(({ name, type, pk, notnull, hidden }) =>
    !Object.hasOwn(expectedTypes, name) || type !== expectedTypes[name] || hidden || pk !== Number(name === 'id') ||
      name === 'hash' && !notnull) || !['id', 'hash', 'created_at', ...(columns.length === 5 ? ['name', 'applied_at'] : [])]
    .every(name => columns.some(column => column.name === name))) return empty('unsupported');
  const layout = columns.length === 5 ? 'v1' : 'legacy';
  if (named !== (layout === 'v1')) return empty(layout);
  const rows = db.prepare(`SELECT CAST(created_at AS TEXT) AS created, hash${named ? ', name' : ''}
    FROM main."${table}" ORDER BY id LIMIT 201`).all().map(row => Object.values(row));
  return { layout, populated, rows };
}

function migrate(db, table, named, pending, rebuild) {
  const constants = sqlite.constants;
  const relation = 'main."' + table + '"';
  const record = db.prepare(`INSERT INTO ${relation} (hash, created_at${named ? ', name, applied_at' : ''})
    VALUES (?, ?${named ? ', ?, ?' : ''})`);
  const ledger = table.toLowerCase();
  let renamesTable = false;
  const authorizer = (action, first, second, schema) => {
    const a = first?.toLowerCase();
    const b = second?.toLowerCase();
    const blocked = constants.SQLITE_DENY;
    const ok = constants.SQLITE_OK;
    // SQLite updates its own temp catalog while renaming tables, even on a fresh connection.
    if (renamesTable && schema === 'temp' && a === 'sqlite_temp_master' &&
        (action === constants.SQLITE_READ || action === constants.SQLITE_UPDATE)) return ok;
    if (schema && schema !== 'main' || a === ledger || action === constants.SQLITE_ALTER_TABLE && b === ledger) return blocked;
    if (action === constants.SQLITE_CREATE_VTABLE || action === constants.SQLITE_DROP_VTABLE) return b === 'fts5' ? ok : blocked;
    if (action === constants.SQLITE_PRAGMA) {
      if (a === 'data_version' && !b) return ok;
      return blocked;
    }
    if (action === constants.SQLITE_FUNCTION && ['load_extension', 'readfile', 'writefile', 'fts3_tokenizer'].includes(b)) return blocked;
    return allowed.has(action) ? ok : blocked;
  };
  for (const file of pending) {
    db.setAuthorizer(authorizer);
    try {
      if (rebuild) {
        for (const item of rebuild) {
          renamesTable = Boolean(item.renamesTable);
          if (item.count) {
            const count = name => db.prepare('SELECT count(*) AS total FROM main."' + name + '"').get().total;
            if (count(item.count[0]) !== count(item.count[1])) throw new Error('Rebuild changed the number of rows');
          }
          const statement = db.prepare(item.sql);
          if (statement.sourceSQL.trim() !== item.sql.trim()) throw new Error('Expected one rebuild statement');
          statement.run();
        }
      } else db.exec(file.sql);
    }
    finally { db.setAuthorizer(null); }
    record.run(file.hash, file.when, ...(named ? [file.tag, new Date().toISOString()] : []));
  }
}

const [, , action, file] = process.argv;
let db;
try {
  const { table, named, expected, pending, original, staged } = JSON.parse(readFileSync(0, 'utf8'));
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(table) || /^sqlite_/i.test(table)) throw invalid();
  const writing = action === 'apply';
  const canWrite = typeof sqlite.DatabaseSync.prototype.setAuthorizer === 'function';
  const checkFile = () => {
    const state = sqliteFileState(file);
    if (state.orphaned) throw invalid();
    return state;
  };
  const initial = checkFile();
  if (original && (initial.identity !== original.identity || initial.revision !== original.revision) ||
      !initial.main && !staged) throw invalid();
  if (writing && !canWrite) throw invalid();
  db = new sqlite.DatabaseSync(file, { readOnly: !writing, allowExtension: false, enableDoubleQuotedStringLiterals: true });
  db.enableDefensive?.(true);
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1500;');
  const rebuild = writing && pending.length === 1 && drizzleSqliteRebuild(pending[0].sql);
  if (writing) db.exec('PRAGMA foreign_keys=' + (rebuild ? 'OFF' : 'ON') + '; BEGIN IMMEDIATE;');
  else db.exec('BEGIN;');
  const current = checkFile();
  if (!staged && (current.identity !== initial.identity || current.revision !== initial.revision)) throw invalid();
  const state = history(db, table, named);
  if (writing) {
    if (JSON.stringify(state) !== JSON.stringify(expected)) throw invalid();
    if (state.layout === 'absent') db.exec(`CREATE TABLE main."${table}" (id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL, created_at NUMERIC${named ? ', name TEXT, applied_at TEXT' : ''});`);
    migrate(db, table, named, pending, rebuild);
    const expectedRows = [...state.rows, ...pending.map(item => [String(item.when), item.hash, ...(named ? [item.tag] : [])])];
    const after = history(db, table, named);
    if (db.prepare('PRAGMA main.foreign_key_check').get()) throw new Error('SQLITE_DRIZZLE_FOREIGN_KEYS');
    if (after.layout !== (named ? 'v1' : 'legacy') || JSON.stringify(after.rows) !== JSON.stringify(expectedRows) ||
        checkFile().identity !== current.identity) throw invalid();
  } else {
    const after = checkFile();
    if (after.identity !== current.identity || after.revision !== current.revision) throw invalid();
  }
  db.exec('COMMIT;');
  process.stdout.write(JSON.stringify({ state, canWrite }));
} catch (error) {
  const status = /locked|busy/i.test(error.message) ? 'SQLITE_DRIZZLE_LOCKED' :
    ['SQLITE_DRIZZLE_CHANGED', 'SQLITE_DRIZZLE_FOREIGN_KEYS'].includes(error.message) ? error.message :
      /authorization denied|not authorized|access to .* is prohibited/i.test(error.message) ? 'SQLITE_DRIZZLE_UNSUPPORTED' : 'SQLITE_DRIZZLE_FAILED';
  process.stderr.write(status);
  process.exitCode = 1;
} finally { db?.close(); }
