// Recognize transactional statements emitted by Drizzle. The original file is
// still used for the Drizzle hash.
const token = /\s+|--[^\r\n]*|\$([a-zA-Z_][a-zA-Z_0-9]*|)\$[^]*?\$\1\$|"(?:[^"]|"")*"|'(?:[^']|'')*'|[a-zA-Z_][\w$]*|\d+(?:\.\d+)?|[;()[\],.=:+*/<>-]/gy;
const name = '(?:identifier|[a-z_][a-z_0-9$]*)(?: \\. (?:identifier|[a-z_][a-z_0-9$]*))?';
const shapes = [
  new RegExp('^create table (?:if not exists )?' + name + ' \\('),
  new RegExp('^create (?:unique )?index (?:if not exists )?' + name + ' on (?:only )?' + name + ' (?:using [a-z_]+ )?\\('),
  new RegExp('^create type ' + name + ' as enum \\('),
  new RegExp('^create schema (?:if not exists )?' + name + '$'),
  new RegExp('^alter table (?:if exists )?(?:only )?' + name + ' add (?:column |constraint )')
];
const disallowed = /\b(?:drop|truncate|copy|execute|call|grant|revoke|concurrently|replace|attach|detach|disable|enable|owner|vacuum)\b/;
const expandedDisallowed = /\b(?:truncate|copy|execute|call|grant|revoke|concurrently|attach|detach|disable|enable|owner|vacuum)\b/;
const expandedShapes = [
  new RegExp('^alter table (?:if exists )?(?:only )?' + name + ' (?:drop (?:column|constraint)|alter column|rename (?:column|constraint|to)) '),
  new RegExp('^drop (?:table|index|view|sequence|type|schema) (?:if exists )?' + name + '(?: (?:cascade|restrict))?$'),
  new RegExp('^alter type ' + name + ' (?:add value|rename (?:value|to)) '),
  new RegExp('^create (?:or replace )?view ' + name + ' as select '),
  new RegExp('^create sequence (?:if not exists )?' + name + '(?: |$)'),
  new RegExp('^alter (?:view|index|sequence) ' + name + ' rename to ' + name + '$'),
  new RegExp('^insert into ' + name + ' (?:\\(|values )'),
  new RegExp('^update ' + name + ' set '),
  new RegExp('^delete from ' + name + '(?: where |$)')
];

function supported(words, expanded) {
  const shape = words.join(' ');
  if (words.includes('dollar-string') || /\be string\b/.test(shape)) return false;
  if (expanded && !expandedDisallowed.test(shape) && expandedShapes.some(pattern => pattern.test(shape))) {
    return !shape.startsWith('alter table ') || !words.includes('top-level comma');
  }
  if (!shapes.some(pattern => pattern.test(shape)) || disallowed.test(shape)) return false;
  if (/\b(?:insert|delete|update)\b/.test(shape.replace(/\bon (?:delete|update)\b/g, ''))) return false;
  if (shape.startsWith('create table ') && words.includes('top-level as')) return false;
  return !shape.startsWith('alter table ') || !words.includes('top-level comma');
}

export function drizzleStatements(sql, { expanded = false, allowWrapper = true } = {}) {
  const scanner = new RegExp(token);
  const statements = [];
  let words = [], body, start = 0, depth = 0;
  function finish(end) {
    if (words.length) {
      // Earlier Drizzle versions wrap additive foreign keys in this exact
      // duplicate-object handler. Review the inner statement as well.
      const wrapper = allowWrapper && words.join(' ') === 'do dollar-string' &&
        /^\s*begin\s+(alter\s+table\b[^]+?;)\s*exception\s+when\s+duplicate_object\s+then\s+null;\s*end\s*;?\s*$/i.exec(body);
      if (wrapper ? drizzleStatements(wrapper[1], { allowWrapper: false })?.length !== 1 : !supported(words, expanded)) return false;
      statements.push(sql.slice(start, end).trim());
    }
    words = [];
    body = undefined;
    start = end + 1;
    return true;
  }
  while (scanner.lastIndex < sql.length) {
    if (sql.startsWith('/*', scanner.lastIndex)) {
      const comment = /\/\*|\*\//g;
      comment.lastIndex = scanner.lastIndex + 2;
      let nested = 1;
      while (nested) {
        const boundary = comment.exec(sql);
        if (!boundary) return;
        nested += boundary[0] === '/*' ? 1 : -1;
      }
      scanner.lastIndex = comment.lastIndex;
      continue;
    }
    const match = scanner.exec(sql);
    if (!match) return;
    const [text, delimiter] = match;
    if (!text.trim() || text.startsWith('--')) continue;
    if (text === ';') {
      if (depth || !finish(match.index)) return;
      continue;
    }
    if (delimiter !== undefined) {
      body = text.slice(delimiter.length + 2, -(delimiter.length + 2));
      words.push('dollar-string');
    } else if (text.startsWith('"')) words.push('identifier');
    else if (text.startsWith("'")) words.push('string');
    else {
      if (text === '(' || text === '[') depth++;
      if (text === ')' || text === ']') depth--;
      if (depth < 0) return;
      const word = text.toLowerCase();
      if (depth === 0 && word === ',') words.push('top-level comma');
      else if (depth === 0 && word === 'as' && words[1] === 'table') words.push('top-level as');
      else words.push(word);
    }
  }
  if (depth || !finish(sql.length) || !statements.length) return;
  return statements;
}
