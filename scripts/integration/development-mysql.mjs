import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { createApp } from '../../src/http/server.mjs';
import { run } from '../../src/platform/process.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-development-mysql-')));
const project = join(root, 'mysql-project');
const stateFile = join(root, 'state/databases.json');
const docker = (args, options = {}) => run('docker', args, { stdoutOnly: true, timeout: 60000, ...options });
const label = 'io.stackforge.development-mysql';
let app, projectId, listener, replacement, renamed;

try {
  await mkdir(join(project, 'app'), { recursive: true });
  await writeFile(join(project, 'app/database.py'), `import os
from dotenv import load_dotenv
from sqlalchemy import create_engine
load_dotenv()
${['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].map(key => `${key} = os.getenv("${key}")`).join('\n')}
engine = create_engine(f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}")
`);
  await writeFile(join(project, '.gitignore'), '.env\n');
  await writeFile(join(project, '.env'), '# Private development settings\nDB_HOST=""\nAPP_MODE=development\n');
  await mkdir(join(project, 'sql'));
  await writeFile(join(project, 'flyway.conf'), 'flyway.locations=filesystem:sql\n');
  await writeFile(join(project, 'sql/V1__create.sql'), 'CREATE TABLE example (id int);\n');
  await writeFile(join(project, 'liquibase.properties'), 'changeLogFile=changelog.xml\n');
  await writeFile(join(project, 'changelog.xml'), '<databaseChangeLog><changeSet id="create" author="example"/></databaseChangeLog>');
  await run('git', ['init'], { cwd: project });
  const noClient = async () => { throw new Error('ENOENT'); };
  app = createApp({ stateDir: join(root, 'state/jobs'), localDatabase: { command: noClient }, databaseAdapters: { command: noClient } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = 'http://127.0.0.1:' + app.address().port;
  const { token } = await fetch(origin + '/api/state').then(result => result.json());
  const api = async (path, body, expected = 200) => {
    const response = await fetch(origin + '/api/projects/' + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status, expected, result.error);
    return result;
  };
  ({ id: projectId } = await api('import', { path: project }, 201));
  const endpoint = projectId + '/database-development';
  const read = () => api(endpoint);
  const send = (body, code) => api(endpoint, body, code);
  const record = async () => JSON.parse(await readFile(stateFile, 'utf8')).development[projectId];
  const { options } = await read();
  assert.deepEqual(options.map(({ engine, directory, canCreate }) => ({ engine, directory, canCreate })), [{ engine: 'mysql', directory: '.', canCreate: true }]);
  listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  listener = undefined;
  const args = { name: 'project_mysql', port, targetId: options[0].id };
  const preview = await send({ mode: 'preview', ...args });
  assert.equal(preview.image, 'docker.io/library/mysql:8.4');
  assert.match(preview.volume, /^stackforge-mysql-[a-f0-9]+-data$/);
  assert.equal(preview.connections[0].style, 'mysql-fields');
  await send({ mode: 'create', ...args, plan: preview.plan, confirm: 'other' }, 409);
  await send({ mode: 'create', ...args, plan: preview.plan, confirm: args.name });
  const ready = async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = await read();
      if (status.status === 'ready') return status;
      await delay(1200);
    }
    throw new Error('The dedicated MySQL test database did not become ready.');
  };
  const status = await ready();
  const { container, key } = await record();
  assert.equal(status.engine, 'mysql');
  assert.equal(status.volume, preview.volume);
  assert.equal((await docker(['port', container, '3306'])).trim(), '127.0.0.1:' + port);
  assert.equal(status.archive.restore, true);
  const query = sql => docker(['exec', container, 'sh', '-c',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --no-defaults --batch --skip-column-names --user=root --database="$MYSQL_DATABASE" --execute="$1"', 'stackforge', sql]);
  assert.equal((await query("SELECT COUNT(*) FROM mysql.user WHERE user='root' AND host <> 'localhost';")).trim(), '0');
  const migrations = await api(projectId + '/database-discovery');
  const { id: targetId } = migrations.sqlMigrationTargets.find(item => item.projectMysql);
  const migrationHistory = async (adapter, table) => {
    const { id: sourceId } = migrations.migrationSources.find(item => item.adapter === adapter);
    return (await api(projectId + '/database-' + adapter + '-preview', { sourceId, targetId, table })).database;
  };
  assert.equal((await migrationHistory('flyway')).status, 'history-missing');
  assert.equal((await migrationHistory('liquibase')).status, 'history-missing');
  await query(`CREATE TABLE custom_flyway (installed_rank INT, version VARCHAR(50), script VARCHAR(1000), type VARCHAR(20),
    checksum INT, success BOOL); INSERT custom_flyway VALUES (1, '01', 'V1__create.sql', 'SQL', NULL, true);
    CREATE TABLE DATABASECHANGELOG (id VARCHAR(255), author VARCHAR(255), filename VARCHAR(255), exectype VARCHAR(10));
    INSERT DATABASECHANGELOG VALUES ('create', 'example', 'changelog.xml', 'EXECUTED');`);
  assert.deepEqual((await migrationHistory('flyway', 'custom_flyway')).items, [{ state: 'recorded' }]);
  assert.deepEqual((await migrationHistory('liquibase')).items, [{ state: 'recorded' }]);
  await query('DROP TABLE custom_flyway, DATABASECHANGELOG;');
  const { id, revision } = status.connections[0];
  assert.deepEqual(await send({ mode: 'save', requirementId: id, revision }), { saved: true, file: '.env' });
  const text = await readFile(join(project, '.env'), 'utf8');
  const env = parseEnv(text);
  assert.deepEqual([env.DB_HOST, env.DB_PORT, env.DB_NAME, env.DB_USER, env.APP_MODE], ['127.0.0.1', String(port), args.name, 'stackforge', 'development']);
  assert.match(env.DB_PASSWORD, /^[a-f0-9]{48}$/);
  assert.equal(JSON.stringify(await read()).includes(env.DB_PASSWORD), false);
  assert.equal((await readFile(stateFile, 'utf8')).includes(env.DB_PASSWORD), false);
  await send({ mode: 'save', requirementId: id, revision }, 409);

  const sqlDir = join(project, 'drizzle');
  await mkdir(join(sqlDir, 'meta'), { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ devDependencies: { 'drizzle-kit': '0.31.8' } }));
  await writeFile(join(project, 'drizzle.config.ts'), `export default { dialect: 'mysql', dbCredentials: { url: process.env.DRIZZLE_DATABASE_URL },
    migrations: { table: 'drizzle_history' } }`);
  const url = `mysql://${env.DB_USER}:${env.DB_PASSWORD}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`;
  await writeFile(join(project, '.env'), text + '\nDRIZZLE_DATABASE_URL=' + url + '\n');
  const journal = join(sqlDir, 'meta', '_journal.json');
  const legacyFile = join(sqlDir, '0000_posts.sql');
  const firstSql = "CREATE TABLE posts (id INT PRIMARY KEY, title VARCHAR(60));\n--> statement-breakpoint\nINSERT INTO posts VALUES (1, 'semi;colon');\n";
  const initialTag = '20230101000000_posts';
  const olderTag = '20221231000000_add_score';
  const when = Date.parse('2023-01-01T00:00:00.245Z');
  const entry = { idx: 0, version: '5', when, tag: '0000_posts', breakpoints: true };
  await writeFile(journal, JSON.stringify({ version: '7', dialect: 'mysql', entries: [entry] }));
  await writeFile(legacyFile, firstSql);
  const drizzle = (await api(projectId + '/database-discovery')).requirements.find(item => item.migrationAdapter === 'drizzle');
  assert.equal(drizzle.engine, 'mysql');
  const previewDrizzle = () => api(projectId + '/database-drizzle-preview', { requirementId: drizzle.id });
  const applyDrizzle = (planId, confirmName = args.name, code = 200) => api(projectId + '/database-drizzle-apply', {
    requirementId: drizzle.id, planId, confirmName
  }, code);
  const initial = await previewDrizzle();
  assert.equal(initial.status, 'pending', JSON.stringify(initial));
  assert.equal(initial.format, 'journal-v7');
  assert.ok(initial.reviewSql.includes(firstSql));
  assert.equal(JSON.stringify(initial).includes(env.DB_PASSWORD), false);
  assert.equal((await query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE();")).trim(), '0');
  await applyDrizzle(initial.planId, 'other', 409);
  await writeFile(legacyFile, firstSql + '\n');
  await applyDrizzle(initial.planId, args.name, 409);
  await writeFile(legacyFile, firstSql);
  await query('CREATE TABLE write_drift (id INT); DROP TABLE write_drift;');
  await applyDrizzle(initial.planId, args.name, 409);
  const legacy = await applyDrizzle((await previewDrizzle()).planId);
  assert.equal(legacy.status, 'applied', JSON.stringify(legacy));
  assert.equal((await query('SELECT title FROM posts;')).trim(), 'semi;colon');
  assert.equal((await previewDrizzle()).status, 'current');
  await writeFile(legacyFile, firstSql + '\n');
  assert.equal((await previewDrizzle()).status, 'history-conflict');
  await unlink(journal);
  await unlink(legacyFile);
  await mkdir(join(sqlDir, initialTag));
  await writeFile(join(sqlDir, initialTag, 'migration.sql'), firstSql);
  assert.equal((await previewDrizzle()).status, 'history-upgrade-required');
  await query("ALTER TABLE drizzle_history ADD name TEXT, ADD applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP; " +
    "UPDATE drizzle_history SET name='" + initialTag + "', applied_at=NULL;");
  await mkdir(join(sqlDir, olderTag));
  await writeFile(join(sqlDir, olderTag, 'migration.sql'), 'ALTER TABLE posts ADD score DECIMAL(5,2) NOT NULL DEFAULT 1.25;');
  const named = await previewDrizzle();
  assert.equal(named.format, 'v1');
  assert.deepEqual(named.migrations.map(row => row.state), ['pending', 'applied']);
  assert.equal((await applyDrizzle(named.planId)).status, 'applied');
  assert.equal((await query('SELECT score FROM posts;')).trim(), '1.25');
  const third = join(sqlDir, '20230102000000_more');
  await mkdir(third);
  const thirdFile = join(third, 'migration.sql');
  for (const sql of ['DROP TABLE drizzle_history;', 'CREATE TABLE unsafe (id INT); /*!80000 SET SQL_MODE = "" */;', 'SOURCE C:/script.sql;']) {
    await writeFile(thirdFile, sql);
    const blocked = await previewDrizzle();
    assert.equal(blocked.applyBlocked, true, sql);
    assert.equal(blocked.planId, undefined);
  }
  await writeFile(thirdFile, 'CREATE TABLE partially_applied (id INT); ALTER TABLE missing_table ADD value INT;');
  const partial = await applyDrizzle((await previewDrizzle()).planId);
  assert.equal(partial.status, 'recovery-required', JSON.stringify(partial));
  assert.equal((await query('SELECT COUNT(*) FROM partially_applied; SELECT COUNT(*) FROM drizzle_history;')).trim(), '0\n2');
  assert.equal((await previewDrizzle()).status, 'recovery-required');
  await query('DROP TABLE partially_applied, __stackforge_drizzle_pending;');
  await writeFile(thirdFile, 'CREATE TABLE before_cancel (id INT); INSERT INTO before_cancel SELECT SLEEP(45); CREATE TABLE after_cancel (id INT);');
  const cancelPlan = await previewDrizzle();
  const migrationSessionCount = () => query(`SELECT COUNT(*) FROM performance_schema.threads thread
    JOIN performance_schema.user_variables_by_thread vars ON vars.THREAD_ID=thread.THREAD_ID
    WHERE thread.PROCESSLIST_DB=DATABASE() AND vars.VARIABLE_NAME='stackforge_migration'
      AND EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='before_cancel');`).then(value => Number(value.trim()));
  const controller = new AbortController();
  const unfinished = fetch(origin + '/api/projects/' + projectId + '/database-drizzle-apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token },
    body: JSON.stringify({ requirementId: drizzle.id, planId: cancelPlan.planId, confirmName: args.name }), signal: controller.signal
  }).then(() => undefined, error => error);
  try {
    for (let attempt = 0; attempt < 40 && !await migrationSessionCount(); attempt++) await delay(300);
    assert.equal(await migrationSessionCount(), 1);
  } finally {
    controller.abort();
  }
  assert.equal((await unfinished)?.name, 'AbortError');
  for (let attempt = 0; attempt < 20 && await migrationSessionCount(); attempt++) await delay(250);
  assert.equal(await migrationSessionCount(), 0);
  assert.equal((await previewDrizzle()).status, 'recovery-required');
  assert.equal((await query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='after_cancel';")).trim(), '0');
  // Reset this disposable fixture so the existing archive test can start cleanly.
  await query('DROP TABLE posts, drizzle_history, before_cancel, __stackforge_drizzle_pending;');

  const archive = async (action, data, confirm) => fetch(origin + '/api/projects/' + projectId + '/database-archive' + (action ? '/' + action : ''), {
    method: 'POST', body: data ?? '{}', headers: { 'X-StackForge-Token': token, 'Content-Type': data ? 'application/octet-stream' : 'application/json',
      'X-StackForge-Binding': status.archive.id, ...(confirm && { 'X-StackForge-Preview': confirm.id, 'X-StackForge-Target': Buffer.from(confirm.name).toString('base64') }) }
  });
  await query('CREATE TABLE sample (value int); INSERT INTO sample VALUES (42); CREATE PROCEDURE answer() SELECT 42;');
  const backup = await archive();
  if (!backup.ok) assert.fail(await backup.text());
  const data = Buffer.from(await backup.arrayBuffer());
  assert.equal((await archive('preview', data)).status, 409);
  await query('DROP TABLE sample; DROP PROCEDURE answer;');
  const restorePreview = await archive('preview', data);
  const confirmation = await restorePreview.json();
  assert.ok(restorePreview.ok, confirmation.error);
  assert.equal(confirmation.name, args.name);
  assert.equal((await archive('restore', data, { ...confirmation, name: 'other' })).status, 409);
  const restore = await archive('restore', data, confirmation);
  const outcome = await restore.json();
  assert.equal(outcome.restored, true, outcome.error);
  assert.equal((await query('SELECT value FROM sample; CALL answer();')).trim(), '42\n42');
  await send({ mode: 'delete', confirm: status.volume }, 409);
  await send({ mode: 'stop' });
  assert.equal((await read()).status, 'stopped');
  await send({ mode: 'start' });
  await ready();
  assert.equal((await query('SELECT value FROM sample;')).trim(), '42');
  await send({ mode: 'stop' });
  const name = status.volume.slice(0, -'-data'.length);
  renamed = name + '-fixture';
  await docker(['container', 'rename', container, renamed]);
  replacement = (await docker(['container', 'create', '--name', name, '--label', label + '=' + key, preview.image])).trim();
  await api(endpoint, undefined, 409);
  await send({ mode: 'delete', confirm: status.volume }, 409);
  assert.equal((await archive()).status, 409);
  await docker(['container', 'rm', '-v', replacement]);
  replacement = undefined;
  await docker(['container', 'rename', container, name]);
  renamed = undefined;
  await send({ mode: 'delete', confirm: status.volume });
  await assert.rejects(docker(['volume', 'inspect', status.volume]), /no such volume/i);
  await api(projectId + '/remove', { confirmName: 'mysql-project' });
  console.log('Verified project MySQL provisioning, reviewed Drizzle journal and v1 migrations, recovery blocking, archive restore, and ownership.');
} finally {
  if (listener) await new Promise(resolve => listener.close(resolve));
  if (app) {
    await app.shutdownTasks();
    await new Promise(resolve => app.close(resolve));
  }
  if (replacement && /^[a-f\d]{64}$/.test(replacement)) await docker(['container', 'rm', '-v', replacement]).catch(() => {});
  const record = await readFile(stateFile, 'utf8').then(value => JSON.parse(value).development[projectId], () => undefined);
  if (record?.engine === 'mysql' && /^[a-f\d]{32}$/.test(record.key)) {
    const name = 'stackforge-mysql-' + record.key;
    for (const container of [name, renamed].filter(Boolean)) {
      const value = await docker(['container', 'inspect', '--format', `{{index .Config.Labels "${label}"}}`, container]).catch(() => '');
      if (value.trim() === record.key) await docker(['container', 'rm', '-f', container]);
    }
    const value = await docker(['volume', 'inspect', '--format', `{{index .Labels "${label}"}}`, name + '-data']).catch(() => '');
    if (value.trim() === record.key) await docker(['volume', 'rm', name + '-data']);
  }
  await rm(root, { recursive: true, force: true });
}
