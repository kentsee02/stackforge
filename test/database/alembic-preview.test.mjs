import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverDatabases } from '../../src/database/discovery.mjs';
import { readAlembicDependencyLock } from '../../src/database/migrations/alembic-dependency-lock.mjs';
import { previewAlembic } from '../../src/database/migrations/alembic-preview.mjs';
import { resolveStartup } from '../../src/projects/project-startup.mjs';

async function fixture(t) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-alembic-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, 'checkout');
  const backend = join(path, 'services/api');
  const versions = join(backend, 'app/alembic/versions');
  await mkdir(versions, { recursive: true });
  const config = join(backend, 'alembic.ini');
  await writeFile(config, '[alembic]\nscript_location = %(here)s/app/alembic\n');
  const project = { id: 'alembic-test', path, unmanaged: true };
  project.folderIdentity = (await resolveStartup(project, [])).identity;
  const { migrationSources, requirements } = await discoverDatabases(project, { includeMigrations: true });
  assert.deepEqual(requirements, []);
  assert.equal(migrationSources.length, 1);
  const [source] = migrationSources;
  assert.equal(source.source, 'services/api/alembic.ini');
  const preview = (id = source.id, signal) => previewAlembic(project, id, signal);
  const revision = (file, id, parent, extra = '') => writeFile(join(versions, file + '.py'),
    `revision: str = '${id}'\ndown_revision: str | tuple[str, ...] | None = ${parent}\n${extra}`);
  return { workspace, project, backend, versions, config, source, preview, revision };
}

test('Alembic dependency locks bind exact hashes and paths without accepting pip directives', async t => {
  const { project, backend, workspace } = await fixture(t);
  const filename = 'services/api/python.lock';
  const hash = '--hash=sha256:' + 'a'.repeat(64);
  const rule = 'SQLAlchemy_Utils==0.42.1';
  const file = join(backend, 'python.lock');
  await writeFile(file, '# Reviewed wheel\r\n' + rule + ' \\\r\n    ' + hash + '\r\n');
  const lock = await readAlembicDependencyLock(project.path, filename);
  assert.deepEqual(lock.packages, [{ name: 'sqlalchemy-utils', version: '0.42.1' }]);
  assert.equal(lock.requirements, 'sqlalchemy-utils==0.42.1 ' + hash + '\n');
  await writeFile(file, rule + ' ' + hash + '\n');
  assert.notEqual((await readAlembicDependencyLock(project.path, filename)).fingerprint, lock.fingerprint);
  for (const candidate of ['../python.lock', '/etc/requirements.txt', 'C:\\temp\\python.lock', '.git/python.lock', 'services/api/./python.lock']) {
    await assert.rejects(readAlembicDependencyLock(project.path, candidate), /exact package versions/);
  }
  for (const contents of [
    rule, 'package>=1 ' + hash, 'package==1.* ' + hash, 'package==1 --hash=md5:' + '1'.repeat(32),
    'package @ https://example.com/archive.whl', '-r other.txt', '--extra-index-url https://example.com',
    '-e .', 'package[feature]==1 ' + hash, 'package==1; python_version>="3" ' + hash,
    rule + ' ' + hash + '\nsqlalchemy-utils==0.42.1 ' + hash, 'SQLAlchemy==2.0.48 ' + hash, '  # no packages'
  ]) {
    await writeFile(file, contents);
    await assert.rejects(readAlembicDependencyLock(project.path, filename), /exact package versions/);
  }
  await writeFile(join(workspace, 'outside.lock'), rule + ' ' + hash);
  const linked = join(backend, 'linked.lock');
  try { await symlink(join(workspace, 'outside.lock'), linked); }
  catch (error) {
    if (error.code === 'EPERM' && process.platform === 'win32') return;
    throw error;
  }
  await assert.rejects(readAlembicDependencyLock(project.path, 'services/api/linked.lock'), /exact package versions/);
});

test('Alembic preview orders a branched and merged migration graph without loading Python', async t => {
  const { versions, preview, revision } = await fixture(t);
  assert.equal((await preview()).status, 'empty');
  await writeFile(join(versions, 'z_base.py'), `"""Description
revision = 'pretend'
"""
import app_dependencies_that_are_not_installed
# revision = 'comment'
revision = 'base'
down_revision = None
raise RuntimeError('MIGRATION_CONTENT_MUST_NOT_APPEAR_IN_RESPONSE')
`);
  await revision('a_left', 'left', "'base'");
  await revision('b_right', 'right', "'base'");
  const branched = await preview();
  assert.equal(branched.status, 'ready');
  assert.deepEqual(branched.heads, ['left', 'right']);
  await revision('c_merge', 'merge', "(\n    'left', # branch\n    'right',\n)");
  await revision('d_followup', 'followup', "'merge'", "depends_on = 'right'\n");
  const merged = await preview();
  assert.equal(merged.status, 'ready');
  assert.deepEqual(merged.heads, ['followup']);
  assert.deepEqual(merged.revisions.map(item => item.revision), ['base', 'left', 'right', 'merge', 'followup']);
  assert.deepEqual(merged.revisions[3].parents, ['left', 'right']);
  assert.doesNotMatch(JSON.stringify(merged), /MIGRATION_CONTENT|app_dependencies/);
});

test('Alembic preview withholds heads for incomplete, dynamic, or invalid graphs', async t => {
  const { versions, preview, revision, source } = await fixture(t);
  await assert.rejects(preview('a'.repeat(64)), /Choose a detected Alembic configuration/);
  await assert.rejects(preview(source.id, AbortSignal.abort()), { name: 'AbortError' });
  await revision('a_base', 'base', 'None');
  for (const code of [
    "revision = 'tip'\ndown_revision = 'missing'\n",
    "revision = 'tip'\ndown_revision = 'tip'\n",
    "revision = 'base'\ndown_revision = None\n",
    "revision = get_revision()\ndown_revision = None\n",
    "dummy = dict(\nrevision='not_a_declaration'\n)\ndown_revision = None\n",
    "revision = 'tip'\nif condition:\n    revision = 'alternate'\ndown_revision = None\n"
  ]) {
    await writeFile(join(versions, 'b_tip.py'), code);
    const result = await preview();
    assert.equal(result.status, 'unverified', code);
    assert.equal(result.heads, undefined);
  }
});

test('Alembic preview refuses escaped, custom, linked, and replaced directories', async t => {
  const { workspace, project, backend, versions, config, preview } = await fixture(t);
  for (const value of ['script_location = ../../outside', 'script_location = app/alembic\nversion_locations = shared']) {
    await writeFile(config, `[alembic]\n${value}\n`);
    assert.equal((await preview()).status, 'unsupported-config');
  }
  await writeFile(config, '[alembic]\nscript_location = app/alembic\n');
  await writeFile(join(backend, 'pyproject.toml'), '[tool.alembic]\nscript_location = "another"\n');
  assert.equal((await preview()).status, 'unsupported-config');
  await rm(join(backend, 'pyproject.toml'));
  await rm(versions, { recursive: true });
  const outside = join(workspace, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.py'), "revision = 'outside'\ndown_revision = None\n");
  await symlink(outside, versions, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await preview();
  assert.equal(result.status, 'files-unavailable');
  assert.deepEqual(result.revisions, []);
  await rename(project.path, join(workspace, 'original'));
  await mkdir(project.path);
  await assert.rejects(preview(), /project folder was moved or replaced/);
});
