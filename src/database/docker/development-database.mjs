import { randomBytes } from 'node:crypto';
import { run, throwIfCancelled } from '../../platform/process.mjs';
import { portAvailable } from '../../platform/ports.mjs';
import { resolveStartup } from '../../projects/project-startup.mjs';
import { databasePortOpen } from '../adapters/local.mjs';
import { databaseKey, discoverDatabases } from '../discovery.mjs';
import { mysqlEnvironmentOption, saveDatabaseEnvironment, saveMysqlEnvironment } from '../environment.mjs';
import { developmentOptions } from '../development-setup.mjs';
import { databaseReady, databaseTransferCapabilities } from '../backup/docker-transfer.mjs';

const user = 'stackforge';
const host = '127.0.0.1';
const engines = {
  postgres: { prefix: 'stackforge-pg-', image: 'docker.io/library/postgres:17', data: '/var/lib/postgresql/data', port: 5432,
    label: 'io.stackforge.development-postgres', password: 'POSTGRES_PASSWORD', cli: 'psql', scheme: 'postgresql' },
  mysql: { prefix: 'stackforge-mysql-', image: 'docker.io/library/mysql:8.4', data: '/var/lib/mysql', port: 3306,
    label: 'io.stackforge.development-mysql', password: 'MYSQL_PASSWORD', cli: 'mysql', scheme: 'mysql' }
};
const engineOf = record => record.engine ?? 'postgres';
const detailsOf = record => Object.hasOwn(engines, engineOf(record)) ? engines[engineOf(record)] : undefined;
const changed = 'The development database container or volume could not be verified.';
const stale = 'The development database plan changed. Preview it again.';
const unavailable = 'Start a local Docker Engine 28 or newer in Linux container mode.';
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const containerId = /^[a-f\d]{64}$/;
const id = /^[a-f\d]{32}$/;
const validName = name => typeof name === 'string' && /^[a-z][a-z\d_]{0,62}$/.test(name) &&
  !['postgres', 'template0', 'template1', 'mysql', 'information_schema', 'performance_schema', 'sys'].includes(name);
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
      throw new Error('Choose a free port for the development database.');
    }
    if (/volume is in use/i.test(error.message)) throw new Error('Another Docker container still uses this database volume.');
    throw new Error('Docker could not finish the database operation. Check Docker Desktop or Docker Engine and retry.');
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
    const cli = (args, { extraEnv, signal: operationSignal = signal, ...options } = {}) =>
      command('docker', ['--host', endpoint, ...args], {
        ...base, ...options, signal: operationSignal, env: { ...env, ...extraEnv }
      });
    const [daemon, version, os] = JSON.parse(await cli(['info', '--format', '[{{json .ID}},{{json .ServerVersion}},{{json .OSType}}]']));
    if (!daemon || os !== 'linux' || Number(version?.split('.')[0]) < 28 || !/^\d+\./.test(version)) throw new Error();
    return { cli, daemon };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(unavailable);
  }
}

const nameOf = record => detailsOf(record).prefix + record.key;
const volumeName = record => nameOf(record) + '-data';

async function inspectDocker(cli, kind, name, format = '{{json .}}') {
  try { return JSON.parse(await cli([kind, 'inspect', '--format', format, name])); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    if (/No such (?:container|object|volume)\b/i.test(error.message)) return;
    throw new Error(changed);
  }
}

async function owned(cli, record) {
  const { label, port: servicePort, image, data } = detailsOf(record);
  const socket = servicePort + '/tcp';
  const volume = await inspectDocker(cli, 'volume', volumeName(record));
  if (volume && (volume.Name !== volumeName(record) || volume.Labels?.[label] !== record.key ||
      volume.Driver !== 'local' || volume.Scope !== 'local' || Object.keys(volume.Options ?? {}).length ||
      !volume.CreatedAt || record.created && record.created !== volume.CreatedAt)) throw new Error(changed);
  // Select only the required fields. Full container inspection includes credentials.
  const container = await inspectDocker(cli, 'container', nameOf(record), '[' +
    ['.Id', '.Config.Labels', '.Config.Image', '.State.Status', '.Mounts', '.HostConfig.PortBindings', '.HostConfig.NetworkMode', '.NetworkSettings.Ports']
      .map(field => '{{json ' + field + '}}').join(',') + ']');
  if (!container) return { volume };
  const [identity, labels, configuredImage, status, mounts, bindings, network, published] = container;
  const [port] = bindings?.[socket] ?? [];
  const [mount] = mounts ?? [];
  if (!volume || !containerId.test(identity) || record.container && record.container !== identity ||
      labels?.[label] !== record.key || configuredImage !== image || network !== 'bridge' ||
      mounts?.length !== 1 || mount?.Type !== 'volume' || mount.Name !== volume.Name || mount.Destination !== data || !mount.RW ||
      Object.keys(bindings ?? {}).length !== 1 || bindings[socket]?.length !== 1 || port.HostIp !== host ||
      port.HostPort !== String(record.port)) throw new Error(changed);
  const actual = published?.[socket];
  const publishedOnLoopback = actual?.length === 1 && actual[0].HostIp === host && actual[0].HostPort === String(record.port);
  return { volume, container: identity, status, publishedOnLoopback };
}

async function ready(cli, record, target) {
  if (target.status !== 'running') return false;
  if (engineOf(record) === 'mysql') return databaseReady({ engine: 'mysql', container: target.container, command: (_, args, options) => cli(args, options) });
  try {
    const result = await cli(['exec', target.container, 'sh', '-c',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -XAtw -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT current_database()"']);
    return result.trim() === record.name;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return false;
  }
}

async function connections(project, directory, engine = 'postgres') {
  const { root, requirements, connections: values } = await discoverDatabases(project, { includeConnections: true });
  const matching = requirements.filter(item => item.engine === engine && (!item.declaredEngine || item.declaredEngine === engine) && (!directory || item.directory === directory));
  const urls = matching.filter(item => /^[A-Z_][A-Z0-9_]*$/.test(item.environmentVariable ?? '') &&
    !values.get(item.id)?.environmentConflict &&
    (item.status === 'missing' || item.status === 'placeholder' && item.environmentEdit &&
      (!item.guidedSetup || values.get(item.id)?.environmentSources?.length === 1)))
    .map(({ id, source, directory, environmentVariable, environmentEdit }) => ({ id, source, variable: environmentVariable, revision: environmentEdit?.revision,
      file: (directory === '.' ? '' : directory + '/') + (environmentEdit?.file ?? '.env') }));
  if (engine !== 'mysql') return urls;
  return [...urls, ...(await Promise.all(matching.map(item => mysqlEnvironmentOption(root, item)))).filter(Boolean)];
}

export function developmentDatabase({ registry, verifyShared, command = run, probePort = portAvailable }) {
  const salt = randomBytes(16).toString('hex');
  function assertProject(project) {
    if (!project.imported || !project.unmanaged || !uuid.test(project.id) || !project.folderIdentity) {
      throw new Error('Development databases are available for verified external imports and clones.');
    }
  }
  const owner = project => databaseKey(project.id, project.folderIdentity);
  const historyTargetId = (project, record) => databaseKey('alembic-docker', project.id, record.key);
  const archiveId = (project, record) => databaseKey('development-database', project.id, record.key);
  const current = project => registry.value.development[project.id];
  const persist = (project, record) => registry.saveDevelopment(project.id, record);
  const reserved = port => Object.values(registry.value.development).some(item => item.port === port);
  function valid(record, project, daemon) {
    if (record.daemon !== daemon || record.owner !== owner(project) || !id.test(record.key) ||
        !detailsOf(record) || !validName(record.name) || !validPort(record.port)) throw new Error(changed);
  }

  async function databasePassword(cli, container, record) {
    const config = await inspectDocker(cli, 'container', container, '{{json .Config.Env}}');
    const prefix = detailsOf(record).password + '=';
    const passwords = config?.filter(entry => entry.startsWith(prefix) && /^[a-f\d]{48}$/.test(entry.slice(prefix.length)));
    if (passwords?.length !== 1) throw new Error(changed);
    return passwords[0].slice(prefix.length);
  }

  async function historyTarget(project) {
    await registry.ready;
    const record = current(project);
    if (!record?.container || !record.created || record.deleting || engineOf(record) !== 'postgres') return;
    assertProject(project);
    valid(record, project, record.daemon);
    return { id: historyTargetId(project, record), name: record.name, port: record.port, host, projectPostgres: true };
  }
  function summary(record, target, accepting) {
    const status = target.status === 'running' ? accepting ? 'ready' : 'starting' :
      record.deleting || !target.container ? 'incomplete' : 'stopped';
    return { host, engine: engineOf(record), name: record.name, port: record.port, volume: volumeName(record), status,
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
      let mysqlPort = 53306;
      while (reserved(mysqlPort) && mysqlPort < 65535) mysqlPort++;
      return { status: 'absent', port, mysqlPort, ...await developmentOptions(project, Object.keys(engines)) };
    }
    const { cli, daemon } = await dockerSession(command, signal);
    valid(record, project, daemon);
    const target = await owned(cli, record);
    const accepting = await ready(cli, record, target);
    const options = accepting ? await connections(project, record.directory, engineOf(record)).catch(() => []) : [];
    const archive = accepting && engineOf(record) === 'mysql' ? await archiveTarget(project, archiveId(project, record), signal) : undefined;
    const capabilities = archive && await databaseTransferCapabilities({ ...archive, container: archive.container.id });
    return { ...summary(record, target, accepting), connections: options,
      ...(archive && { archive: { id: archiveId(project, record), ...capabilities } }) };
  }

  async function client(project, endpoint, signal, expectedTargetId) {
    await registry.ready;
    const record = current(project);
    if (!record || endpoint.engine !== engineOf(record) || endpoint.host !== host ||
        endpoint.port !== record.port || endpoint.name !== record.name) return;
    if (expectedTargetId && historyTargetId(project, record) !== expectedTargetId) throw new Error(changed);
    assertProject(project);
    await resolveStartup(project, []);
    const { cli, daemon } = await dockerSession(command, signal);
    valid(record, project, daemon);
    async function verify() {
      if (!record.container || !record.created || current(project) !== record || record.deleting) throw new Error(changed);
      const target = await owned(cli, record);
      if (target.container !== record.container) throw new Error(changed);
      return target;
    }
    const target = await verify();
    return {
      async credentials() {
        const latest = await verify();
        if (latest.status !== 'running' || !latest.publishedOnLoopback) {
          throw Object.assign(new Error('Project PostgreSQL is not running.'), { code: 'container-stopped' });
        }
        return { user, password: await databasePassword(cli, latest.container, record) };
      },
      async installation(probe = databasePortOpen) {
        const serviceStatus = target.status === 'running' ? 'running' : 'stopped';
        const version = serviceStatus === 'running' ? await cli(['exec', target.container, detailsOf(record).cli, '--version']).catch(error => {
          if (error.name === 'AbortError') throw error;
          return '';
        }) : '';
        return { kind: 'project-docker', serviceStatus, clientVersion: /\b\d+\.\d+(?:\.\d+)?\b/.exec(version)?.[0],
          portOpen: serviceStatus === 'running' && Boolean(target.publishedOnLoopback) && await probe(host, record.port) };
      },
      async command(program, args, options) {
        const latest = await verify();
        if (latest.status !== 'running' || !latest.publishedOnLoopback) throw new Error('connection refused');
        const localArgs = [...args];
        if (engineOf(record) === 'mysql') {
          const targetPort = args.indexOf('--port=' + record.port);
          const database = program === 'mysqldump' ? args[args.indexOf('--') + 1] : args.find(arg => arg.startsWith('--database='))?.slice(11);
          if (!['mysql', 'mysqldump'].includes(program) || targetPort < 0 || !args.includes('--host=' + host) || database !== record.name) throw new Error(changed);
          localArgs[targetPort] = '--port=3306';
        } else {
          const targetPort = args.indexOf('-p') + 1;
          const targetHost = args.indexOf('-h') + 1;
          const database = args[args.indexOf('-d') + 1];
          if (!['psql', 'pg_dump', 'pg_restore'].includes(program) || !targetPort || !targetHost || args[targetHost] !== host ||
              args[targetPort] !== String(record.port) || database !== record.name && (program !== 'psql' || database !== 'postgres')) throw new Error(changed);
          localArgs[targetPort] = '5432';
        }
        const { env, signal: _signal, ...io } = options;
        const extraEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
          /^(?:PGPASSWORD|PGCONNECT_TIMEOUT|PGOPTIONS|PGSSLMODE|PGGSSENCMODE|MYSQL_PWD|LC_ALL)$/.test(key)));
        return cli(['exec', ...(io.input || io.inputFile ? ['-i'] : []), ...Object.keys(extraEnv).flatMap(key => ['-e', key]),
          latest.container, program, ...localArgs], { ...io, extraEnv });
      }
    };
  }

  async function archiveBinding(project, bindingId) {
    await registry.ready;
    const record = current(project);
    if (!record || engineOf(record) !== 'mysql' || bindingId !== archiveId(project, record)) return;
    return { id: bindingId, instanceId: bindingId, instance: { name: record.name, engine: 'mysql', provider: 'development' } };
  }

  async function archiveTarget(project, bindingId, signal) {
    await registry.ready;
    const record = current(project);
    if (!record || engineOf(record) !== 'mysql' || bindingId !== archiveId(project, record)) throw new Error(changed);
    const { cli, daemon } = await dockerSession(command, signal);
    async function verify() {
      await resolveStartup(project, []);
      if (record !== current(project) || record.deleting) throw new Error(changed);
      valid(record, project, daemon);
      const target = await owned(cli, record);
      if (!record.container || target.container !== record.container || target.status !== 'running' || !target.publishedOnLoopback) throw new Error(changed);
      return target;
    }
    const checked = await verify();
    return { engine: 'mysql', name: record.name, container: { id: checked.container, status: checked.status },
      endpoints: [{ host, engine: 'mysql', port: record.port, name: record.name }],
      async command(program, args, options) {
        const { container } = await verify();
        if (program !== 'docker' || args[0] !== 'exec' || args[args[1] === '-i' ? 2 : 1] !== container) throw new Error(changed);
        return cli(args, options);
      } };
  }

  async function action(project, payload, signal) {
    assertProject(project);
    await registry.ready;
    const { mode, name, port, targetId } = payload;
    if (!['preview', 'create', 'start', 'stop', 'save', 'delete'].includes(mode)) throw new Error(stale);
    const { cli, daemon } = await dockerSession(command, signal);
    let record = current(project);
    if (mode === 'preview' || mode === 'create') {
      if (record || !validName(name) || !validPort(port)) throw new Error('Choose an unused database name and a port from 1024 to 65535.');
      await resolveStartup(project, []);
      const { options } = await developmentOptions(project, Object.keys(engines));
      const selected = options.find(option => option.id === targetId && option.canCreate);
      if (!selected) throw new Error('Choose a compatible database service and refresh detection if it changed.');
      const { engine, directory } = selected;
      const settings = await connections(project, directory, engine);
      const prior = typeof payload.plan === 'string' && /^(\d{13})\.([a-f\d]{32})\.[a-f\d]{64}$/.exec(payload.plan);
      const expiry = mode === 'preview' ? String(Date.now() + 300000) : prior?.[1];
      const key = mode === 'preview' ? randomBytes(16).toString('hex') : prior?.[2];
      const plan = [expiry, key, databaseKey(salt, owner(project), daemon, name, port, selected.id, settings, expiry, key)].join('.');
      if (mode === 'create' && (!expiry || Number(expiry) <= Date.now() || payload.plan !== plan || payload.confirm !== name)) throw new Error(stale);
      if (reserved(port) || !await probePort(port)) throw new Error('Choose a free port for the development database.');
      if (mode === 'preview') return { plan, name, port, host, image: engines[engine].image, targetId, directory, engine,
        volume: volumeName({ key, engine }), connections: settings };
      throwIfCancelled(signal);
      record = { owner: owner(project), daemon, name, port, key, directory, engine };
      await persist(project, record);
    } else {
      if (!record) throw new Error(stale);
      valid(record, project, daemon);
    }
    const engine = engineOf(record);
    const { label, port: servicePort, data, image, password: passwordKey, scheme } = detailsOf(record);
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
        const variables = engine === 'mysql' ? ['MYSQL_DATABASE=' + record.name, 'MYSQL_USER=' + user, 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MYSQL_ROOT_HOST=localhost'] :
          ['POSTGRES_DB=' + record.name, 'POSTGRES_USER=' + user, 'POSTGRES_PASSWORD'];
        const extraEnv = { [passwordKey]: randomBytes(24).toString('hex'),
          ...(engine === 'mysql' && { MYSQL_ROOT_PASSWORD: randomBytes(24).toString('hex') }) };
        await mutate(cli, ['container', 'create', '--name', nameOf(record), '--label', label + '=' + record.key, '--network', 'bridge',
          '--publish', host + ':' + record.port + ':' + servicePort, '--mount', 'type=volume,src=' + volumeName(record) + ',dst=' + data,
          ...variables.flatMap(value => ['--env', value]), image,
          ...(engine === 'mysql' ? ['--log-bin-trust-function-creators=ON'] : [])],
        { timeout: 180000, extraEnv });
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
        throw new Error('Stop the database and type the exact volume name to delete its data.');
      }
      await verifyShared(project, { host, port: record.port, engine });
      await persist(project, { ...record, deleting: true });
      target = await owned(cli, record);
      if (target.container) await mutate(cli, ['container', 'rm', target.container]);
      if ((await owned(cli, record)).volume) await mutate(cli, ['volume', 'rm', volumeName(record)]);
      if (Object.values(await owned(cli, record)).some(Boolean)) throw new Error(changed);
      await persist(project, undefined);
    } else if (mode === 'save') {
      const requirement = (await connections(project, record.directory, engine)).find(item => item.id === payload.requirementId);
      if (!requirement || requirement.revision !== payload.revision || !await ready(cli, record, target)) {
        throw new Error('Choose a detected connection variable and wait for the development database to be ready.');
      }
      const password = await databasePassword(cli, target.container, record);
      if (requirement.style === 'mysql-fields') return saveMysqlEnvironment(project, { requirementId: requirement.id, revision: requirement.revision,
        host, port: record.port, name: record.name, user, password }, signal);
      const result = await saveDatabaseEnvironment(project, { requirementId: requirement.id, revision: requirement.revision,
        value: scheme + '://' + user + ':' + password + '@' + host + ':' + record.port + '/' + record.name }, signal);
      return result;
    }
    return { changed: true };
  }

  return { inspect, action, client, historyTarget, archiveTarget, archiveBinding, async guardRemoval(project) {
    await registry.ready;
    if (current(project)) throw new Error('Delete the dedicated database volume before removing this project.');
  } };
}
