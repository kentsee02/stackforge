import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { databaseInventory, databaseReady, transferDatabase } from './docker-transfer.mjs';
import { inspectLegacyBackup, legacyFileBackup } from './archive.mjs';
import { backupInput, isBackupFile } from './payload.mjs';
import { run } from '../../platform/process.mjs';

const label = 'io.stackforge.restore-check';
const unsupported = 'The isolated restore requires an official database image for the target version in local Docker.';

export async function verifyBackupImage({ engine, version, signal, command = run }) {
  const [, major, minor] = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version) ?? [];
  if (!major || !['postgres', 'mysql'].includes(engine)) throw new Error(unsupported);
  const image = engine === 'postgres' ? `postgres:${major}` : `mysql:${major}.${minor}`;
  const options = { signal, stdoutOnly: true, timeout: 10000, stdoutLimit: 1024 };
  try {
    const id = (await command('docker', ['image', 'inspect', '--format', '{{.Id}}', image], options)).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error(unsupported);
    return { image, id };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    try { await command('docker', ['version', '--format', '{{.Server.Version}}'], options); }
    catch (failure) {
      if (failure.name === 'AbortError') throw failure;
      throw new Error('Docker is unavailable. Start Docker and try again.');
    }
    throw new Error(`The isolated verification image is missing. Run docker pull ${image} and try again.`);
  }
}

export async function verifySqlRestore({ engine, version, data, legacy = false, signal, command = run, prepared }) {
  const [major] = version.split('.').map(Number);
  const { id: image } = prepared ?? await verifyBackupImage({ engine, version, signal, command });
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
      const header = postgres ? await docker(['exec', '-i', container, 'pg_restore', '--list'], {
        ...backupInput(data), allowPartialInput: true, stdoutLimit: 8 * 1024 * 1024, timeout: isBackupFile(data) ? 120000 : 15000
      }) :
        data.subarray(0, 4096).toString('utf8');
      const sourceVersion = (postgres ? /^;\s+Dumped from database version:\s+(\d+\.\d+(?:\.\d+)?)/m :
        /^-- Server version\s+(\d+\.\d+(?:\.\d+)?)/m).exec(header)?.[1];
      legacyMetadata = (isBackupFile(data) ? await legacyFileBackup(data, engine, sourceVersion, version, signal) :
        inspectLegacyBackup(data, engine, sourceVersion, version)).metadata;
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
