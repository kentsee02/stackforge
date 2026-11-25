const identifier = '(?:"[a-z_][\\w]*"|`[a-z_][\\w]*`|[a-z_][\\w]*)';
const indexed = (pattern, flags = 'i') => new RegExp(pattern.replaceAll('@', '(' + identifier + ')'), flags);
const start = indexed('^CREATE\\s+TABLE\\s+@\\s*\\([\\s\\S]+\\)\\s*;$');
const copy = indexed('^INSERT\\s+INTO\\s+@\\s*\\(([^()]+)\\)\\s*SELECT\\s+([^()]+?)\\s+FROM\\s+@\\s*;$');
const drop = indexed('^DROP\\s+TABLE\\s+@\\s*;$');
const rename = indexed('^ALTER\\s+TABLE\\s+@\\s+RENAME\\s+TO\\s+@\\s*;$');
const index = indexed('^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+@\\s+ON\\s+@\\s*\\([\\s\\S]+\\)\\s*;$');
const columnName = new RegExp('^' + identifier + '$', 'i');
const name = token => token?.replace(/["`]/g, '').toLowerCase();
const off = /^PRAGMA\s+foreign_keys\s*=\s*OFF\s*;$/i;
const on = /^PRAGMA\s+foreign_keys\s*=\s*ON\s*;$/i;

export const hasSqliteForeignKeyControl = sql => /\bPRAGMA\s+foreign_keys\s*=/i.test(sql);

export function drizzleSqliteRebuild(sql) {
  const statements = sql.split(/-->[ \t]+statement-breakpoint[ \t]*(?:\r?\n|$)/).map(item => item.trim()).filter(Boolean);
  const disabledAt = statements.findIndex(item => off.test(item));
  const enabledAt = statements.findIndex(item => on.test(item));
  if (statements.filter(item => off.test(item)).length !== 1 || statements.filter(item => on.test(item)).length !== 1 ||
      disabledAt >= enabledAt) return;
  const operations = [];
  let rebuilds = 0;
  const columns = list => {
    const result = list.split(',').map(part => part.trim());
    return result.every(item => columnName.test(item)) && result.map(name).join(',');
  };
  for (let cursor = 0; cursor < statements.length; cursor++) {
    const statement = statements[cursor];
    if (off.test(statement) || on.test(statement)) continue;
    const table = name(start.exec(statement)?.[1]);
    if (!table?.startsWith('__new_')) {
      const renamesTable = rename.test(statement);
      if (!table && !renamesTable && !index.test(statement)) return;
      operations.push({ sql: statement, renamesTable });
      continue;
    }
    const copied = copy.exec(statements[cursor + 1] ?? '');
    const removed = drop.exec(statements[cursor + 2] ?? '');
    const renamed = rename.exec(statements[cursor + 3] ?? '');
    const original = name(copied?.[4]);
    const fields = copied && columns(copied[2]);
    if (cursor <= disabledAt || cursor + 3 >= enabledAt || !fields || fields !== columns(copied[3]) ||
        name(copied[1]) !== table || '__new_' + original !== table ||
        name(removed?.[1]) !== original || name(renamed?.[1]) !== table || name(renamed?.[2]) !== original) return;
    operations.push({ sql: statement }, { sql: statements[cursor + 1] },
      { sql: statements[cursor + 2], count: [original, table] }, { sql: statements[cursor + 3], renamesTable: true });
    cursor += 3;
    rebuilds++;
  }
  if (rebuilds) return operations;
}
