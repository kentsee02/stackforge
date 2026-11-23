const token = /\s+|--[^\r\n]*|\/\*|\$([A-Za-z_][A-Za-z0-9_]*|)\$[\s\S]*?\$\1\$|[eE]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|[a-zA-Z_][\w$]*|./gyu;
const transaction = /^(?:begin(?: work| transaction)?|start transaction|commit(?: work| transaction)?|end(?: work| transaction)?)$/;
const supported = /^(?:(?:create|alter|drop) (?:table|schema|type|sequence|index|view)|create (?:unique index|or replace view)|insert into|update|delete from|comment on|do body)\b/;

export function efPostgresStatements(sql) {
  const scanner = new RegExp(token);
  const statements = [];
  let words = [], start = 0;
  function finish(end) {
    const command = words.join(' ');
    if (command && !transaction.test(command)) {
      if (!supported.test(command)) return false;
      const statement = sql.slice(start, end).trim();
      if (!statement || statements.length >= 1024) return false;
      statements.push(statement);
    }
    words = [];
    start = end + 1;
    return true;
  }
  while (scanner.lastIndex < sql.length) {
    const match = scanner.exec(sql);
    if (!match) return;
    const [text, dollar] = match;
    if (!text.trim() || text.startsWith('--')) continue;
    if (text === '/*') {
      const markers = /\/\*|\*\//g;
      markers.lastIndex = scanner.lastIndex;
      let depth = 1;
      while (depth) {
        const boundary = markers.exec(sql);
        if (!boundary) return;
        depth += boundary[0] === '/*' ? 1 : -1;
      }
      scanner.lastIndex = markers.lastIndex;
      continue;
    }
    if (text === ';') {
      if (!finish(match.index)) return;
    } else {
      if (["'", '"', '\\', '\0'].includes(text)) return;
      if (words.length < 5) words.push(dollar !== undefined ? 'body' : /^[\w$]+$/.test(text) ? text.toLowerCase() : 'value');
    }
  }
  if (!finish(sql.length) || !statements.length) return;
  return statements;
}
