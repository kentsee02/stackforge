import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { resolveStartup } from './project-startup.mjs';

const composeFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const composeOverrides = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];
const ownershipLabel = 'io.stackforge.imported-compose-id';
const projectLabel = 'com.docker.compose.project';
const serviceLabel = 'com.docker.compose.service';
const volumeLabel = 'com.docker.compose.volume';
const notOwned = 'The imported database container or volume could not be verified.';
const dockerId = /^[a-f0-9]{64}$/;
const resourceName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

async function composePaths(root, names = composeFiles) {
  const files = await Promise.all(names.map(async file => {
    const path = join(root, file);
    return (await lstat(path).catch(() => null))?.isFile() ? path : undefined;
  }));
  return files.filter(Boolean);
}

export async function hasImportedCompose(project) {
  return Boolean(project.unmanaged && (await composePaths(project.path)).length);
}

function engineOf(image) {
  return typeof image === 'string' ? /^(?:(?:docker\.io\/)?library\/|docker\.io\/)?(mysql|postgres)(?::[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/.exec(image)?.[1] : undefined;
}

async function matchesPath(value, expected) {
  if (typeof value !== 'string' || !isAbsolute(value)) return false;
  const actual = await realpath(value).catch(() => null);
  return actual !== null && relative(expected, actual) === '';
}

export async function inspectImportedDatabase(project, command, signal) {
  const expected = project.folderIdentity ?? project.cloneIdentity ?? project.startup?.identity;
  if (!expected) throw new Error('Re-import this project to verify ownership of its Compose database.');
  const { root: cwd, identity } = await resolveStartup(project, [], expected);
  const paths = await composePaths(cwd);
  if (!paths.length) throw new Error('This project has no database.');
  if (paths.length !== 1 || (await composePaths(cwd, composeOverrides)).length) throw new Error('More than one Compose file was found. Keep one root Compose file for database management.');
  const [path] = paths;
  const compose = ['compose', '--project-directory', cwd, '-f', path];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COMPOSE_(?:FILE|ENV_FILES|PROJECT_NAME|PROFILES|DISABLE_ENV_FILE)$/i.test(key)));
  const config = { cwd, env, signal };
  const docker = args => command('docker', args, { ...config, stdoutOnly: true, timeout: 15000, stdoutLimit: 512 * 1024 });
  const ids = async args => {
    const result = (await docker(args)).trim().split(/\r?\n/).filter(Boolean);
    if (result.length > 48 || !result.every(id => dockerId.test(id))) throw new Error(notOwned);
    return result;
  };
  let model;
  try { model = JSON.parse(await docker([...compose, 'config', '--format', 'json'])); }
  catch (error) {
    if (error.name === 'AbortError' || /(?:ENOENT|docker daemon|dockerDesktop|cannot connect)/i.test(error.message)) throw error;
    throw new Error('The database Compose configuration could not be read. Check the Compose file and .env.');
  }
  const candidates = Object.entries(model.services ?? {}).filter(([, service]) => engineOf(service?.image));
  if (candidates.length !== 1) throw new Error('Compose database management requires one official MySQL or PostgreSQL service.');
  const [[service, spec]] = candidates;
  const engine = engineOf(spec.image);
  const [mount, ...extra] = spec.volumes ?? [];
  const volume = model.volumes?.[mount?.source];
  const name = volume?.name;
  const major = /\bpostgres:(\d+)/.exec(spec.image)?.[1];
  const dataDirectory = engine === 'mysql' ? '/var/lib/mysql' : major && Number(major) < 18 ? '/var/lib/postgresql/data' : '/var/lib/postgresql';
  const validTarget = mount?.target === dataDirectory;
  if (!resourceName.test(model.name ?? '') || !resourceName.test(service) || !resourceName.test(name ?? '') || !resourceName.test(mount?.source ?? '') ||
      extra.length || mount?.type !== 'volume' || mount.read_only || mount.volume?.subpath || !validTarget ||
      volume.external || volume.driver_opts || (volume.driver && volume.driver !== 'local') || spec.container_name || spec.build || spec.profiles?.length ||
      (spec.scale !== undefined && spec.scale !== 1) || (spec.deploy?.replicas !== undefined && spec.deploy.replicas !== 1) ||
      spec.privileged || spec.volumes_from?.length || spec.devices?.length || spec.cap_add?.length || /^(?:host|service:|container:)/.test(spec.network_mode ?? '') || spec.pid === 'host' || spec.ipc === 'host') {
    throw new Error('Imported databases require a dedicated, Compose-managed data volume and a standard database service.');
  }
  if (Object.entries(model.services).some(([key, item]) => key !== service && item.volumes?.some(other => other.type === 'volume' && model.volumes?.[other.source]?.name === name))) {
    throw new Error('The database volume is shared with another container.');
  }
  const owner = createHash('sha256').update(JSON.stringify([identity, path, model.name, service, name])).digest('hex');
  const list = ['ps', '--all', '--quiet', '--no-trunc', '--filter'];
  const projectIds = await ids([...list, `label=${projectLabel}=${model.name}`]);
  const matching = [];
  if (projectIds.length) {
    const format = '{{.Id}}\t{{json .Config.Labels}}\t{{json .Config.Image}}\t{{json .State}}\t{{json .Mounts}}';
    const lines = (await docker(['inspect', '--type', 'container', '--format', format, ...projectIds])).trim().split(/\r?\n/);
    if (lines.length !== projectIds.length) throw new Error(notOwned);
    for (const line of lines) {
      const [id, rawLabels, image, rawState, rawMounts] = line.split('\t');
      const labels = JSON.parse(rawLabels);
      if (!projectIds.includes(id) || labels?.[projectLabel] !== model.name || !await matchesPath(labels['com.docker.compose.project.working_dir'], cwd)) throw new Error(notOwned);
      if (labels[serviceLabel] !== service) continue;
      if (labels['com.docker.compose.oneoff']?.toLowerCase() === 'true' ||
          (labels[ownershipLabel] ? labels[ownershipLabel] !== owner : !await matchesPath(labels['com.docker.compose.project.config_files'], path)) ||
          engineOf(JSON.parse(image)) !== engine) throw new Error(notOwned);
      const mounts = JSON.parse(rawMounts);
      if (mounts?.length !== 1 || !mounts.some(item => item.Type === 'volume' && item.Name === name && item.Destination === mount.target && item.RW === true)) throw new Error(notOwned);
      const state = JSON.parse(rawState);
      const status = state.Status === 'running' && ['starting', 'unhealthy'].includes(state.Health?.Status) ? state.Health.Status : state.Status;
      matching.push({ id, status });
    }
  }
  if (matching.length > 1) throw new Error(notOwned);
  const [container] = matching;
  const names = (await docker(['volume', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'])).trim().split(/\r?\n/);
  const exists = names.includes(name);
  const verifyVolume = async (mustHaveOwner = !container) => {
    const [driver, options, labels] = (await docker(['volume', 'inspect', '--format', '{{json .Driver}}\t{{json .Options}}\t{{json .Labels}}', name])).trim().split('\t').map(value => JSON.parse(value));
    if (driver !== 'local' || Object.keys(options ?? {}).length || labels?.[projectLabel] !== model.name || labels[volumeLabel] !== mount.source ||
        ((mustHaveOwner || labels[ownershipLabel]) && labels[ownershipLabel] !== owner)) throw new Error(notOwned);
    const users = await ids([...list, `volume=${name}`]);
    if (users.some(id => id !== container?.id) || (container && !users.includes(container.id))) throw new Error('The database volume is shared with another container.');
  };
  if (exists) await verifyVolume();
  else if (container) throw new Error(notOwned);
  await resolveStartup(project, [], identity);

  return { engine, container, config, async start(options) {
    if (container) {
      if (!['running', 'starting', 'unhealthy'].includes(container.status)) await command('docker', ['container', 'start', container.id], { ...config, ...options });
      return;
    }
    if (!exists) {
      await docker(['volume', 'create', '--driver', 'local', '--label', `${projectLabel}=${model.name}`, '--label', `${volumeLabel}=${mount.source}`,
        '--label', `${ownershipLabel}=${owner}`, name]);
      await verifyVolume(true);
    }
    // The volume is already verified. Mark it external in this pinned invocation so
    // Compose cannot recreate it or reinterpret the original project file.
    const pinned = { ...model, volumes: { [mount.source]: { external: true, name } },
      services: { [service]: { ...spec, depends_on: undefined, links: undefined, env_file: undefined,
        labels: { ...spec.labels, [ownershipLabel]: owner } } } };
    const input = Buffer.from(JSON.stringify(pinned));
    await resolveStartup(project, [], identity);
    await command('docker', ['compose', '--project-directory', cwd, '-p', model.name, '-f', '-', 'up', '-d', '--wait', '--no-deps', '--no-recreate', service],
      { ...config, ...options, input, log: () => {} });
    if (!(await inspectImportedDatabase(project, command, options.signal)).container) throw new Error(notOwned);
  } };
}
