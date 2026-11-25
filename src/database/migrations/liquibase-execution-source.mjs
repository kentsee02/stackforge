import { liquibaseXmlAttributes, liquibaseXmlTokens, parseLiquibaseChangelog } from './liquibase-changelog.mjs';

const elements = new Set([
  'databaseChangeLog', 'include', 'includeAll', 'changeSet', 'changes', 'rollback', 'comment', 'tagDatabase',
  'createTable', 'dropTable', 'renameTable', 'addColumn', 'dropColumn', 'renameColumn', 'modifyDataType',
  'addNotNullConstraint', 'dropNotNullConstraint', 'addDefaultValue', 'dropDefaultValue',
  'createIndex', 'dropIndex', 'addUniqueConstraint', 'dropUniqueConstraint', 'addPrimaryKey', 'dropPrimaryKey',
  'addForeignKeyConstraint', 'dropForeignKeyConstraint', 'createSequence', 'dropSequence', 'alterSequence',
  'createView', 'dropView', 'renameView',
  'column', 'columns', 'constraints', 'insert', 'update', 'delete', 'where', 'sql', 'sqlFile', 'loadData', 'loadUpdateData'
]);
const simpleFields = new Set([
  'id', 'author', 'tag', 'keepTagOnRollback', 'file', 'path', 'relativeToChangelogFile', 'errorIfMissing', 'errorIfMissingOrEmpty',
  'endsWithFilter', 'minDepth', 'maxDepth', 'tableName', 'oldTableName', 'newTableName', 'schemaName',
  'columnName', 'oldColumnName', 'newColumnName', 'newDataType', 'columnDataType', 'indexName', 'constraintName',
  'viewName', 'oldViewName', 'newViewName', 'replaceIfExists', 'selectQuery',
  'sequenceName', 'name', 'type', 'unique', 'nullable', 'primaryKey', 'primaryKeyName', 'uniqueConstraintName', 'autoIncrement',
  'columnNames', 'baseTableName', 'baseColumnNames', 'baseTableSchemaName', 'referencedTableName',
  'referencedColumnNames', 'referencedTableSchemaName', 'onDelete', 'onUpdate', 'deferrable', 'initiallyDeferred',
  'value', 'valueNumeric', 'valueBoolean', 'valueDate', 'valueComputed',
  'defaultValue', 'defaultValueNumeric', 'defaultValueBoolean', 'defaultValueDate', 'defaultValueComputed',
  'defaultNullValue', 'remarks', 'cascadeConstraints', 'incrementBy', 'startValue', 'minValue', 'maxValue', 'cycle', 'cacheSize',
  'splitStatements', 'stripComments', 'endDelimiter', 'encoding', 'separator', 'quotchar',
  'context', 'contexts', 'contextFilter', 'labels', 'dbms',
  'commentLineStartsWith', 'header', 'index', 'usePreparedStatements', 'onlyUpdate'
]);

const dbNamespace = 'http://www.liquibase.org/xml/ns/dbchangelog';
const schemaLocation = /^https?:\/\/www\.liquibase\.org\/xml\/ns\/dbchangelog\s+https?:\/\/www\.liquibase\.org\/xml\/ns\/dbchangelog\/dbchangelog-[\w.-]+\.xsd$/;
const includePath = /^(?:[A-Za-z0-9_-][\w.-]*\/)*[A-Za-z0-9_-][\w.-]*\/?$/;
const validKey = key => elements.has(key) || simpleFields.has(key);
const resourceField = { sqlFile: 'path', loadData: 'file', loadUpdateData: 'file' };
const xmlPreconditions = new Set(['preConditions', 'and', 'or', 'not', 'dbms', 'tableExists', 'columnExists', 'primaryKeyExists', 'indexExists',
  'sequenceExists', 'viewExists']);

function collectResource(name, fields, resources) {
  if (!Object.hasOwn(resourceField, name)) return true;
  const key = resourceField[name];
  const path = fields?.[key];
  const relative = fields?.relativeToChangelogFile;
  const encoding = fields?.encoding;
  if (typeof path !== 'string' || !includePath.test(path) ||
      !(name === 'sqlFile' ? /\.sql$/i : /\.csv$/i).test(path) ||
      relative !== undefined && ![true, false, 'true', 'false'].includes(relative) ||
      encoding !== undefined && !/^utf-?8$/i.test(encoding)) return false;
  resources.push({ path, relative: relative === true || relative === 'true' });
  return true;
}

function reviewedXml(text, resources) {
  const expandedMarkers = text.replace(/&#(?:0*36|x0*24);/gi, '$').replace(/&#(?:0*123|x0*7b);/gi, '{');
  if (/\$\{/.test(expandedMarkers)) return false;
  for (const [token] of text.matchAll(liquibaseXmlTokens)) {
    if (token.startsWith('<?') && !/^<\?xml\s[^?]*\?>$/.test(token)) return false;
    const tag = /^<([A-Za-z_][\w:.-]*)([\s\S]*)>$/.exec(token);
    if (!tag) continue;
    const [, name, rest] = tag;
    if (!elements.has(name) && !xmlPreconditions.has(name)) return false;
    const attributes = liquibaseXmlAttributes(rest.replace(/\/$/, ''), true);
    if (!attributes) return false;
    if (name === 'preConditions' && (attributes.onSqlOutput !== 'TEST' ||
        [attributes.onFail, attributes.onError].some(value => value !== undefined && value !== 'HALT'))) return false;
    if (!collectResource(name, attributes, resources)) return false;
    for (const [key, value] of Object.entries(attributes)) {
      if (name === 'databaseChangeLog' && (key === 'xmlns' && value === dbNamespace ||
          key === 'xmlns:xsi' && value === 'http://www.w3.org/2001/XMLSchema-instance' ||
          key === 'xsi:schemaLocation' && schemaLocation.test(value))) continue;
      if (!simpleFields.has(key) && !(name === 'preConditions' && ['onSqlOutput', 'onFail', 'onError'].includes(key))) return false;
    }
  }
  return true;
}

function reviewedYaml(text, resources) {
  let resource;
  for (const line of text.split(/\r?\n/)) {
    if (/^ *(?:#.*|--- *)?$/.test(line)) continue;
    const entry = /^( *)(- +)?([A-Za-z][\w]*):(?: *(.*))?$/.exec(line);
    if (!entry || !validKey(entry[3])) return false;
    const [, spaces, marker, key, raw] = entry;
    const indent = spaces.length + (marker?.length ?? 0);
    const value = (raw ?? '').trim();
    if (/^[*&!>{[|%@]|^<<|[\t\x00-\x08]/.test(value)) return false;
    if (/^["']/.test(value) && !/^(?:'[^']*'|"[^"\\]*")(?: +#.*)?$/.test(value)) return false;
    if (resource && indent <= resource.indent) {
      if (!collectResource(resource.key, resource.fields, resources)) return false;
      resource = undefined;
    }
    if (Object.hasOwn(resourceField, key)) {
      if (resource || value && !value.startsWith('#')) return false;
      resource = { key, indent, fields: Object.create(null), fieldIndent: undefined };
    } else if (resource) {
      resource.fieldIndent ??= indent;
      if (!marker && indent === resource.fieldIndent && [resourceField[resource.key], 'relativeToChangelogFile', 'encoding'].includes(key)) {
        if (Object.hasOwn(resource.fields, key)) return false;
        resource.fields[key] = value.replace(/[ \t]+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2').trim();
      }
    }
  }
  return !resource || collectResource(resource.key, resource.fields, resources);
}

function reviewedJson(value, resources, depth = 0) {
  if (depth > 24) return false;
  if (typeof value === 'string') return !/\$\{/.test(value);
  if (Array.isArray(value)) return value.every(item => reviewedJson(item, resources, depth + 1));
  if (value && typeof value === 'object') return Object.entries(value).every(([name, item]) =>
    validKey(name) && collectResource(name, item, resources) && reviewedJson(item, resources, depth + 1));
  return true;
}

function uniqueJsonKeys(text) {
  const scopes = [];
  for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g)) {
    const [value] = token;
    if (value === '{' || value === '[') scopes.push(value === '{' ? new Set() : null);
    else if (value === '}' || value === ']') scopes.pop();
    else if (/^\s*:/.test(text.slice(token.index + value.length))) {
      const keys = scopes.at(-1);
      const name = JSON.parse(value);
      if (!keys || keys.has(name)) return false;
      keys.add(name);
    }
  }
  return true;
}

export function reviewedStructuredLiquibase(path, contents, resources = []) {
  const text = contents.replace(/^\uFEFF/, '');
  const declaration = parseLiquibaseChangelog(path, text);
  if (!declaration || declaration.partial || /\$\{|\u0000/.test(text) || declaration.logicalFilePath) return false;
  for (const { name, attributes } of declaration.entries) {
    if (attributes.logicalFilePath || attributes.ignore !== undefined ||
        (name !== 'changeSet' && !includePath.test(attributes[name === 'include' ? 'file' : 'path'] ?? ''))) return false;
  }
  if (/\.xml$/i.test(path)) return reviewedXml(text, resources);
  if (/\.ya?ml$/i.test(path)) return reviewedYaml(text, resources);
  if (/\.json$/i.test(path)) return uniqueJsonKeys(text) && reviewedJson(JSON.parse(text), resources);
  return false;
}
