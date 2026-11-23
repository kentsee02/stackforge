const declarations = new Set(['changeSet', 'include', 'includeAll']);
const otherEntries = new Set(['property', 'preConditions', 'logicalFilePath']);
const fields = new Set(['id', 'author', 'file', 'path', 'logicalFilePath', 'relativeToChangelogFile',
  'ignore', 'errorIfMissing', 'errorIfMissingOrEmpty', 'minDepth', 'maxDepth', 'endsWithFilter', 'filter', 'resourceComparator']);

export const validLiquibaseTag = tag => typeof tag === 'string' && tag === tag.trim() && /^[^\x00-\x1f\x7f]{1,255}$/.test(tag);

export function liquibaseXmlAttributes(text, all = false) {
  const attributes = Object.create(null);
  const pattern = /\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
  while (text.slice(pattern.lastIndex).trim()) {
    const match = pattern.exec(text);
    if (!match || Object.hasOwn(attributes, match[1])) return;
    const [, key, double, single] = match;
    if (!all && !fields.has(key)) continue;
    const value = double ?? single;
    if (/&(?!amp;|quot;|apos;|lt;|gt;)/.test(value)) return;
    attributes[key] = value.replace(/&(amp|quot|apos|lt|gt);/g,
      (_, entity) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[entity]);
  }
  return attributes;
}

export const liquibaseXmlTokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/g;

function xmlChangelog(text) {
  const stack = [], entries = [];
  let offset = 0, root, partial = false;
  for (const token of text.matchAll(liquibaseXmlTokens)) {
    if (token.index !== offset) return;
    const value = token[0];
    offset += value.length;
    if (/^<(?:!--|[?]|!\[CDATA\[)/.test(value)) continue;
    if (!value.startsWith('<')) {
      if (!stack.length && value.trim()) return;
      continue;
    }
    const tag = /^<(\/?)([\w:.-]+)([\s\S]*?)>$/.exec(value);
    if (!tag) return;
    const [, closing, qualified, rest] = tag;
    const name = qualified.split(':').at(-1);
    if (closing) {
      if (rest.trim() || stack.pop() !== qualified) return;
      continue;
    }
    if (!stack.length || stack.length === 1 && declarations.has(name)) {
      const attributes = liquibaseXmlAttributes(rest.replace(/\/$/, ''));
      if (!stack.length) {
        if (root || name !== 'databaseChangeLog' || !attributes) return;
        root = attributes;
      } else if (attributes) entries.push({ name, attributes });
      else partial = true;
    } else if (stack.length === 1 && !otherEntries.has(name)) partial = true;
    if (!rest.endsWith('/')) stack.push(qualified);
  }
  if (root && offset === text.length && !stack.length) return { entries, logicalFilePath: root.logicalFilePath, partial };
}

function scalar(value) {
  const text = value.trim();
  const quoted = /^(["'])(.*?)\1(?:[ \t]+#.*)?$/.exec(text);
  if (quoted) return /["'\\]/.test(quoted[2]) ? undefined : quoted[2];
  const literal = text.replace(/[ \t]+#.*$/, '').trim();
  return literal && !/^[*&!>{[|'"]/.test(literal) ? literal : undefined;
}

function yamlChangelog(text) {
  const lines = text.split(/\r?\n/);
  const root = lines.findIndex(line => /^(?:databaseChangeLog|"databaseChangeLog"|'databaseChangeLog'):\s*(?:#.*)?$/.test(line));
  if (root < 0) return;
  if (lines.slice(0, root).some(line => !/^\s*(?:#.*|---\s*)?$/.test(line))) return;
  const result = { entries: [], partial: false };
  let indent, entry, fieldIndent;
  for (const line of lines.slice(root + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const item = /^( *)-[ \t]+([\w-]+):[ \t]*(.*)$/.exec(line);
    if (item && (indent === undefined || item[1].length === indent)) {
      indent ??= item[1].length;
      entry = undefined;
      fieldIndent = undefined;
      const [, , name, tail] = item;
      if (name === 'logicalFilePath') {
        if (result.logicalFilePath !== undefined) return;
        result.logicalFilePath = scalar(tail) ?? '';
      } else if (declarations.has(name) && /^(?:#.*)?$/.test(tail)) {
        entry = { name, attributes: Object.create(null) };
        result.entries.push(entry);
      } else if (!otherEntries.has(name)) result.partial = true;
      continue;
    }
    const key = /^( *)([\w-]+):[ \t]*(.*)$/.exec(line);
    if (entry && key && key[1].length > indent) {
      fieldIndent ??= key[1].length;
      if (key[1].length === fieldIndent && fields.has(key[2])) {
        if (Object.hasOwn(entry.attributes, key[2])) result.partial = true;
        entry.attributes[key[2]] = scalar(key[3]);
      }
    } else if (/^\S/.test(line) || indent === undefined || /^ *-[ \t]/.test(line) && line.search(/\S/) <= indent) {
      result.partial = true;
      entry = undefined;
    }
  }
  return result;
}

function jsonChangelog(text) {
  let document;
  try { document = JSON.parse(text); } catch { return; }
  if (!Array.isArray(document?.databaseChangeLog)) return;
  const result = { entries: [], partial: false };
  for (const item of document.databaseChangeLog) {
    const keys = item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : [];
    const [name] = keys;
    if (keys.length !== 1) { result.partial = true; continue; }
    if (name === 'logicalFilePath') {
      if (result.logicalFilePath !== undefined) return;
      result.logicalFilePath = item[name];
    } else if (declarations.has(name)) {
      const attributes = item[name];
      if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) result.entries.push({ name, attributes });
      else result.partial = true;
    } else if (!otherEntries.has(name)) result.partial = true;
  }
  return result;
}

function sqlChangelog(text) {
  if (!/^\s*--\s*liquibase formatted sql\b[^\r\n]*(?:\r?\n|$)/i.test(text)) return;
  const header = /^\s*--\s*liquibase formatted sql([^\r\n]*)/i.exec(text)[1].trim();
  const result = { entries: [], partial: Boolean(header) };
  for (const [, keyword, tail] of text.matchAll(/^[ \t]*--[ \t]*(changeset|includeAll|include)\b[ \t]*([^\r\n]*)/gmi)) {
    const match = keyword.toLowerCase() === 'changeset' && /^([^:\s]+):([^\s]+)(.*)$/.exec(tail);
    if (!match) { result.partial = true; continue; }
    const [, author, id, options] = match;
    const logical = /\blogicalFilePath:("[^"]+"|'[^']+'|\S+)/i.exec(options);
    result.entries.push({ name: 'changeSet', attributes: { author, id, ...(logical && { logicalFilePath: scalar(logical[1]) }) } });
  }
  return result;
}

export function parseLiquibaseChangelog(file, text) {
  const body = text.replace(/^\uFEFF/, '');
  if (/\.xml$/i.test(file)) return xmlChangelog(body);
  if (/\.ya?ml$/i.test(file)) return yamlChangelog(body);
  if (/\.json$/i.test(file)) return jsonChangelog(body);
  if (/\.sql$/i.test(file)) return sqlChangelog(body);
}
