import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { databaseInventory, databaseReady, transferDatabase } from './docker-transfer.mjs';
import { inspectLegacyBackup } from './archive.mjs';
import { run } from '../../platform/process.mjs';

const label = 'io.stackforge.restore-check';
const unsupported = 'The isolated restore requires an official database image for the target version in local Docker.';

export async function verifySqlRestore({ engine, version, data, legacy = false, signal, command = run }) {
  const [major, minor] = version.split('.').map(Number);
  const image = engine === 'postgres' ? `postgres:${major}` : `mysql:${major}.${minor}`;
  const id = randomBytes(12).toString('hex');
  const name = 'stackforge-restore-' + id;
  const password = randomBytes(24).toString('hex');
  const postgres = engine === 'postgres';
  const docker = (args, options = {}) => command('docker', args, { signal, stdoutOnly: true, timeout: 15000, ...options });
  const environment = postgres ? ['POSTGRES_DB=app', 'POSTGRES_PASSWORD=' + password] :
    ['MYSQL_DATABASE=app', 'MYSQL_USER=app', 'MYSQL_PASSWORD=' + password, 'MYSQL_ROOT_PASSWORD=' + password];
  const mount = postgres ? (major < 18 ? '/var/lib/postgresql/data' : '/var/lib/postgresql') : '/var/lib/mysql';
  let container;
  try {
    try {
      container = (await docker(['run', '-d', '--pull=never', '--network', 'none', '--name', name,
        '--label', label + '=' + id, '--mount', `type=tmpfs,destination=${mount},tmpfs-size=536870912`,
        '--memory', '768m', '--pids-limit', '256',
        ...environment.flatMap(value => ['--env', value]), image,
        ...(postgres ? [] : ['--log-bin-trust-function-creators=ON', '--innodb-buffer-pool-size=64M'])])).trim();
      if (!/^[a-f0-9]{64}$/.test(container)) throw new Error();
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error(unsupported);
    }
    const options = { engine, container, config: {}, command, signal, project: 'Restore verification' };
    const until = Date.now() + 65000;
    while (!await databaseReady(options)) {
      if (Date.now() > until) throw new Error('The isolated database did not become ready.');
      await delay(500, undefined, { signal });
    }
    let legacyMetadata;
    if (legacy) {
      const header = postgres ? await docker(['exec', '-i', container, 'pg_restore', '--list'], { input: data, stdoutLimit: 8 * 1024 * 1024 }) :
        data.subarray(0, 4096).toString('utf8');
      const sourceVersion = (postgres ? /^;\s+Dumped from database version:\s+(\d+\.\d+(?:\.\d+)?)/m :
        /^-- Server version\s+(\d+\.\d+(?:\.\d+)?)/m).exec(header)?.[1];
      legacyMetadata = inspectLegacyBackup(data, engine, sourceVersion, version).metadata;
    }
    await transferDatabase({ ...options, file: data });
    return { ...await databaseInventory(options), legacyMetadata };
  } finally {
    try {
      const current = (await docker(['container', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "' + label + '"}}', name], { signal: undefined })).trim().split(' ');
      if (/^[a-f0-9]{64}$/.test(current[0]) && current[1] === id) await docker(['container', 'rm', '-fv', current[0]], { signal: undefined });
    } catch { /* A failed start may leave no container. */ }
  }
}
