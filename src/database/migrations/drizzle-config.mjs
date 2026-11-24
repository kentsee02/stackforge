const names = /^drizzle\.config\.(?:ts|js|mts|mjs|cts|cjs)$/;
const identifier = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const variableName = /^[A-Z_][A-Z0-9_]{0,127}$/;
const envReference = Symbol('environment variable');

function staticObject(source) {
  const pattern = /\s+|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[a-zA-Z_$][\w$]*|-?\d+(?:\.\d+)?|[{}\[\],.:!]/gy;
  const tokens = [];
  while (pattern.lastIndex < source.length) {
    const token = pattern.exec(source)?.[0];
    if (!token || tokens.length >= 1200) return;
    if (token.trim()) tokens.push(token);
  }
  let offset = 0;
  const literal = token => /^['"]/.test(token ?? '') && !token.includes('\\') ? token.slice(1, -1) : undefined;
  function take(token) {
    if (tokens[offset] !== token) return false;
    offset++;
    return true;
  }
  function read(depth = 0) {
    if (depth > 10 || offset >= tokens.length) throw new Error();
    if (take('{')) {
      const record = Object.create(null);
      while (!take('}')) {
        const token = tokens[offset++];
        const key = literal(token) ?? (/^[a-zA-Z_$][\w$]*$/.test(token ?? '') ? token : undefined);
        if (!key || key === '__proto__' || Object.hasOwn(record, key) || !take(':')) throw new Error();
        record[key] = read(depth + 1);
        if (!take(',')) {
          if (!take('}')) throw new Error();
          break;
        }
      }
      return record;
    }
    if (take('[')) {
      const values = [];
      while (!take(']')) {
        values.push(read(depth + 1));
        if (!take(',')) {
          if (!take(']')) throw new Error();
          break;
        }
      }
      return values;
    }
    if (take('process')) {
      if (!take('.') || !take('env') || !take('.') || !variableName.test(tokens[offset] ?? '')) throw new Error();
      const variable = tokens[offset++];
      take('!');
      return { [envReference]: variable };
    }
    const token = tokens[offset++];
    const text = literal(token);
    if (text !== undefined) return text;
    if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
    if (token === 'true' || token === 'false' || token === 'null') return JSON.parse(token);
    throw new Error();
  }
  try {
    const object = read();
    if (offset === tokens.length) return object;
  } catch { /* Custom or ambiguous JavaScript stays unsupported. */ }
}

export async function drizzleConfig(folder, files, readText) {
  const configs = files.filter(file => names.test(file));
  if (configs.length !== 1) return;
  const [file] = configs;
  const text = (await readText(folder, file)).replace(/^\uFEFF/, '');
  if (text.length > 16384) return;
  const source = text.replace(/("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (_, string) => string ?? ' ')
    .replace(/^(?:\s*import\s+(?:(?:type\s+)?\{\s*(?:defineConfig|Config)\s*\}\s*from\s*['"]drizzle-kit['"]|['"]dotenv\/config['"])\s*;?)+/, '')
    .trim();
  const match = /^export\s+default\s+(?:defineConfig\s*\(\s*(\{[\s\S]*\})\s*\)|(\{[\s\S]*\})(?:\s+satisfies\s+Config)?)\s*;?$/.exec(source);
  if (!match) return;
  const config = staticObject(match[1] ?? match[2]);
  const credential = config?.dbCredentials;
  const variable = credential?.url?.[envReference];
  const sqlite = config?.dialect === 'sqlite';
  const sqliteFile = sqlite && typeof credential?.url === 'string' ? credential.url : undefined;
  if (!['postgresql', 'mysql', 'sqlite'].includes(config?.dialect) || Object.hasOwn(config, 'driver')) return;
  if (credential === undefined ? !sqlite : !credential || Object.keys(credential).length !== 1 || (!variable && sqliteFile === undefined)) return;
  const out = config.out === undefined ? 'drizzle' : typeof config.out === 'string' && config.out.replace(/^\.\//, '').replace(/\/$/, '');
  if (!out || out.length > 160 || out.split('/').some(part => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part))) return;
  const history = config.migrations;
  if (history !== undefined && (!history || Object.getPrototypeOf(history) !== null ||
      Object.keys(history).some(key => !['schema', 'table'].includes(key)))) return;
  if (config.dialect !== 'postgresql' && history?.schema !== undefined) return;
  const historySchema = history?.schema ?? 'drizzle';
  const historyTable = history?.table ?? '__drizzle_migrations';
  if (typeof historySchema !== 'string' || typeof historyTable !== 'string' ||
      !identifier.test(historySchema) || !identifier.test(historyTable)) return;
  return { file, variable, out, historySchema, historyTable,
    ...(config.dialect !== 'postgresql' && { engine: config.dialect }), ...(sqliteFile !== undefined && { sqliteFile }) };
}
