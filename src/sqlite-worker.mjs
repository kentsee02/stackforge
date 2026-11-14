import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const [, , action, file, destination] = process.argv;
let database;
try {
  database = new DatabaseSync(file, { readOnly: action !== 'create', allowExtension: false });
  database.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1500;');
  if (action === 'create') database.exec('PRAGMA user_version=0;');
  if (action === 'snapshot') database.prepare('VACUUM INTO ?').run(destination);
  if (action === 'inspect' || action === 'verify') {
    if (action === 'verify' && database.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') throw new Error();
    const objects = [];
    let count = 0;
    const hash = createHash('sha256');
    for (const item of database.prepare(`SELECT type, name, tbl_name AS parent, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite!_%' ESCAPE '!' ORDER BY type, name`).iterate()) {
      hash.update(JSON.stringify(item) + '\n');
      if (count++ < 256) objects.push({ type: item.type, name: item.name, parent: item.parent });
    }
    const version = database.prepare('SELECT sqlite_version() AS version').get().version;
    const pages = database.prepare('PRAGMA page_count').get().page_count;
    const bytes = database.prepare('PRAGMA page_size').get().page_size * pages;
    process.stdout.write(JSON.stringify({ version, objects, count, digest: hash.digest('hex'), limited: count > objects.length, bytes }));
  }
} catch (error) {
  process.stderr.write(/locked|busy/i.test(error.message) ? 'SQLITE_BUSY' : 'SQLITE_INVALID');
  process.exitCode = 1;
} finally { database?.close(); }
