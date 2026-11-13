import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { databaseSecretFiles } from './database-secrets.mjs';

export const composeProjectLabel = 'com.docker.compose.project';
export const composeServiceLabel = 'com.docker.compose.service';
export const composeVolumeLabel = 'com.docker.compose.volume';

export function databaseImageEngine(image) {
  return typeof image === 'string' ? /^(?:(?:docker\.io\/)?library\/|docker\.io\/)?(mysql|postgres)(?::[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/.exec(image)?.[1] : undefined;
}

export function databaseDataDirectory(image, engine) {
  const major = /\bpostgres:(\d+)/.exec(image)?.[1];
  return engine === 'mysql' ? '/var/lib/mysql' : major && Number(major) < 18 ? '/var/lib/postgresql/data' : '/var/lib/postgresql';
}

export function databaseDockerEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COMPOSE_/i.test(key)));
}

export function databaseSecretTargets(spec, model) {
  const targets = new Set();
  const paths = new Set(databaseSecretFiles(spec.environment).map(([, path]) => path));
  for (const secret of spec.secrets ?? []) {
    const source = typeof secret === 'string' ? secret : secret.source;
    const target = typeof secret === 'string' ? secret : secret.target || source;
    if (!source || !target || !model.secrets?.[source] ||
        !/^(?:\/run\/secrets\/)?[\w.-]+$/.test(target) || ['.', '..'].includes(target.split('/').at(-1))) return;
    const path = target.startsWith('/') ? target : `/run/secrets/${target}`;
    if (!paths.has(path)) return;
    targets.add(path);
  }
  return targets;
}

export function databaseMountMatches(mounts, volume, target, secretTargets) {
  const data = mounts.filter(item => item.Type === 'volume' && item.Name === volume && item.Destination === target && item.RW === true);
  if (data.length !== 1) return false;
  const other = mounts.filter(item => item !== data[0]);
  return other.length === secretTargets.size && other.every(item =>
    item.Type === 'bind' && item.RW === false && secretTargets.has(item.Destination)) &&
    new Set(other.map(item => item.Destination)).size === other.length;
}

const customStartup = 'StackForge cannot start this database with custom commands, hooks, or container privileges. Review and start it with Docker Compose.';
export const databaseStartupRestricted = 'DATABASE_STARTUP_RESTRICTED';
const restrictedStartup = () => Object.assign(new Error(customStartup), { code: databaseStartupRestricted });
const serverExecutable = { postgres: 'postgres', mysql: 'mysqld' };
const postgresSettings = /^(?:listen_addresses|port|max_connections|shared_buffers|work_mem|maintenance_work_mem|log_statement|log_min_duration_statement|log_connections|log_disconnections|timezone|statement_timeout|idle_in_transaction_session_timeout)=/i;
const mysqlSettings = /^--(?:port|bind-address|socket|character-set-server|collation-server|max-connections|log-bin-trust-function-creators|sql-mode|default-time-zone|innodb-buffer-pool-size|innodb-log-file-size|lower-case-table-names|event-scheduler|skip-name-resolve|skip-log-bin)(?:=|$)/i;
const healthOptions = {
  postgres: /^(?:\s+(?:-q|(?:-[dhptU]|--(?:dbname|host|port|timeout|username))(?:=|\s+)[\w.$/{}:"'@-]+))*$/,
  mysql: /^(?:\s+(?:--silent|--no-defaults|(?:-[hPuS]|--(?:host|port|user|socket|protocol|connect-timeout))(?:=|\s+)[\w.$/{}:"'@-]+))*$/
};

function standardCommand(command, engine) {
  if (command == null) return true;
  if (!Array.isArray(command) || !command.length || !command.every(arg => typeof arg === 'string')) return false;
  const args = command[0] === serverExecutable[engine] ? command.slice(1) : command;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (engine === 'mysql') {
      if (!mysqlSettings.test(arg)) return false;
      if (!arg.includes('=') && args[index + 1] && !args[index + 1].startsWith('-')) index++;
    } else if (arg === '-c') {
      if (!postgresSettings.test(args[++index] ?? '')) return false;
    } else if (arg === '-p') {
      if (!/^\d+$/.test(args[++index] ?? '')) return false;
    } else if (!/^--(?:port|max_connections|shared_buffers)=/.test(arg)) return false;
  }
  return true;
}

function standardHealth(test, engine) {
  if (test == null || (test.length === 1 && test[0] === 'NONE')) return true;
  if (!Array.isArray(test) || !test.every(arg => typeof arg === 'string')) return false;
  if (test[0] === 'CMD-SHELL' && test.length !== 2) return false;
  if (!['CMD', 'CMD-SHELL'].includes(test[0])) return false;
  const command = test.slice(1).join(' ').trim();
  if (/\$(?!\$|\{?[\w])|[\r\n]/.test(command)) return false;
  if (engine === 'postgres') return /^pg_isready(?:\s|$)/.test(command) && healthOptions.postgres.test(command.slice('pg_isready'.length));
  const mysql = /^(?:MYSQL_PWD=["']?\$+\{?MYSQL_(?:ROOT_)?PASSWORD\}?["']?\s+)?mysqladmin(?=\s|$)(.*)$/.exec(command)?.[1];
  if (mysql === undefined) return false;
  const pieces = mysql.split(/\s+ping(?=\s|$)/);
  return pieces.length === 2 && pieces.every(piece => healthOptions.mysql.test(piece));
}

export async function verifyComposeDatabaseStartup(spec, engine, model, directory) {
  if (spec.entrypoint != null || ['pre_start', 'post_start', 'pre_stop'].some(key => spec[key]?.length) ||
      !standardCommand(spec.command, engine) || !standardHealth(spec.healthcheck?.test, engine) ||
      spec.privileged || spec.cap_add?.length || spec.devices?.length || spec.device_cgroup_rules?.length ||
      spec.security_opt?.length || spec.configs?.length || spec.volumes_from?.length || spec.tmpfs?.length ||
      Boolean(spec.gpus?.length) || (spec.runtime && spec.runtime !== 'runc') ||
      /^(?:host|service:|container:)/.test(spec.network_mode ?? '') || spec.pid === 'host' || spec.ipc === 'host' ||
      Object.keys(spec.environment ?? {}).some(key => /^(?:LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV|POSTGRES_INITDB_ARGS|POSTGRES_INITDB_WALDIR)$/.test(key))) {
    throw restrictedStartup();
  }
  for (const secret of spec.secrets ?? []) {
    const source = typeof secret === 'string' ? secret : secret.source;
    const file = model?.secrets?.[source]?.file;
    if (!file || !isAbsolute(file)) throw restrictedStartup();
    const [actual, stat] = await Promise.all([realpath(file), lstat(file)]).catch(() => []);
    const location = actual && relative(directory, actual);
    if (!stat?.isFile() || !location || location === '..' || location.startsWith('..' + sep) || isAbsolute(location)) {
      throw restrictedStartup();
    }
  }
}

export async function verifyExistingDatabaseStartup(docker, id, engine) {
  const fields = ['.Config.Entrypoint', '.Config.Cmd', '.Config.Healthcheck', '.HostConfig.Privileged',
    '.HostConfig.CapAdd', '.HostConfig.Devices', '.HostConfig.SecurityOpt', '.HostConfig.NetworkMode',
    '.HostConfig.PidMode', '.HostConfig.IpcMode', '.Config.Env', '.HostConfig.Tmpfs', '.HostConfig.Runtime',
    '.HostConfig.DeviceCgroupRules', '.HostConfig.DeviceRequests', '.HostConfig.VolumesFrom'];
  let values;
  try {
    const format = fields.map(field => `{{json ${field}}}`).join('\t');
    values = (await docker(['inspect', '--type', 'container', '--format', format, id])).trimEnd().split('\t').map(value => JSON.parse(value));
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw restrictedStartup();
  }
  if (values.length !== fields.length) throw restrictedStartup();
  const [entrypoint, command, health, privileged, cap_add, devices, security_opt, network_mode, pid, ipc, env,
    tmpfs, runtime, device_cgroup_rules, gpus, volumes_from] = values;
  if (!Array.isArray(entrypoint) || entrypoint.length !== 1 || !/^(?:\/usr\/local\/bin\/)?docker-entrypoint\.sh$/.test(entrypoint[0])) {
    throw restrictedStartup();
  }
  const environment = Object.fromEntries((env ?? []).map(entry => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  // Official entrypoints set these empty by default on some versions.
  for (const key of ['POSTGRES_INITDB_ARGS', 'POSTGRES_INITDB_WALDIR']) if (!environment[key]) delete environment[key];
  await verifyComposeDatabaseStartup({ command, healthcheck: { test: health?.Test }, privileged, cap_add, devices,
    security_opt, network_mode, pid, ipc, environment, tmpfs: Object.keys(tmpfs ?? {}), runtime,
    device_cgroup_rules, gpus, volumes_from }, engine);
}

export function pinnedDatabaseCompose(model, service, mount, volume, labels) {
  const spec = model.services[service];
  return Buffer.from(JSON.stringify({
    name: model.name,
    networks: Object.fromEntries(Object.keys(spec.networks ?? {}).map(key => [key, model.networks?.[key]])),
    secrets: Object.fromEntries((spec.secrets ?? []).map(secret => {
      const source = typeof secret === 'string' ? secret : secret.source;
      return [source, model.secrets?.[source]];
    })),
    volumes: { [mount.source]: { external: true, name: volume } },
    services: { [service]: { ...spec, depends_on: undefined, links: undefined, env_file: undefined, labels: { ...spec.labels, ...labels } } }
  }));
}
