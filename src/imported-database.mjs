import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { resolveStartup } from './project-startup.mjs';
import { composeProjectLabel as projectLabel, composeServiceLabel as serviceLabel, composeVolumeLabel as volumeLabel,
  databaseDataDirectory, databaseDockerEnvironment, databaseImageEngine, databaseMountMatches, databaseSecretTargets, pinnedDatabaseCompose,
  verifyComposeDatabaseStartup, verifyExistingDatabaseStartup } from './database-compose.mjs';

const composeFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const composeOverrides = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];
const ownershipLabel = 'io.stackforge.imported-compose-id';
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
  const env = databaseDockerEnvironment();
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
  const candidates = Object.entries(model.services ?? {}).filter(([, service]) => databaseImageEngine(service?.image));
  if (candidates.length !== 1) throw new Error('Compose database management requires one official MySQL or PostgreSQL service.');
  const [[service, spec]] = candidates;
  const engine = databaseImageEngine(spec.image);
  const [mount, ...extra] = spec.volumes ?? [];
  const volume = model.volumes?.[mount?.source];
  const name = volume?.name;
  const dataDirectory = databaseDataDirectory(spec.image, engine);
  const secretTargets = databaseSecretTargets(spec, model);
  const validTarget = mount?.target === dataDirectory;
  if (!resourceName.test(model.name ?? '') || !resourceName.test(service) || !resourceName.test(name ?? '') || !resourceName.test(mount?.source ?? '') ||
      !secretTargets || extra.length || mount?.type !== 'volume' || mount.read_only || mount.volume?.subpath || !validTarget ||
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
          databaseImageEngine(JSON.parse(image)) !== engine) throw new Error(notOwned);
      const mounts = JSON.parse(rawMounts);
      if (!Array.isArray(mounts) || !databaseMountMatches(mounts, name, mount.target, secretTargets)) throw new Error(notOwned);
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

  return { engine, container, config, environment: spec.environment, async start(options) {
    await verifyComposeDatabaseStartup(spec, engine, model, cwd);
    if (container) {
      if (!['running', 'starting', 'unhealthy'].includes(container.status)) {
        await verifyExistingDatabaseStartup(docker, container.id, engine);
        await resolveStartup(project, [], identity);
        await command('docker', ['container', 'start', container.id], { ...config, ...options });
      }
      return;
    }
    if (!exists) {
      await docker(['volume', 'create', '--driver', 'local', '--label', `${projectLabel}=${model.name}`, '--label', `${volumeLabel}=${mount.source}`,
        '--label', `${ownershipLabel}=${owner}`, name]);
      await verifyVolume(true);
    }
    // The volume is already verified. Mark it external in this pinned invocation so
    // Compose cannot recreate it or reinterpret the original project file.
    const input = pinnedDatabaseCompose(model, service, mount, name, { [ownershipLabel]: owner });
    await resolveStartup(project, [], identity);
    await command('docker', ['compose', '--project-directory', cwd, '-p', model.name, '-f', '-', 'up', '-d', '--wait', '--no-deps', '--no-recreate', service],
      { ...config, ...options, input, log: () => {} });
    if (!(await inspectImportedDatabase(project, command, options.signal)).container) throw new Error(notOwned);
  } };
}
