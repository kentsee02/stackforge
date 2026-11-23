import assert from 'node:assert/strict';
import test from 'node:test';
import { efPostgresStatements } from '../../src/database/migrations/ef-core-sql.mjs';

test('EF Core accepts PostgreSQL migration SQL and places it in one transaction', () => {
  const statement = "INSERT INTO notes (body) VALUES (E'quoted\\' character; end');";
  const block = "DO $EF$ BEGIN INSERT INTO notes VALUES ('value;'); END $EF$;";
  const sql = [
    'START TRANSACTION;',
    '/* outer; /* nested; */ */ CREATE TABLE notes (body text);',
    statement,
    block,
    'COMMIT;'
  ].join('\n');
  const steps = efPostgresStatements(sql);
  assert.equal(steps.length, 3);
  assert.match(steps[0], /CREATE TABLE notes/);
  assert.equal(steps[1], statement.slice(0, -1));
  assert.equal(steps[2], block.slice(0, -1));
});

test('EF Core rejects nontransactional commands, client directives, and incomplete SQL', () => {
  for (const sql of [
    'CREATE TABLE sample (id int); COMMIT AND CHAIN;',
    'CREATE TABLESPACE sample LOCATION \'/var/lib/temporary\';',
    'CREATE TABLE sample (id int);\n\\echo unexpected',
    'CREATE TABLE sample (id int); /* unfinished',
    "INSERT INTO notes VALUES ('unfinished);"
  ]) assert.equal(efPostgresStatements(sql), undefined);
});
