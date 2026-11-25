import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { discoverDatabases } from '../../src/database/discovery.mjs';
import { previewFlyway } from '../../src/database/migrations/flyway-preview.mjs';

async function fixture(t, files) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-flyway-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  await Promise.all(Object.entries(files).map(async ([file, content]) => {
    const target = join(path, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }));
  return { id: 'flyway-test', path };
}

const sources = async project => (await discoverDatabases(project, { includeMigrations: true })).migrationSources
  .filter(source => source.adapter === 'flyway');

test('Flyway keeps Spring service and profile locations separate and uses numeric version order', async t => {
  const service = 'components/region/catalog/app/';
  const resources = service + 'src/main/resources/';
  const project = await fixture(t, {
    [service + 'pom.xml']: '<project><dependencies><dependency><groupId>org.flywaydb</groupId><artifactId>flyway-core</artifactId></dependency></dependencies></project>',
    [resources + 'application.properties']: 'spring.flyway.locations=classpath:schema/base\n',
    [resources + 'application-dev.properties']: 'spring.flyway.enabled=true\n',
    [resources + 'application-prod.yml']: 'spring:\n  flyway:\n    locations:\n      - classpath:schema/base\n      - filesystem:deployment/prod\n',
    [resources + 'application-test.yml']: 'spring:\n  flyway:\n    enabled: false\n',
    [resources + 'schema/base/deep/V10__Add_items.sql']: 'SELECT 1;',
    [resources + 'schema/base/V2.01__Create_items.sql']: 'SELECT 2;',
    [resources + 'schema/base/B1__Initial_snapshot.sql']: 'SELECT 3;',
    [resources + 'schema/base/U2.01__Undo_items.sql']: 'SELECT 4;',
    [resources + 'schema/base/R__Update_views.sql']: 'SELECT 5;',
    [service + 'deployment/prod/V11__Configure_indexes.sql']: 'SELECT 6;',
    [service + 'other/profile/V09__Not_selected.sql']: 'SELECT 99;'
  });
  const discovered = await sources(project);
  const get = profile => previewFlyway(project, discovered.find(source => source.profile === profile).id);
  const base = await get(undefined);
  assert.equal(base.status, 'ready');
  assert.deepEqual(base.migrations.map(item => [item.kind, item.version]), [
    ['versioned', '2.01'], ['versioned', '10'], ['repeatable', undefined], ['baseline', '1'], ['undo', '2.01']
  ]);
  assert.deepEqual((await get('dev')).locations, base.locations);
  const prod = await get('prod');
  assert.equal(prod.status, 'ready');
  assert.deepEqual(prod.locations, [resources + 'schema/base', service + 'deployment/prod']);
  assert.deepEqual(prod.migrations.filter(item => item.kind === 'versioned').map(item => item.version), ['2.01', '10', '11']);
  assert.equal((await get('test')).status, 'disabled');
});

test('Flyway resolves Maven profile config files without merging versions across profiles or disclosing settings', async t => {
  const plugin = name => '<plugin><groupId>org.flywaydb</groupId><artifactId>flyway-maven-plugin</artifactId>' +
    '<configuration><configFiles><configFile>configuration/' + name + '.conf</configFile></configFiles></configuration></plugin>';
  const profiles = ['development', 'production'].map(name => '<profile><id>' + name + '</id><build><plugins>' +
    plugin(name) + '</plugins></build></profile>').join('');
  const project = await fixture(t, {
    'pom.xml': '<project><build><plugins>' + plugin('development') + '</plugins></build><profiles>' + profiles + '</profiles></project>',
    'configuration/development.conf': 'flyway.locations=filesystem:db/common,filesystem:db/dev\nflyway.password=private_fixture_value',
    'configuration/production.conf': 'flyway.locations=filesystem:db/common,filesystem:db/prod',
    'db/common/V1__Setup.sql': 'SELECT 1;',
    'db/dev/V2__Development.sql': 'SELECT 2;',
    'db/prod/V2__Production.sql': 'SELECT 3;'
  });
  const discovered = await sources(project);
  assert.equal(discovered.length, 3);
  for (const [profile, type] of [['development', 'Development'], ['production', 'Production']]) {
    const plan = await previewFlyway(project, discovered.find(item => item.profile === profile).id);
    assert.equal(plan.status, 'ready');
    assert.deepEqual(plan.migrations.map(row => row.description), ['Setup', type]);
    assert.doesNotMatch(JSON.stringify(plan), /private_fixture_value|SELECT/);
  }
  assert.doesNotMatch(JSON.stringify(discovered), /private_fixture_value/);
  await assert.rejects(previewFlyway({ ...project, id: 'another-project' }, discovered[0].id), /Choose a detected Flyway configuration/);
});

test('Flyway flags duplicate numeric versions, unsafe locations and unrecognized SQL files', async t => {
  const project = await fixture(t, {
    'flyway.toml': '[flyway]\nlocations = [\n  "filesystem:./schema",\n  "filesystem:./separate",\n]\n',
    'schema/V0002__Initial.sql': 'SELECT 1;',
    'schema/nested/V2_0__Duplicate.sql': 'SELECT 2;',
    'schema/afterMigrate.sql': 'SELECT 3;',
    'schema/unknown.sql': 'SELECT 5;',
    'separate/V12__Later.sql': 'SELECT 4;',
    'unsafe/flyway.conf': 'flyway.locations=filesystem:../schema',
    'custom/flyway.conf': 'flyway.locations=filesystem:./sql\nflyway.sqlMigrationPrefix=Migration'
  });
  const discovered = await sources(project);
  const source = discovered.find(source => source.source === 'flyway.toml');
  const preview = await previewFlyway(project, source.id);
  assert.equal(preview.status, 'partial');
  assert.equal(preview.unrecognized, 1);
  assert.deepEqual(preview.callbacks, ['schema/afterMigrate.sql']);
  assert.deepEqual(preview.migrations.map(item => [item.version, item.verified]), [['2_0', false], ['0002', false], ['12', true]]);
  for (const other of discovered.filter(item => item.id !== source.id)) {
    assert.equal((await previewFlyway(project, other.id)).status, 'unsupported-config');
  }
  const outside = await fixture(t, { 'V100__Outside.sql': 'SELECT 100;' });
  await symlink(outside.path, join(project.path, 'schema', 'linked'), 'junction');
  const linked = await previewFlyway(project, source.id);
  assert.equal(linked.limited, true);
  assert.equal(linked.migrations.length, 3);
  assert.equal(await readFile(join(project.path, 'schema', 'V0002__Initial.sql'), 'utf8'), 'SELECT 1;');
});

test('Flyway recognizes Gradle location settings and the standalone CLI default', async t => {
  const project = await fixture(t, {
    'flyway.conf': '# CLI configuration with default locations\nflyway.outputType=json',
    'sql/V1__Cli.sql': 'SELECT 1;',
    'workloads/platform/datastore/build.gradle': "plugins { id('org.flywaydb.flyway') version '11.0.0' }\n" +
      "flyway {\n  locations = ['filesystem:db/schema']\n}\n",
    'workloads/platform/datastore/db/schema/V2__Gradle.sql': 'SELECT 2;'
  });
  const discovered = await sources(project);
  assert.equal(discovered.length, 2);
  for (const [scope, version] of [['standalone', '1'], ['gradle', '2']]) {
    const preview = await previewFlyway(project, discovered.find(source => source.scope === scope).id);
    assert.equal(preview.status, 'ready');
    assert.equal(preview.migrations[0].version, version);
  }
});

test('Flyway recognizes conventional Spring locations and keeps dynamic configuration outside that scope', async t => {
  const properties = 'src/main/resources/application.properties';
  const project = await fixture(t, {
    'pom.xml': '<project><dependencies><dependency><groupId>org.flywaydb</groupId><artifactId>flyway-core</artifactId></dependency></dependencies></project>',
    [properties]: 'spring.datasource.url=jdbc:mysql://localhost:3306/catalog\n',
    'src/main/resources/db/migration/V1__Catalog.sql': 'CREATE TABLE catalog(id INT);'
  });
  const [implicit] = await sources(project);
  assert.equal(implicit.scope, 'spring');
  assert.equal(implicit.implicitLocations, true);
  assert.equal((await previewFlyway(project, implicit.id)).migrations[0].version, '1');
  await writeFile(join(project.path, properties), 'spring.profiles.active=dev\n');
  assert.ok((await sources(project)).every(source => !source.implicitLocations));
  await writeFile(join(project.path, properties), 'spring.config.import=optional:file:extra.properties\n');
  assert.ok((await sources(project)).every(source => !source.implicitLocations));
  await writeFile(join(project.path, properties), 'spring.datasource.url=jdbc:mysql://localhost:3306/catalog\n!---\nspring.config.activate.on-profile=dev\n');
  assert.ok((await sources(project)).every(source => !source.implicitLocations));
});
