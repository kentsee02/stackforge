import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { scanEfCore } from '../../src/database/migrations/ef-core-preview.mjs';
import { discoverDatabases } from '../../src/database/discovery.mjs';
import { postgresHistoryTargets } from '../../src/database/migrations/postgres-history.mjs';
import { resolveStartup } from '../../src/projects/project-startup.mjs';

const using = 'using Microsoft.EntityFrameworkCore.Migrations;\nusing Microsoft.EntityFrameworkCore.Infrastructure;\n';
const migration = (name, id, context = 'StoreContext') => `${using}namespace Example.Schema;
[DbContext(typeof(${context})), Migration("${id}")]
public class ${name} : Migration { }
`;

async function fixture(t) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-ef-core-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, 'checkout');
  await mkdir(path);
  const project = { id: 'fixture', path };
  project.folderIdentity = (await resolveStartup(project, [])).identity;
  const write = async (file, content) => {
    const destination = join(path, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  };
  return { workspace, project, write };
}

test('EF Core discovers custom folders, linked source, and multiple projects and contexts', async t => {
  const { project, write } = await fixture(t);
  await write('packages/store/infra/Store.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="../../../shared/Schema.cs"/><Compile Remove="schema/Omitted.cs"/></ItemGroup></Project>');
  await write('packages/store/infra/schema/Mapping.cs', `${using}namespace Example.Schema {
    [DbContext(typeof(global::Store.CatalogContext))]
    [MigrationAttribute("20250102020000_Inventory")]
    partial class Inventory { }
  }`);
  await write('packages/store/infra/changes/Records.cs', `${using}namespace Example.Schema { public partial class Inventory : Migration {} }`);
  await write('shared/Schema.cs', migration('Tags', '20250103030000_Tags', 'Store.TagContext'));
  await write('packages/store/infra/schema/Omitted.cs', migration('Omitted', '20250101010000_Omitted'));
  await write('packages/store/infra/obj/Generated.cs', migration('BuildOutput', '20250101010001_BuildOutput'));
  await write('apps/catalog/Data.csproj', '<Project Sdk="Microsoft.NET.Sdk" />');
  await write('apps/catalog/Transitions.cs', migration('Initial', '20250101010000_Initial'));
  const { sources, limited } = await scanEfCore(project);
  assert.equal(limited, false);
  assert.deepEqual(sources.map(source => source.source), ['apps/catalog/Data.csproj', 'packages/store/infra/Store.csproj']);
  const preview = await scanEfCore(project, { sourceId: sources[1].id });
  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.groups.map(group => [group.context, group.migrations.map(item => [item.file, item.verified])]), [
    ['Store.CatalogContext', [['packages/store/infra/changes/Records.cs', true]]], ['Store.TagContext', [['shared/Schema.cs', true]]]
  ]);
});

test('EF Core verifies migrations in projects with BOM-marked and legacy C# sources', async t => {
  const { project, write } = await fixture(t);
  await write('Data.csproj', '<Project Sdk="Microsoft.NET.Sdk" />');
  const id = '20250101010000_Initial';
  await write('Changes.cs', Buffer.from('\ufeff' + migration('Initial', id), 'utf16le'));
  await write('Seed.cs', Buffer.from('// Caf\u00e9\ninternal class Seed { }', 'latin1'));
  const { sources: [source] } = await scanEfCore(project);
  const result = await scanEfCore(project, { sourceId: source.id });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.groups[0].migrations.map(item => [item.id, item.verified]), [[id, true]]);
});

test('EF Core offers simple loopback PostgreSQL settings and keeps authentication private', async t => {
  const { project, write } = await fixture(t);
  await write('appsettings.json', JSON.stringify({ ConnectionStrings: {
    metrics: 'Host=127.0.0.1;Port=5433;Database=metrics;Username=localreader;Password="private;fixture";Ssl Mode=Require',
    external: 'Host=192.0.2.5;Database=external;Username=localreader',
    routed: 'Host=localhost;Database=routed;Username=localreader;Search Path=private'
  } }));
  const discovery = await discoverDatabases(project, { includeConnections: true });
  const [target, ...other] = postgresHistoryTargets(discovery, { efCore: true });
  assert.deepEqual(other, []);
  assert.deepEqual([target.public.name, target.public.port, target.sslmode], ['metrics', 5433, 'require']);
  assert.equal(target.credentials.password, 'private;fixture');
  assert.doesNotMatch(JSON.stringify(target.public), /fixture|localreader/);
  assert.deepEqual(postgresHistoryTargets(discovery), []);
});

test('EF Core treats duplicate and incomplete declarations as unverified and ignores text and filenames', async t => {
  const { project, write, workspace } = await fixture(t);
  await write('Data.csproj', '<Project Sdk="Microsoft.NET.Sdk" />');
  await write('First.cs', migration('First', '20250101010000_Same'));
  await write('Second.cs', migration('Second', '20250101010000_Same'));
  await write('Detached.cs', `${using}namespace Example.Schema; [DbContext(typeof(StoreContext))][Migration("20250101010000_Detached")] partial class Detached { }`);
  await write('20250101010002_FilenameOnly.Designer.cs', `${using}namespace Example.Schema; // [Migration("20250101010002_Fake")] class Fake : Migration { }
    class Other { string value = """ Example [Migration("20250101010003_Text")] class Example : Migration { } """; }`);
  const { sources: [source] } = await scanEfCore(project);
  const result = await scanEfCore(project, { sourceId: source.id });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.groups[0].migrations.map(item => [item.id, item.verified]), [
    ['20250101010000_Detached', false], ['20250101010000_Same', false], ['20250101010000_Same', false]
  ]);
  await assert.rejects(scanEfCore(project, { sourceId: '../Data.csproj' }), /Choose a detected EF Core migration project/);
  await assert.rejects(scanEfCore({ ...project, id: 'another-project' }, { sourceId: source.id }), /Choose a detected EF Core migration project/);
  await rename(project.path, join(workspace, 'old'));
  await mkdir(project.path);
  await assert.rejects(scanEfCore(project, { sourceId: source.id }), /folder was moved or replaced/);
});
