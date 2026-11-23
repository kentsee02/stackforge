import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { discoverDatabases } from '../../src/database/discovery.mjs';
import { previewLiquibase } from '../../src/database/migrations/liquibase-preview.mjs';

async function fixture(t, files) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-liquibase-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  await Promise.all(Object.entries(files).map(async ([file, content]) => {
    const target = join(path, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }));
  return { id: 'liquibase-fixture', path };
}

const sources = async project => (await discoverDatabases(project, { includeMigrations: true })).migrationSources
  .filter(source => source.adapter === 'liquibase');
const xml = values => '<?xml version="1.0" encoding="UTF-8"?>\n<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">\n' +
  values + '\n</databaseChangeLog>';
const sql = id => '--liquibase formatted sql\n--changeset dev:' + id + '\nSELECT 1;\n';

test('Liquibase follows nested Spring changelogs in declared and includeAll order', async t => {
  const service = 'workloads/region/billing/api/';
  const resources = service + 'src/main/resources/';
  const project = await fixture(t, {
    [service + 'pom.xml']: '<project><dependencies><dependency><groupId>org.liquibase</groupId><artifactId>liquibase-core</artifactId></dependency></dependencies></project>',
    [resources + 'application.yml']: 'spring:\n  liquibase:\n    change-log: classpath:/db/master.yaml\n',
    [resources + 'application-prod.properties']: 'spring.liquibase.change-log=classpath:db/prod.xml\n',
    [resources + 'application-test.properties']: 'spring.liquibase.enabled=false\n',
    [resources + 'db/master.yaml']: 'databaseChangeLog:\n- changeSet:\n    id: start\n    author: dev\n    changes:\n      - sql:\n          sql: SELECT 2\n' +
      '- include:\n    file: db/changelog.json\n- includeAll:\n    path: formatted\n    relativeToChangelogFile: true\n    maxDepth: 1\n    endsWithFilter: .sql\n',
    [resources + 'db/changelog.json']: JSON.stringify({ databaseChangeLog: [{ changeSet: { id: 2, author: 'dev' } },
      { include: { file: 'db/xml/one.xml' } }] }),
    [resources + 'db/xml/one.xml']: xml('<changeSet id="3" author="dev" />\n<!-- <changeSet id="fake" author="dev" /> -->'),
    [resources + 'db/formatted/b.sql']: sql('5'),
    [resources + 'db/formatted/a.sql']: sql('4'),
    [resources + 'db/formatted/excluded/deep.sql']: sql('deep'),
    [resources + 'db/prod.xml']: xml('<changeSet id="prod" author="dev" />')
  });
  const discovered = await sources(project);
  const read = profile => previewLiquibase(project, discovered.find(item => item.profile === profile).id);
  const base = await read(undefined);
  assert.equal(base.status, 'ready');
  assert.deepEqual(base.changes.map(item => item.id), ['start', '2', '3', '4', '5']);
  assert.deepEqual(base.files.slice(-2), [resources + 'db/formatted/a.sql', resources + 'db/formatted/b.sql']);
  assert.equal((await read('test')).status, 'disabled');
  assert.deepEqual((await read('prod')).changes.map(item => item.id), ['prod']);
  assert.doesNotMatch(JSON.stringify(base), /SELECT/);
});

test('Liquibase uses Maven-local property files and keeps credentials private', async t => {
  const project = await fixture(t, {
    'pom.xml': '<project><build><plugins><plugin><groupId>org.liquibase</groupId><artifactId>liquibase-maven-plugin</artifactId>' +
      '<configuration><propertyFile>configuration/migrations.properties</propertyFile></configuration></plugin></plugins></build></project>',
    'configuration/migrations.properties': 'changeLogFile=db/master.xml\npassword=private_fixture_password\n',
    'db/master.xml': xml('<include file="change.sql" relativeToChangelogFile="true" />'),
    'db/change.sql': sql('maven')
  });
  const [item] = await sources(project);
  const preview = await previewLiquibase(project, item.id);
  assert.equal(item.scope, 'maven');
  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.changes.map(row => row.id), ['maven']);
  assert.doesNotMatch(JSON.stringify([item, preview]), /private_fixture_password/);
  await assert.rejects(previewLiquibase({ ...project, id: 'other' }, item.id), /Choose a detected Liquibase changelog/);
});

test('Liquibase flags duplicate logical identities, cyclic references and XML with a document type', async t => {
  const project = await fixture(t, {
    'liquibase.properties': 'liquibase.command.changelogFile=db/root.xml',
    'db/root.xml': xml('<include file="db/first.xml" logicalFilePath="previous.xml"/>\n' +
      '<include file="db/second.xml" logicalFilePath="previous.xml"/>\n<include file="db/cycle.xml"/>\n<include file="db/doctype.xml"/>\n' +
      '<include file="db/optional.xml" errorIfMissing="false"/>\n<include file="db/disabled.xml" ignore="true"/>'),
    'db/first.xml': xml('<changeSet id="1" author="dev"/>'),
    'db/second.xml': xml('<changeSet id="1" author="dev"/>'),
    'db/cycle.xml': xml('<include file="db/root.xml"/>'),
    'db/doctype.xml': '<!DOCTYPE databaseChangeLog SYSTEM "file:///private.xml"><databaseChangeLog/>',
    'db/disabled.xml': xml('<changeSet id="excluded" author="dev"/>')
  });
  const [item] = await sources(project);
  const preview = await previewLiquibase(project, item.id);
  assert.equal(preview.status, 'partial');
  assert.deepEqual(preview.changes.map(row => [row.id, row.verified]), [['1', false], ['1', false]]);
  assert.deepEqual([...preview.issues].sort(), ['db/doctype.xml', 'db/first.xml', 'db/root.xml', 'db/second.xml']);
});

test('Liquibase never reads outside the selected service or follows linked changelogs', async t => {
  const service = 'components/region/warehouse/';
  const project = await fixture(t, {
    [service + 'liquibase.properties']: 'changeLogFile=changes/root.xml',
    [service + 'changes/root.xml']: xml('<include file="../../private.sql" relativeToChangelogFile="true"/>\n' +
      '<includeAll path="changes/external"/>\n<include file="changes/good.sql"/>'),
    [service + 'changes/good.sql']: sql('safe'),
    'components/region/private.sql': sql('private')
  });
  const outside = await fixture(t, { 'linked.sql': sql('linked') });
  await symlink(outside.path, join(project.path, service, 'changes/external'), 'junction');
  const [item] = await sources(project);
  const preview = await previewLiquibase(project, item.id);
  assert.equal(preview.status, 'partial');
  assert.deepEqual(preview.changes.map(item => item.id), ['safe']);
  assert.equal(await readFile(join(project.path, service, 'changes/good.sql'), 'utf8'), sql('safe'));
});
