import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewedStructuredLiquibase } from '../../src/database/migrations/liquibase-execution-source.mjs';

test('Liquibase staged execution accepts declarative changes and local includes', () => {
  assert.equal(reviewedStructuredLiquibase('main.yaml', 'databaseChangeLog:\n  - includeAll:\n      path: migrations\n'), true);
  assert.equal(reviewedStructuredLiquibase('main.json', JSON.stringify({ databaseChangeLog: [{
    changeSet: { id: 'first', author: 'test', changes: [{ createTable: {
      tableName: 'items', columns: [{ column: { name: 'id', type: 'int', constraints: { nullable: false } } }]
    } }] }
  }] })), true);
  assert.equal(reviewedStructuredLiquibase('main.xml', '<databaseChangeLog><changeSet id="first" author="test">' +
    '<createTable tableName="items"><column name="id" type="int"/></createTable></changeSet></databaseChangeLog>'), true);
});

test('Liquibase staged execution rejects unresolved paths and runtime-dependent declarations', () => {
  for (const path of ['../outside', '/absolute/file.xml', 'classpath:external.xml', 'https://example.invalid/file.xml']) {
    assert.equal(reviewedStructuredLiquibase('main.yaml', 'databaseChangeLog:\n  - include:\n      file: ' + path), false);
  }
  for (const body of ['<customChange class="app.Change"/>', '<sqlFile path="reference.sql"/>',
    '<preConditions><sqlCheck expectedResult="1">SELECT 1</sqlCheck></preConditions>']) {
    assert.equal(reviewedStructuredLiquibase('main.xml', '<databaseChangeLog><changeSet id="first" author="test">' +
      body + '</changeSet></databaseChangeLog>'), false);
  }
  assert.equal(reviewedStructuredLiquibase('main.yaml', 'databaseChangeLog:\n  - include:\n      file: &alias migrations.xml'), false);
  assert.equal(reviewedStructuredLiquibase('main.json',
    '{"databaseChangeLog":[{"changeSet":{"id":"first","author":"test","runAlways":true}}]}'), false);
});

test('Liquibase staged execution rejects property expressions after XML and JSON decoding', () => {
  assert.equal(reviewedStructuredLiquibase('main.xml', '<databaseChangeLog><changeSet id="first" author="test">' +
    '<sql>SELECT \'&#x24;&#0123;RUNTIME_VALUE}\'</sql></changeSet></databaseChangeLog>'), false);
  assert.equal(reviewedStructuredLiquibase('main.json', '{"databaseChangeLog":[{"changeSet":{"id":"first","author":"test",' +
    '"changes":[{"sql":{"sql":"SELECT \'\\u0024\\u007bRUNTIME_VALUE}\'"}}]}}]}'), false);
});
