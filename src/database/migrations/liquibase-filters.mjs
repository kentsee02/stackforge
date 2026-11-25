export const invalidFilters = 'Enter valid Liquibase context and label filters and literal property values.';

export function liquibaseFilters(payload) {
  const filter = value => {
    if (value === undefined) return;
    if (typeof value !== 'string' || value.length > 256 || !/^[\w .@!(),-]+$/.test(value) ||
        !value.trim()) throw new Error(invalidFilters);
    return value.trim();
  };
  const context = filter(payload.contextFilter);
  const labels = filter(payload.labelFilter);
  const raw = payload.liquibaseProperties;
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > 24)) throw new Error(invalidFilters);
  const properties = new Map();
  for (const item of raw ?? []) {
    if (typeof item !== 'string' || item.length > 195) throw new Error(invalidFilters);
    const match = /^([a-zA-Z_][\w.-]{0,63})=([a-zA-Z0-9_][\w.-]{0,127})$/.exec(item);
    if (!match || properties.has(match[1])) throw new Error(invalidFilters);
    properties.set(match[1], match[2]);
  }
  const args = [...(context ? ['--context-filter=' + context] : []), ...(labels ? ['--label-filter=' + labels] : [])];
  return { active: Boolean(args.length || properties.size), context, labels, properties, args };
}

export function applyLiquibaseProperties(path, text, properties) {
  if (!/\$\{/.test(text) || !properties.size || !/\.xml$/i.test(path)) return text;
  // Expand literal values only in supported scalar attributes, before staging and resource validation.
  return text.replace(/(\s(?:tableName|columnName|sequenceName|indexName|schemaName|value|valueNumeric|defaultValue)\s*=\s*)(['"])([^'"]*)\2/g,
    (_, prefix, quote, value) => prefix + quote + value.replace(/\$\{([a-zA-Z_][\w.-]{0,63})\}/g,
      (token, key) => properties.get(key) ?? token) + quote);
}

export const liquibaseIdentity = (item, folder) => [item.file.slice(folder.length), item.id, item.author].join('::');

export function generatedLiquibaseChanges(output, candidates, folder, historyTable, rollback = false) {
  if (Buffer.byteLength(output) > 256 * 1024) throw new Error();
  const marker = rollback ? /^--[ \t]+Rolling Back ChangeSet:[ \t]+([^\r\n]+)/gm : /^--[ \t]+Changeset[ \t]+([^\r\n]+)/gmi;
  const headers = [...output.matchAll(marker)];
  const available = new Map(candidates.map((item, index) => [liquibaseIdentity(item, folder), { item, index }]));
  let previous = -1;
  const range = headers.map(row => {
    const match = available.get(row[1].trim());
    if (!match || match.index <= previous) throw new Error();
    previous = match.index;
    return match.item;
  });
  const ledger = new Set([historyTable.toLowerCase(), 'databasechangeloglock']);
  const sql = headers.map((row, index) => output.slice(row.index, headers[index + 1]?.index)
    .split(/\r?\n/).filter(line => {
      const relation = /^(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+([^\s(;]+)/i.exec(line.trim())?.[1];
      const table = relation?.split('.').at(-1).replace(/["`]/g, '').toLowerCase();
      return !ledger.has(table) && !/^--\s*Release Database Lock/.test(line);
    }).join('\n').trim()).join('\n\n');
  return { range, sql };
}
