import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  const { id, revision } = status.connections[0];
  assert.deepEqual(await send({ mode: 'save', requirementId: id, revision }), { saved: true, file: '.env' });
  const text = await readFile(join(project, '.env'), 'utf8');
  const env = parseEnv(text);
  assert.deepEqual([env.DB_HOST, env.DB_PORT, env.DB_NAME, env.DB_USER, env.APP_MODE], ['127.0.0.1', String(port), args.name, 'stackforge', 'development']);
  assert.match(env.DB_PASSWORD, /^[a-f0-9]{48}$/);
  assert.equal(JSON.stringify(await read()).includes(env.DB_PASSWORD), false);
  assert.equal((await readFile(stateFile, 'utf8')).includes(env.DB_PASSWORD), false);
  await send({ mode: 'save', requirementId: id, revision }, 409);

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
  console.log('Verified dedicated MySQL provisioning, scoped connection settings, backup and restore, restart, and ownership checks.');
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
