import { randomBytes } from 'node:crypto';
import { run, throwIfCancelled } from '../../platform/process.mjs';
import { portAvailable } from '../../platform/ports.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { databaseKey, discoverDatabases } from '../discovery.mjs';
import { saveDatabaseEnvironment } from '../environment.mjs';

const image = 'docker.io/library/postgres:17';
const user = 'stackforge';
const host = '127.0.0.1';
const data = '/var/lib/postgresql/data';
const label = 'io.stackforge.development-postgres';
const changed = 'The project PostgreSQL container or volume could not be verified.';
const stale = 'The PostgreSQL plan changed. Preview it again.';
const unavailable = 'Start a local Docker Engine 28 or newer in Linux container mode.';
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const containerId = /^[a-f\d]{64}$/;
const id = /^[a-f\d]{32}$/;
const validName = name => typeof name === 'string' && /^[a-z][a-z\d_]{0,62}$/.test(name) && !['postgres', 'template0', 'template1'].includes(name);
const validPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535;

function localEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return false;
  return process.platform === 'win32' ? /^npipe:\/\/\/\/\.\/pipe\/(?:docker_engine|dockerDesktopLinuxEngine)$/i.test(endpoint) :
    /^unix:\/\/\/[^\r\n]+$/.test(endpoint);
}

async function mutate(cli, args, options) {
  try { return await cli(args, options); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    if (/address already in use|port is already allocated|ports are not available/i.test(error.message)) {
      throw new Error('Choose a free port for project PostgreSQL.');
    }
    if (/volume is in use/i.test(error.message)) throw new Error('Another Docker container still uses this PostgreSQL volume.');
    throw new Error('Docker could not finish the PostgreSQL operation. Check Docker Desktop or Docker Engine and retry.');
  }
}

async function dockerSession(command, signal) {
  const base = { stdoutOnly: true, stdoutLimit: 32 * 1024, signal, timeout: 15000 };
  const env = { ...process.env, LC_ALL: 'C' };
  try {
    const context = env.DOCKER_CONTEXT || (!env.DOCKER_HOST && (await command('docker', ['context', 'show'], { ...base, env })).trim());
    const endpoint = context ? JSON.parse(await command('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}', '--', context],
      { ...base, env })) : env.DOCKER_HOST;
    if (!localEndpoint(endpoint)) throw new Error();
    for (const key of Object.keys(env)) if (/^DOCKER_(CONTEXT|HOST|TLS|TLS_VERIFY|CERT_PATH)$/i.test(key)) delete env[key];
    const cli = (args, { timeout = base.timeout, password } = {}) => command('docker', ['--host', endpoint, ...args],
      { ...base, timeout, env: password ? { ...env, POSTGRES_PASSWORD: password } : env });
    const [daemon, version, os] = JSON.parse(await cli(['info', '--format', '[{{json .ID}},{{json .ServerVersion}},{{json .OSType}}]']));
    if (!daemon || os !== 'linux' || Number(version?.split('.')[0]) < 28 || !/^\d+\./.test(version)) throw new Error();
    return { cli, daemon };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(unavailable);
  }
}

const volumeName = record => 'stackforge-pg-' + record.key + '-data';
const nameOf = record => 'stackforge-pg-' + record.key;

async function inspectDocker(cli, kind, name, format = '{{json .}}') {
  try { return JSON.parse(await cli([kind, 'inspect', '--format', format, name])); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    if (/No such (?:container|object|volume)\b/i.test(error.message)) return;
    throw new Error(changed);
  }
}

async function owned(cli, record) {
  const volume = await inspectDocker(cli, 'volume', volumeName(record));
  if (volume && (volume.Name !== volumeName(record) || volume.Labels?.[label] !== record.key ||
      volume.Driver !== 'local' || volume.Scope !== 'local' || Object.keys(volume.Options ?? {}).length ||
      !volume.CreatedAt || record.created && record.created !== volume.CreatedAt)) throw new Error(changed);
  // Select only the required fields. Full container inspection includes credentials.
  const container = await inspectDocker(cli, 'container', nameOf(record), '[' +
    ['.Id', '.Config.Labels', '.Config.Image', '.State.Status', '.Mounts', '.HostConfig.PortBindings', '.HostConfig.NetworkMode']
      .map(field => '{{json ' + field + '}}').join(',') + ']');
  if (!container) return { volume };
  const [identity, labels, configuredImage, status, mounts, bindings, network] = container;
  const [port] = bindings?.['5432/tcp'] ?? [];
  const [mount] = mounts ?? [];
  if (!volume || !containerId.test(identity) || record.container && record.container !== identity ||
      labels?.[label] !== record.key || configuredImage !== image || network !== 'bridge' ||
      mounts?.length !== 1 || mount?.Type !== 'volume' || mount.Name !== volume.Name || mount.Destination !== data || !mount.RW ||
      Object.keys(bindings ?? {}).length !== 1 || bindings['5432/tcp'].length !== 1 || port.HostIp !== host ||
      port.HostPort !== String(record.port)) throw new Error(changed);
  return { volume, container: identity, status };
}

async function ready(cli, record, target) {
  if (target.status !== 'running') return false;
  try {
    const result = await cli(['exec', target.container, 'sh', '-c',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -XAtw -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT current_database()"']);
    return result.trim() === record.name;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return false;
  }
}

async function connections(project) {
  const { requirements, connections: values } = await discoverDatabases(project, { includeConnections: true });
  return requirements.filter(item => item.engine === 'postgres' && /^[A-Z_][A-Z0-9_]*$/.test(item.environmentVariable ?? '') &&
    !values.get(item.id)?.environmentConflict &&
    (item.status === 'missing' || item.status === 'placeholder' && item.environmentEdit &&
      (!item.guidedSetup || values.get(item.id)?.environmentSources?.length === 1)))
    .map(({ id, source, environmentVariable, environmentEdit }) => ({ id, source, variable: environmentVariable, revision: environmentEdit?.revision }));
}

export function developmentPostgres({ registry, verifyShared, command = run, probePort = portAvailable }) {
  const salt = randomBytes(16).toString('hex');
  function assertProject(project) {
    if (!project.imported || !project.unmanaged || !uuid.test(project.id) || !project.folderIdentity) {
      throw new Error('Project PostgreSQL is available for verified external imports and clones.');
    }
  }
  const owner = project => databaseKey(project.id, project.folderIdentity);
  const current = project => registry.value.development[project.id];
  const persist = (project, record) => registry.saveDevelopment(project.id, record);
  const reserved = port => Object.values(registry.value.development).some(item => item.port === port);
  function valid(record, project, daemon) {
    if (record.daemon !== daemon || record.owner !== owner(project) || !id.test(record.key) ||
        !validName(record.name) || !validPort(record.port)) throw new Error(changed);
  }
  function summary(record, target, accepting) {
    const status = target.status === 'running' ? accepting ? 'ready' : 'starting' :
      record.deleting || !target.container ? 'incomplete' : 'stopped';
    return { host, name: record.name, port: record.port, volume: volumeName(record), status,
      canStart: !record.deleting && (!record.created || Boolean(target.volume)) && (!record.container || Boolean(target.container)),
      canStop: target.status === 'running',
      canDelete: !target.container || ['created', 'exited'].includes(target.status) };
  }

  async function inspect(project, signal) {
    assertProject(project);
    await registry.ready;
    const record = current(project);
    if (!record) {
      let port = 55432;
      while (reserved(port) && port < 65535) port++;
      return { status: 'absent', port };
    }
    const { cli, daemon } = await dockerSession(command, signal);
    valid(record, project, daemon);
    const target = await owned(cli, record);
    const accepting = await ready(cli, record, target);
    const options = accepting ? await connections(project).catch(() => []) : [];
    return { ...summary(record, target, accepting), connections: options };
  }

  async function action(project, payload, signal) {
    assertProject(project);
    await registry.ready;
    const { mode, name, port } = payload;
    if (!['preview', 'create', 'start', 'stop', 'save', 'delete'].includes(mode)) throw new Error(stale);
    const { cli, daemon } = await dockerSession(command, signal);
    let record = current(project);
    if (mode === 'preview' || mode === 'create') {
      if (record || !validName(name) || !validPort(port)) throw new Error('Choose an unused PostgreSQL name and a port from 1024 to 65535.');
      await resolveStartup(project, []);
      const digest = expiry => databaseKey(salt, owner(project), daemon, name, port, expiry);
      const expiry = mode === 'preview' ? String(Date.now() + 300000) :
        typeof payload.plan === 'string' && /^\d{13}(?=\.)/.exec(payload.plan)?.[0];
      const plan = expiry + '.' + digest(expiry);
      if (mode === 'create' && (!expiry || Number(expiry) <= Date.now() || payload.plan !== plan || payload.confirm !== name)) throw new Error(stale);
      if (reserved(port) || !await probePort(port)) throw new Error('Choose a free port for project PostgreSQL.');
      if (mode === 'preview') return { plan, name, port, host, image };
      throwIfCancelled(signal);
      record = { owner: owner(project), daemon, name, port, key: randomBytes(16).toString('hex') };
      await persist(project, record);
    } else {
      if (!record) throw new Error(stale);
      valid(record, project, daemon);
    }
    let target = await owned(cli, record);
    if (mode === 'create' || mode === 'start') {
      await resolveStartup(project, []);
      if (record.deleting || record.container && !target.container || record.created && !target.volume) throw new Error(changed);
      if (!target.volume) {
        await mutate(cli, ['volume', 'create', '--driver', 'local', '--label', label + '=' + record.key, volumeName(record)]);
        target = await owned(cli, record);
        if (!target.volume) throw new Error(changed);
      }
      if (!record.created) {
        record = { ...record, created: target.volume.CreatedAt };
        await persist(project, record);
      }
      if (!target.container) {
        await mutate(cli, ['container', 'create', '--name', nameOf(record), '--label', label + '=' + record.key, '--network', 'bridge',
          '--publish', host + ':' + record.port + ':5432', '--mount', 'type=volume,src=' + volumeName(record) + ',dst=' + data,
          '--env', 'POSTGRES_DB=' + record.name, '--env', 'POSTGRES_USER=' + user, '--env', 'POSTGRES_PASSWORD', image],
        { timeout: 180000, password: randomBytes(24).toString('hex') });
        target = await owned(cli, record);
      }
      if (!target.container) throw new Error(changed);
      if (!record.container) {
        record = { ...record, container: target.container };
        await persist(project, record);
      }
      if (target.status !== 'running') {
        await resolveStartup(project, []);
        await mutate(cli, ['container', 'start', target.container]);
      }
    } else if (mode === 'stop' && target.container && target.status === 'running') {
      await mutate(cli, ['container', 'stop', target.container], { timeout: 30000 });
    } else if (mode === 'delete') {
      if (payload.confirm !== volumeName(record) || (target.container && !['created', 'exited'].includes(target.status))) {
        throw new Error('Stop PostgreSQL and type the exact volume name to delete its data.');
      }
      await verifyShared(project, { host, port: record.port, engine: 'postgres' });
      await persist(project, { ...record, deleting: true });
      target = await owned(cli, record);
      if (target.container) await mutate(cli, ['container', 'rm', target.container]);
      if ((await owned(cli, record)).volume) await mutate(cli, ['volume', 'rm', volumeName(record)]);
      if (Object.values(await owned(cli, record)).some(Boolean)) throw new Error(changed);
      await persist(project, undefined);
    } else if (mode === 'save') {
      const requirement = (await connections(project)).find(item => item.id === payload.requirementId);
      if (!requirement || requirement.revision !== payload.revision || !await ready(cli, record, target)) {
        throw new Error('Choose a detected connection variable and wait for project PostgreSQL to be ready.');
      }
      const config = await inspectDocker(cli, 'container', target.container, '{{json .Config.Env}}');
      const passwords = config?.filter(entry => /^POSTGRES_PASSWORD=[a-f\d]{48}$/.test(entry));
      if (passwords?.length !== 1) throw new Error(changed);
      const password = passwords[0].slice('POSTGRES_PASSWORD='.length);
      const result = await saveDatabaseEnvironment(project, { requirementId: requirement.id, revision: requirement.revision,
        value: 'postgresql://' + user + ':' + password + '@' + host + ':' + record.port + '/' + record.name }, signal);
      return result;
    }
    return { changed: true };
  }

  return { inspect, action, async guardRemoval(project) {
    await registry.ready;
    if (current(project)) throw new Error('Delete the dedicated PostgreSQL volume before removing this project.');
  } };
}
