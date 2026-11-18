import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverDatabases } from '../../src/database/discovery.mjs';
import { drizzleConfig } from '../../src/database/migrations/drizzle-config.mjs';
import { previewDrizzle } from '../../src/database/migrations/drizzle-preview.mjs';
import { drizzleStatements } from '../../src/database/migrations/drizzle-sql.mjs';

const config = `import type { Config } from 'drizzle-kit';
export default {
  dialect: 'postgresql',
  schema: './lib/schema.ts',
  out: './lib/migrations',
  dbCredentials: { url: process.env.STACKFORGE_DRIZZLE_TEST_URL! }
} satisfies Config;`;

test('Drizzle execution recognizes schema additions and rejects other SQL batches', () => {
  const changes = `CREATE TABLE "team" (id integer PRIMARY KEY, label text DEFAULT 'a; delete');
    --> statement-breakpoint
    DO $$ BEGIN
      ALTER TABLE "member" ADD CONSTRAINT "team_ref" FOREIGN KEY (team_id) REFERENCES "team"(id) ON DELETE NO ACTION;
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    CREATE UNIQUE INDEX "team_label" ON "team" (label);`;
  assert.equal(drizzleStatements(changes).length, 3);
  for (const sql of [
    'CREATE TABLE sample (id integer); DROP TABLE customer;',
    'ALTER TABLE customer ADD COLUMN a integer, DROP COLUMN b;',
    'CREATE TABLE sample (id) AS VALUES (1);',
    'DO $$ BEGIN DELETE FROM customer; END $$;',
    'CREATE INDEX CONCURRENTLY sample_idx ON sample(id);',
    '\\connect other\nCREATE TABLE sample (id integer);'
  ]) assert.equal(drizzleStatements(sql), undefined);
});

test('Drizzle configuration accepts a static PostgreSQL target and rejects ambiguous targets', async () => {
  const detect = (source, files = ['drizzle.config.ts']) => drizzleConfig('.', files, async () => source);
  assert.deepEqual(await detect(config), { file: 'drizzle.config.ts', variable: 'STACKFORGE_DRIZZLE_TEST_URL',
    out: 'lib/migrations', historySchema: 'drizzle', historyTable: '__drizzle_migrations' });
  for (const input of [
    config.replace('./lib/migrations', '../outside'),
    config.replace('postgresql', 'sqlite'),
    config.replace('out:', '...overrides, out:'),
    config.replace('out:', 'dialect: "postgresql", out:'),
    config.replace('out:', 'driver: "pglite", out:'),
    config.replace('out:', '__proto__: { driver: "pglite" }, out:'),
    config.replace('process.env.STACKFORGE_DRIZZLE_TEST_URL!', '{ variable: "STACKFORGE_DRIZZLE_TEST_URL" }'),
    config.replace('url:', 'url: getTarget(), unused:'),
    'runProjectCode();\n' + config
  ]) assert.equal(await detect(input), undefined);
  assert.equal(await detect(config, ['drizzle.config.ts', 'drizzle.config.js']), undefined);
});

test('Drizzle preview stops before connecting on missing or conflicting configuration and invalid journals', async t => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-drizzle-preview-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  const project = { id: randomUUID(), path, imported: true, unmanaged: true };
  const journal = join(path, 'lib/migrations/meta/_journal.json');
  const entries = [{ idx: 0, version: '7', when: 1726443359662, tag: '0000_create', breakpoints: true }];
  await mkdir(join(path, 'lib/migrations/meta'), { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify({ devDependencies: { 'drizzle-kit': '^0.31.1' } }));
  await writeFile(join(path, 'drizzle.config.ts'), config);
  const writeJournal = (version = '7') => writeFile(journal, JSON.stringify({ version, dialect: 'postgresql', entries }));
  await writeJournal();
  await writeFile(join(path, 'lib/migrations/0000_create.sql'), 'CREATE TABLE test_private (id integer);');
  const { requirements } = await discoverDatabases(project);
  const requirement = requirements.find(item => item.migrationAdapter === 'drizzle');
  assert.equal(requirement.status, 'missing');
  const rejectCommand = async () => { assert.fail('A PostgreSQL client must not run for an unverified target.'); };
  const inspect = () => previewDrizzle({ project, requirementId: requirement.id, resolveClient: rejectCommand, command: rejectCommand });
  assert.equal((await inspect()).status, 'configuration-needed');
  await writeFile(join(path, '.env'), 'STACKFORGE_DRIZZLE_TEST_URL=postgresql://tester:secret-one@localhost/fixture\n');
  await writeFile(join(path, '.env.local'), 'STACKFORGE_DRIZZLE_TEST_URL=postgresql://tester:secret-two@localhost/fixture\n');
  const ambiguous = await inspect();
  assert.equal(ambiguous.status, 'environment-conflict');
  assert.deepEqual(ambiguous.sources, ['.env', '.env.local']);
  assert.doesNotMatch(JSON.stringify(ambiguous), /secret-one|secret-two|CREATE TABLE/);
  await rm(join(path, '.env.local'));
  await writeFile(join(path, '.env'), 'STACKFORGE_DRIZZLE_TEST_URL=postgresql://tester:secret-one@db.fixture.invalid/fixture\n');
  assert.equal((await inspect()).status, 'remote-target');
  await writeJournal('8');
  assert.equal((await inspect()).status, 'files-unavailable');
  entries[0].tag = '../escape';
  await writeJournal();
  assert.equal((await inspect()).status, 'files-unavailable');
});
