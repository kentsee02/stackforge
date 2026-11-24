import { createHmac, randomBytes } from 'node:crypto';
import { join, posix } from 'node:path';
import { throwIfCancelled } from '../../platform/process.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { localSession } from '../adapters/local.mjs';
import { buildMigrationImage, runMigrationContainer } from '../docker/migration-container.mjs';
import { databaseKey, discoverDatabases } from '../discovery.mjs';
import { compareAlembicHistory } from './alembic-history.mjs';
import { planAlembicDependencies } from './alembic-dependency-plan.mjs';
import { previewAlembic } from './alembic-preview.mjs';
import { readMigrationFile } from './migration-files.mjs';
import { migrationDatabaseIdentity } from './native-sql-migrations.mjs';
import { postgresHistoryTable } from './postgres-history-table.mjs';

const version = '1.20.1';
const signingKey = randomBytes(32);
const changed = 'The migration plan changed or expired. Preview it again.';
const unsupported = 'Guided Alembic requires a verified revision graph and self-contained migration scripts.';
const environmentUnsupported = 'Choose an Alembic environment that accepts the supplied connection and list its local Python files.';
const invalidHistory = 'Check the migration history and target database before preparing a write.';
const dockerfile = [
  'FROM python@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df',
  'RUN python -m pip --isolated install --no-cache-dir --only-binary=:all: alembic==' + version +
    ' sqlalchemy==2.0.48 psycopg[binary]==3.3.3 sqlmodel==0.0.27',
  'USER 65534:65534',
  'ENTRYPOINT ["python", "-B", "/stackforge/run.py"]'
].join('\n') + '\n';
const imageReference = 'stackforge-alembic-runtime:' + databaseKey(dockerfile).slice(0, 24);

const runner = [
  'import json, os, sys',
  'from alembic import command',
  'from alembic.config import Config',
  'from alembic.migration import MigrationContext',
  'from sqlalchemy import URL, create_engine, event',
  'url = URL.create("postgresql+psycopg", username=os.environ["SF_USER"], password=os.environ["SF_PASSWORD"],',
  '  host="127.0.0.1", port=int(os.environ["SF_PORT"]), database=os.environ["SF_DATABASE"],',
  '  query={"application_name": os.environ["SF_APPLICATION"]})',
  'options = dict(version_table=os.environ["SF_TABLE"], version_table_schema=os.environ["SF_SCHEMA"])',
  'reviewed = None',
  'if os.environ.get("SF_CHECK_RANGE"):',
  '    with open("/stackforge/reviewed-graph.json", encoding="utf-8") as review_file:',
  '        reviewed = json.load(review_file)',
  'observed = set()',
  'def record_step(ctx, step, heads, run_args):',
  '    revision = step.up_revision_id',
  '    if revision not in reviewed or revision in observed or not set(reviewed[revision]) <= observed:',
  '        raise RuntimeError("Alembic departed from the reviewed revision graph")',
  '    observed.add(revision)',
  'if reviewed is not None:',
  '    options["on_version_apply"] = record_step',
  'config = Config()',
  'config.set_main_option("script_location", "/stackforge/alembic")',
  'with create_engine(url).begin() as connection:',
  '    connection.exec_driver_sql("SET LOCAL lock_timeout = \'5s\'")',
  '    connection.exec_driver_sql("SET LOCAL statement_timeout = \'130s\'")',
  '    connection.exec_driver_sql("SELECT pg_advisory_xact_lock(hashtext(\'stackforge:alembic\'::text))")',
  '    target = connection.exec_driver_sql("SELECT current_database(), pg_postmaster_start_time()::text, "',
  '       "(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database())").one()',
  '    if list(target) != json.loads(os.environ["SF_TARGET"]):',
  '        raise RuntimeError("Database target changed")',
  '    context = MigrationContext.configure(connection, opts=options)',
  '    if sorted(context.get_current_heads()) != json.loads(os.environ["SF_CURRENT"]):',
  '        raise RuntimeError("Alembic history changed")',
  '    config.attributes.update(connection=connection, options=options)',
  '    operation, revision = sys.argv[1:]',
  '    def deny_commit(_connection):',
  '        raise RuntimeError("The project environment tried to commit the migration transaction")',
  '    event.listen(connection, "commit", deny_commit)',
  '    try:',
  '        (command.upgrade if operation == "apply" else command.downgrade)(config, revision)',
  '    finally:',
  '        event.remove(connection, "commit", deny_commit)',
  '    if reviewed is not None and observed != set(reviewed):',
  '        raise RuntimeError("Alembic did not run the reviewed range")',
  '    if sorted(context.get_current_heads()) != json.loads(os.environ["SF_EXPECTED"]):',
  '        raise RuntimeError("Alembic did not record the expected revision")',
  ''
].join('\n');
const environment = [
  'from alembic import context',
  'settings = context.config.attributes',
  'context.configure(connection=settings["connection"], **settings["options"])',
  'with context.begin_transaction():',
  '    context.run_migrations()',
  ''
].join('\n');

const projectEnvironment = [
  'import os, runpy, sys',
  'from alembic import context',
  'settings = context.config.attributes',
  'configure = context.configure',
  'configured = False',
  'def bound_configure(*args, **kwargs):',
  '    global configured',
  '    if args or kwargs.get("connection") is not settings["connection"] or kwargs.get("url") is not None:',
  '        raise RuntimeError("The project environment did not use the supplied connection")',
  '    kwargs.update(settings["options"], transactional_ddl=True, transaction_per_migration=False)',
  '    configure(**kwargs)',
  '    configured = True',
  'sys.path.insert(0, "/stackforge/project")',
  'os.chdir("/stackforge/project")',
  'context.configure = bound_configure',
  'try:',
  '    runpy.run_path("/stackforge/alembic/project_env.py", run_name="__main__")',
  '    if not configured:',
  '        raise RuntimeError("The project environment did not configure Alembic")',
  'finally:',
  '    context.configure = configure',
  ''
].join('\n');

async function readSource(project, sourceId, scanned, signal, runtime) {
  const source = scanned.migrationSources.find(item => item.adapter === 'alembic' && item.id === sourceId);
  if (!source) throw new Error(unsupported);
  const preview = await previewAlembic(project, sourceId, signal, scanned);
  const { revisions } = preview;
  if (preview.status !== 'ready' || revisions.some(({ revision }) =>
      revision.length > 32 || /^(?:base|head|heads)$/i.test(revision))) throw new Error(unsupported);
  const files = new Map([['run.py', runner], ['alembic/env.py', runtime ? projectEnvironment : environment]]);
  const resources = [];
  if (runtime) {
    const { files: modules } = runtime;
    if (!Array.isArray(modules) || modules.length > 24 || new Set(modules).size !== modules.length ||
        modules.some(file => typeof file !== 'string' || file.length > 220 || !/^(?:[a-zA-Z_]\w*\/)*[a-zA-Z_]\w*\.py$/.test(file))) {
      throw new Error(environmentUnsupported);
    }
    try {
      const prefix = source.directory === '.' ? '' : source.directory + '/';
      const env = prefix + posix.join(posix.dirname(source.versions), 'env.py');
      const text = await readMigrationFile(join(scanned.root, env), 256 * 1024);
      if (!/\.attributes(?:\.get\s*\(\s*['"]connection['"]|\s*\[\s*['"]connection['"]\s*\])/.test(text) ||
          /\bautocommit_block\s*\(/.test(text)) throw new Error(environmentUnsupported);
      files.set('alembic/project_env.py', text);
      resources.push(env);
      for (const file of modules) {
        throwIfCancelled(signal);
        const path = prefix + file;
        const text = await readMigrationFile(join(scanned.root, path), 256 * 1024);
        if (/\bautocommit_block\s*\(/.test(text)) throw new Error(environmentUnsupported);
        files.set('project/' + file, text);
        resources.push(path);
      }
      if (!modules.length) files.set('project/__init__.py', '');
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error(environmentUnsupported);
    }
  }
  try {
    let remaining = 8 * 1024 ** 2;
    for (const row of revisions) {
      throwIfCancelled(signal);
      const filename = posix.basename(row.file);
      if (!/^[\w.-]+\.py$/.test(filename) || remaining <= 0) throw new Error();
      const text = await readMigrationFile(join(scanned.root, row.file), Math.min(remaining, 256 * 1024));
      if (!/^def upgrade\s*\(/m.test(text) || /\bautocommit_block\s*\(/.test(text)) throw new Error();
      remaining -= Buffer.byteLength(text);
      files.set('alembic/versions/' + filename, text);
    }
    const config = await readMigrationFile(join(scanned.root, source.source), 64 * 1024);
    return { revisions, heads: preview.heads, files, resources, directory: source.directory, fingerprint: databaseKey(source, config, [...files]) };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(unsupported);
  }
}

function selectedRevision(source, state, operation, requested) {
  const { revisions, heads } = source;
  const graph = new Map(revisions.map(item => [item.revision, item]));
  if (operation === 'rollback' && !state.heads.length) throw new Error('There are no eligible migrations for this operation.');
  const previous = state.heads.length === 1 && graph.get(state.heads[0]).parents;
  const selected = requested ?? (operation === 'apply' ? heads.length === 1 ? heads[0] : 'heads' :
    previous && previous.length <= 1 ? previous[0] ?? 'base' : undefined);
  if (!selected && operation === 'rollback') throw new Error('Choose an explicit rollback revision for a branched Alembic history.');
  if (selected !== 'base' && selected !== 'heads' && !graph.has(selected)) throw new Error('Choose a revision in the requested migration direction.');
  return selected;
}

function revisionPlan(source, state, operation, selected) {
  const { revisions, heads } = source;
  const graph = new Map(revisions.map(item => [item.revision, item]));
  const expected = selected === 'base' ? [] : selected === 'heads' ? heads : [selected];
  const desired = new Set();
  const pending = [...expected];
  for (const id of pending) {
    if (desired.has(id)) continue;
    desired.add(id);
    pending.push(...graph.get(id).parents);
  }
  const current = new Set(state.revisions.filter(item => item.state === 'applied').map(item => item.revision));
  const apply = operation === 'apply';
  const [from, to] = apply ? [current, desired] : [desired, current];
  if (from.size >= to.size || [...from].some(id => !to.has(id))) throw new Error('Choose a revision in the requested migration direction.');
  const range = revisions.filter(item => to.has(item.revision) && !from.has(item.revision));
  return { expected, range: apply ? range : range.reverse() };
}

export async function nativeAlembicMigration({ project, payload, target, client, signal, directory, verifyShared }) {
  const { mode, operation, sourceId } = payload;
  if (!['preview', 'execute'].includes(mode) || !['apply', 'rollback'].includes(operation)) throw new Error(unsupported);
  const runtime = payload.projectEnvironment === true ? { files: payload.runtimeFiles ?? [] } : undefined;
  const scanned = await discoverDatabases(project, { includeMigrations: true });
  const source = await readSource(project, sourceId, scanned, signal, runtime);
  const { revisions } = source;
  const history = postgresHistoryTable(payload.schema, payload.table, 'alembic_version');
  const scope = await client.migrationScope();
  const credentials = await client.credentials();
  const session = localSession(target, credentials, client.command, signal);
  const readIdentity = () => migrationDatabaseIdentity(session, target.name, history, 'alembic');
  const compare = () => compareAlembicHistory({ revisions, history, selection: target, credentials, resolveClient: async () => client,
    signal, includeFingerprint: true });
  const before = await readIdentity();
  const state = await compare();
  if (!['current', 'pending'].includes(state.status) || !state.heads.length && before.populated) {
    throw new Error(invalidHistory);
  }
  const selected = selectedRevision(source, state, operation, payload.revision);
  const crossBranch = revisions.some(item => item.dependencies.length);
  const localPlan = crossBranch ? undefined : revisionPlan(source, state, operation, selected);
  const image = await buildMigrationImage({ ...scope, reference: imageReference, dockerfile, allowBuild: mode === 'preview', directory });
  if (!image) throw new Error(changed);
  const { expected, range } = localPlan ?? await planAlembicDependencies({
    revisions, heads: state.heads, operation, selected, scope, image, directory, signal
  });
  if (operation === 'rollback' && range.some(row => !/^def downgrade\s*\(/m.test(source.files.get('alembic/versions/' + posix.basename(row.file))))) {
    throw new Error('A selected Alembic revision does not declare a downgrade.');
  }
  const reviewedRange = range.map(item => item.revision).sort();
  const reviewedGraph = Object.fromEntries(reviewedRange.map(revision => [revision, []]));
  for (const row of range) {
    for (const dependency of [...row.parents, ...row.dependencies]) {
      if (!Object.hasOwn(reviewedGraph, dependency)) continue;
      if (operation === 'apply') reviewedGraph[row.revision].push(dependency);
      else reviewedGraph[dependency].push(row.revision);
    }
  }
  const expires = mode === 'preview' ? String(Date.now() + 300000) : /^(\d{13})\.[a-f\d]{64}$/.exec(payload.planId ?? '')?.[1];
  const signature = createHmac('sha256', signingKey).update(JSON.stringify([
    expires, project.id, scanned.identity, sourceId, source.fingerprint, operation, selected,
    target, scope.container, image, history, before, state.fingerprint, expected, reviewedRange
  ])).digest('hex');
  const planId = expires + '.' + signature;
  const plan = { target, history, tool: 'Alembic', version, directory: source.directory,
    ...(source.resources.length && { resources: source.resources }),
    fromRevision: state.heads.join(', ') || 'base', toRevision: selected, ...(crossBranch && { expectedHeads: expected }),
    migrations: range.map(({ file, revision }) => ({ file, revision })) };
  if (mode === 'preview') return { status: 'planned', planId, ...plan };
  if (!expires || Number(expires) <= Date.now() || payload.planId !== planId || payload.confirmName !== target.name) throw new Error(changed);
  await verifyShared(target);
  const latest = await discoverDatabases(project, { includeMigrations: true });
  if ((await readSource(project, sourceId, latest, signal, runtime)).fingerprint !== source.fingerprint) throw new Error(changed);
  await resolveStartup(project, [], scanned.identity);
  const application = 'stackforge_migration_' + randomBytes(12).toString('hex');
  const files = crossBranch ? new Map([...source.files, ['reviewed-graph.json', JSON.stringify(reviewedGraph)]]) : source.files;
  try {
    await runMigrationContainer({ ...scope, image, args: [operation, selected], files, directory, signal,
      env: { SF_USER: credentials.user, SF_PASSWORD: credentials.password, SF_PORT: String(scope.port), SF_DATABASE: target.name,
        SF_APPLICATION: application, SF_SCHEMA: history.schema, SF_TABLE: history.table,
        SF_TARGET: JSON.stringify([target.name, before.startedAt, before.oid]), SF_CURRENT: JSON.stringify(state.heads), SF_EXPECTED: JSON.stringify(expected),
        ...(crossBranch && { SF_CHECK_RANGE: '1', PYTHONHASHSEED: '0' }) },
      cancel: () => scope.cancel(application),
      async verify() {
        await scope.verify();
        if (databaseKey(await readIdentity()) !== databaseKey(before) || (await compare()).fingerprint !== state.fingerprint) throw new Error(changed);
      }
    });
  } catch (error) {
    if (error.name === 'AbortError' || error.message === changed) throw error;
    return { status: 'execution-failed' };
  }
  try {
    const currentState = await compare();
    if ((await readIdentity()).id !== before.id || JSON.stringify(currentState.heads) !== JSON.stringify(expected)) {
      return { status: 'execution-unverified' };
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return { status: 'execution-unverified' };
  }
  return { status: operation === 'apply' ? 'applied' : 'rolled-back', ...plan };
}
