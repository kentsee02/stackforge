import { liquibaseXmlAttributes, liquibaseXmlTokens, parseLiquibaseChangelog } from './liquibase-changelog.mjs';

const elements = new Set([
  'databaseChangeLog', 'include', 'includeAll', 'changeSet', 'changes', 'rollback', 'comment', 'tagDatabase',
  'createTable', 'dropTable', 'renameTable', 'addColumn', 'dropColumn', 'renameColumn', 'modifyDataType',
  'addNotNullConstraint', 'dropNotNullConstraint', 'addDefaultValue', 'dropDefaultValue',
  'createIndex', 'dropIndex', 'addUniqueConstraint', 'dropUniqueConstraint', 'addPrimaryKey', 'dropPrimaryKey',
  'addForeignKeyConstraint', 'dropForeignKeyConstraint', 'createSequence', 'dropSequence', 'alterSequence',
  'createView', 'dropView', 'renameView',
  'column', 'columns', 'constraints', 'insert', 'update', 'delete', 'where', 'sql'
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
  'splitStatements', 'stripComments', 'endDelimiter'
]);

const dbNamespace = 'http://www.liquibase.org/xml/ns/dbchangelog';
const schemaLocation = /^https?:\/\/www\.liquibase\.org\/xml\/ns\/dbchangelog\s+https?:\/\/www\.liquibase\.org\/xml\/ns\/dbchangelog\/dbchangelog-[\w.-]+\.xsd$/;
const includePath = /^(?:[A-Za-z0-9_-][\w.-]*\/)*[A-Za-z0-9_-][\w.-]*\/?$/;
const validKey = key => elements.has(key) || simpleFields.has(key);

function reviewedXml(text) {
  const expandedMarkers = text.replace(/&#(?:0*36|x0*24);/gi, '$').replace(/&#(?:0*123|x0*7b);/gi, '{');
  if (/\$\{/.test(expandedMarkers)) return false;
  for (const [token] of text.matchAll(liquibaseXmlTokens)) {
    if (token.startsWith('<?') && !/^<\?xml\s[^?]*\?>$/.test(token)) return false;
    const tag = /^<([A-Za-z_][\w:.-]*)([\s\S]*)>$/.exec(token);
    if (!tag) continue;
    const [, name, rest] = tag;
    if (!elements.has(name)) return false;
    const attributes = liquibaseXmlAttributes(rest.replace(/\/$/, ''), true);
    if (!attributes) return false;
    for (const [key, value] of Object.entries(attributes)) {
      if (name === 'databaseChangeLog' && (key === 'xmlns' && value === dbNamespace ||
          key === 'xmlns:xsi' && value === 'http://www.w3.org/2001/XMLSchema-instance' ||
          key === 'xsi:schemaLocation' && schemaLocation.test(value))) continue;
      if (!simpleFields.has(key)) return false;
    }
  }
  return true;
}

function reviewedYaml(text) {
  for (const line of text.split(/\r?\n/)) {
    if (/^ *(?:#.*|--- *)?$/.test(line)) continue;
    const entry = /^ *(?:- +)?([A-Za-z][\w]*):(?: *(.*))?$/.exec(line);
    if (!entry || !validKey(entry[1])) return false;
    const value = (entry[2] ?? '').trim();
    if (/^[*&!>{[|%@]|^<<|[\t\x00-\x08]/.test(value)) return false;
    if (/^["']/.test(value) && !/^(?:'[^']*'|"[^"\\]*")(?: +#.*)?$/.test(value)) return false;
  }
  return true;
}

function reviewedJson(value, depth = 0) {
  if (depth > 24) return false;
  if (typeof value === 'string') return !/\$\{/.test(value);
  if (Array.isArray(value)) return value.every(item => reviewedJson(item, depth + 1));
  if (value && typeof value === 'object') return Object.entries(value).every(([name, item]) =>
    validKey(name) && reviewedJson(item, depth + 1));
  return true;
}

export function reviewedStructuredLiquibase(path, contents) {
  const text = contents.replace(/^\uFEFF/, '');
  const declaration = parseLiquibaseChangelog(path, text);
  if (!declaration || declaration.partial || /\$\{|\u0000/.test(text) || declaration.logicalFilePath) return false;
  for (const { name, attributes } of declaration.entries) {
    if (attributes.logicalFilePath || attributes.ignore !== undefined ||
        (name !== 'changeSet' && !includePath.test(attributes[name === 'include' ? 'file' : 'path'] ?? ''))) return false;
  }
  if (/\.xml$/i.test(path)) return reviewedXml(text);
  if (/\.ya?ml$/i.test(path)) return reviewedYaml(text);
  if (/\.json$/i.test(path)) return reviewedJson(JSON.parse(text));
  return false;
}
