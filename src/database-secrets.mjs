const hidden = '[redacted]';
const secretKey = /(?:PASSWORD|PASSWD|_PWD|SECRET|TOKEN|DATABASE_URL|CONNECTION_STRING)/i;
const databaseUrl = /(?:jdbc:)?\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|mssql|sqlserver):\/\/[^\s"'<>]+/gi;
const assignment = /(\b[\w.]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|DATABASE_URL|CONNECTION_STRING)[\w.]*\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;,]+)/gi;

export function databaseRedactor(environment) {
  const values = new Set();
  let literals;
  const add = variables => {
    for (const [key, value] of Object.entries(variables ?? {})) {
      if (!secretKey.test(key) || /_FILE$/i.test(key) || typeof value !== 'string' || !value) continue;
      values.add(value);
      for (const line of value.split(/\r?\n/)) if (line) values.add(line);
      try {
        values.add(encodeURIComponent(value));
        const url = new URL(value.replace(/^jdbc:/i, ''));
        if (url.password) {
          values.add(url.password);
          values.add(decodeURIComponent(url.password));
        }
      } catch { /* plain passwords and malformed URLs still match literally */ }
    }
    literals = undefined;
  };
  add(environment);
  return { add, text(value) {
    if (!literals && values.size) {
      const patterns = [...values].sort((a, b) => b.length - a.length).map(value => {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return value.length < 4 ? `(?<![\\w])${escaped}(?![\\w])` : escaped;
      });
      literals = new RegExp(patterns.join('|'), 'g');
    }
    const masked = literals ? value.replace(literals, hidden) : value;
    return masked.replace(databaseUrl, hidden).replace(assignment, (_, prefix) => prefix + hidden);
  } };
}
