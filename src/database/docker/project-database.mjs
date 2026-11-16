import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { throwIfCancelled } from '../../platform/process.mjs';
import { directoryIdentity, sameDirectory } from '../../platform/project-identity.mjs';
import { projectPathKey } from '../../projects/project-config.mjs';
import { inspectRecordedProject } from '../../projects/project-folder.mjs';
import { databaseReady, databaseTransferCapabilities, transferDatabase } from '../backup/docker-transfer.mjs';
import { addContainerSecretFiles, databaseRedactor, databaseSecretFiles } from '../security/secrets.mjs';
import { inspectImportedDatabase } from './imported-database.mjs';
import { composeProjectLabel, composeServiceLabel, composeVolumeLabel, databaseDataDirectory, databaseDockerEnvironment, databaseEndpoints,
  databaseImageEngine, databaseMountMatches, databaseSecretTargets, databaseStartupRestricted, pinnedDatabaseCompose, verifyComposeDatabaseStartup,
  verifyExistingDatabaseStartup } from './compose.mjs';

const logLimit = 64 * 1024;
// Compose probes can take several seconds while Docker Desktop is busy.
const dockerProbeTimeout = 15_000;
const databaseLabel = 'io.stackforge.database-id';
const legacyDatabaseLabel = 'io.stackforge.legacy-database-id';
const unverifiedDatabase = 'The database volume could not be verified as belonging to this project.';
const composeStatusFormat = [
  '{{.Id}}', '{{json .Config.Labels}}', '{{json .Config.Image}}',
  '{{.State.Status}}',
  '{{if .State.Health}}{{.State.Health.Status}}{{end}}', '{{json .Mounts}}', '{{json .HostConfig.PortBindings}}'
].join('\t');

async function databaseOptions(project, ports, info) {
  if (project.database === 'none') throw new Error('This project has no database.');
  const { directory, manifest } = info ?? await inspectRecordedProject(project);
  const composeFile = join(directory, 'compose.yaml');
  const file = await lstat(composeFile).catch(() => null);
  if (!file?.isFile()) throw new Error('The project is missing its compose.yaml file.');
  const overrides = await Promise.all(['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml']
    .map(name => lstat(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; })));
  if (overrides.some(Boolean)) throw new Error('More than one Compose file was found. Keep one root Compose file for database management.');
  const env = { ...databaseDockerEnvironment(), STACKFORGE_DATABASE_PORT: '' };
  try {
    const local = parseEnv(await readFile(join(directory, '.env'), 'utf8'));
    if (Object.keys(local).some(key => /^DOCKER_/i.test(key) || /^COMPOSE_(?!PROJECT_NAME$)/i.test(key))) {
      throw new Error('Project environment overrides for Docker or Compose are not supported for database management.');
    }
    Object.assign(env, local);
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = ports.database ?? env.STACKFORGE_DATABASE_PORT;
  if (manifest.portConfig === 1 && port) env.DB_PORT = String(port);
  return { cwd: directory, env, composeFile };
}

export class ProjectDatabase {
  constructor(command) { this.command = command; }

  async databaseContainers(config, modelName, engine, docker) {
    const ids = (await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${composeProjectLabel}=${modelName}`])).trim().split(/\r?\n/).filter(Boolean);
    if (!ids.length) return [];
    if (ids.length > 48 || new Set(ids).size !== ids.length || !ids.every(id => /^[a-f0-9]{64}$/.test(id))) {
      throw new Error('Docker returned an unexpected container identifier.');
    }
    const details = await docker(['inspect', '--type', 'container', '--format', composeStatusFormat, ...ids]);
    const lines = details.trimEnd().split(/\r?\n/);
    if (lines.length !== ids.length) throw new Error('Docker returned an unexpected container identifier.');
    const containers = [];
    const inspected = new Set();
    for (const line of lines) {
      const [id, rawLabels, image, state, health, mounts, portBindings] = line.split('\t');
      if (!ids.includes(id) || inspected.has(id)) throw new Error('Docker returned an unexpected container identifier.');
      inspected.add(id);
      const labels = JSON.parse(rawLabels);
      const path = labels?.['com.docker.compose.project.working_dir'];
      const owner = path && await realpath(path).catch(() => null);
      if (labels?.[composeProjectLabel] !== modelName || !owner || projectPathKey(owner) !== projectPathKey(config.cwd)) {
        throw new Error('This Compose database belongs to another project folder.');
      }
      if (labels[composeServiceLabel] !== 'db') continue;
      if (labels['com.docker.compose.oneoff']?.toLowerCase() === 'true' || databaseImageEngine(JSON.parse(image)) !== engine) {
        throw new Error(unverifiedDatabase);
      }
      containers.push({ id, status: state === 'running' && ['unhealthy', 'starting'].includes(health) ? health : state,
        mounts: JSON.parse(mounts) ?? [], portBindings: JSON.parse(portBindings ?? 'null') ?? {} });
    }
    if (containers.length > 1) throw new Error(unverifiedDatabase);
    return containers;
  }

  async containerLogRedactor(config, { id, status }, redact = databaseRedactor(config.env)) {
    const docker = (args, options) => this.command('docker', args, { ...config, ...options });
    try {
      const probe = await docker(['inspect', '--type', 'container', '--format', '{{json .Config.Env}}', id],
        { stdoutOnly: true, timeout: dockerProbeTimeout, stdoutLimit: 512 * 1024 });
      const env = (JSON.parse(probe) ?? []).flatMap(entry => {
        const split = entry.indexOf('=');
        return split > 0 ? [[entry.slice(0, split), entry.slice(split + 1)]] : [];
      });
      const environment = Object.fromEntries(env);
      redact.add(environment);
      await addContainerSecretFiles(redact, environment, docker, id, status);
      return redact;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Could not verify database log redaction.');
    }
  }

  async databaseLogs(config, container) {
    const redact = await this.containerLogRedactor(config, container);
    let output = '';
    let truncated = false;
    await this.command('docker', ['logs', '--tail', '100', container.id], { ...config, timeout: dockerProbeTimeout, log: chunk => {
      output += chunk;
      if (output.length > logLimit) {
        output = output.slice(-logLimit);
        truncated = true;
      }
    } }).catch(error => {
      error.message = redact.text(error.message);
      throw error;
    });
    const firstLineEnd = output.indexOf('\n');
    if (truncated) output = firstLineEnd < 0 ? '' : output.slice(firstLineEnd + 1);
    return redact.text(output);
  }

  async database(project, ports, logs = false, includeCapabilities = false, selection) {
    const { config, container, engine, volume, verifyStartup, endpoints } = await this.databaseTarget(project, ports, undefined, selection);
    const status = ['exited', 'created', 'dead'].includes(container?.status) ? 'stopped' : container?.status ?? 'absent';
    const state = { ...(project.unmanaged && { engine }), status };
    if (status === 'running' && !await databaseReady({ engine, container: container.id, config, command: this.command })) state.status = 'starting';
    if (logs && container) state.log = await this.databaseLogs(config, container);
    if (includeCapabilities) {
      let start = ['absent', 'stopped'].includes(state.status);
      if (start && verifyStartup) {
        try { await verifyStartup(); }
        catch (error) {
          start = false;
          if (error.code === databaseStartupRestricted) state.startHint = error.message;
          else throw error;
        }
      }
      const transfers = state.status === 'running' ?
        await databaseTransferCapabilities({ engine, container: container.id, config, command: this.command }) : { backup: false, restore: false };
      state.ownership = project.unmanaged ? 'verified' : 'managed';
      state.capabilities = { start, stop: Boolean(container && state.status !== 'stopped'), logs: Boolean(container),
        ...transfers,
        delete: !project.unmanaged && Boolean(volume) && ['stopped', 'absent'].includes(state.status) };
      state.endpoints = endpoints;
    }
    return state;
  }

  async databaseTarget(project, ports, signal, selection) {
    if (project.unmanaged) return inspectImportedDatabase(project, this.command, signal, selection);
    const info = await inspectRecordedProject(project);
    const target = await this.verifiedManagedDatabase(project, ports, info, signal);
    return { ...target, engine: project.database, container: target.containers[0] };
  }

  async changeDatabase(project, action, ports, options) {
    const selection = options.chooseDatabase ? await options.chooseDatabase() : options.databaseSelection;
    const { config, container, start, environment } = await this.databaseTarget(project, ports, options.signal, selection);
    options.addDatabaseSecrets?.(config.env);
    options.addDatabaseSecrets?.(environment);
    throwIfCancelled(options.signal);
    if (action === 'database-start') {
      if (!databaseSecretFiles(environment).length) return start(options);
      // A fresh container may not exist yet, so never stream unresolved file-backed credentials.
      try { return await start({ ...options, log: () => {} }); }
      catch (error) {
        if (error.name === 'AbortError' || error.code === databaseStartupRestricted) throw error;
        throw new Error('Database startup failed. Check the database configuration and its logs.');
      }
    }
    else if (container && !['created', 'exited', 'dead'].includes(container.status)) {
      await this.command('docker', ['container', 'stop', container.id], { ...config, ...options });
    }
  }

  async databaseBackup(project, ports, file, signal) {
    const { config, container, engine } = await this.databaseTarget(project, ports, signal);
    if (container?.status !== 'running') throw new Error('Start the project database before backing it up or restoring it.');
    return transferDatabase({ engine, project: project.name, container: container.id,
      config, command: this.command, file, signal });
  }

  async verifiedManagedDatabase(project, ports, info, signal) {
    const config = await databaseOptions(project, ports, info);
    const docker = args => this.command('docker', args, {
      ...config, signal, timeout: dockerProbeTimeout, stdoutOnly: true, stdoutLimit: 128 * 1024
    });
    let model;
    const compose = ['compose', '--project-directory', config.cwd, '-f', config.composeFile];
    try { model = JSON.parse(await docker([...compose, 'config', '--format', 'json'])); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('The database Compose configuration could not be read. Check compose.yaml and .env before retrying.');
    }
    const spec = model.services?.db;
    const mounts = spec?.volumes ?? [];
    const [mount] = mounts;
    const volume = model.volumes?.[mount?.source];
    const name = volume?.name;
    const secretTargets = spec && databaseSecretTargets(spec, model);
    if (databaseImageEngine(spec?.image) !== project.database || !/^[a-z0-9][a-z0-9_-]*$/.test(model.name ?? '') ||
        !secretTargets || mounts.length !== 1 || mount?.type !== 'volume' || mount.read_only || mount.volume?.subpath ||
        mount.target !== databaseDataDirectory(spec.image, project.database) || volume?.external || volume?.driver_opts ||
        (volume?.driver && volume.driver !== 'local') || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name ?? '')) {
      throw new Error('This operation requires a dedicated, Compose-managed database volume.');
    }
    for (const [service, options] of Object.entries(model.services)) {
      if (service !== 'db' && options.volumes?.some(item => item.type === 'volume' && model.volumes?.[item.source]?.name === name)) {
        throw new Error('The database volume is shared with another container.');
      }
    }
    const containers = await this.databaseContainers(config, model.name, project.database, docker);
    if (containers.some(container => !databaseMountMatches(container.mounts, name, mount.target, secretTargets))) {
      throw new Error(unverifiedDatabase);
    }
    const names = (await docker(['volume', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'])).trim().split(/\r?\n/);
    const exists = names.includes(name);
    if (!exists && containers.length) throw new Error(unverifiedDatabase);
    const inspectVolume = () => docker(['volume', 'inspect', '--format', '{{json .CreatedAt}}\t{{json .Labels}}\t{{json .Driver}}\t{{json .Options}}', name]);
    const stat = await lstat(config.cwd, { bigint: true });
    const folder = directoryIdentity(stat);
    if (!folder || project.folderIdentity && !sameDirectory(stat, project.folderIdentity)) throw new Error(unverifiedDatabase);
    const databaseId = info.manifest.databaseId;
    if (databaseId !== undefined && !/^[a-f0-9]{24}$/.test(databaseId)) throw new Error(unverifiedDatabase);
    const legacyId = createHash('sha256').update(JSON.stringify([folder, config.cwd, model.name, name])).digest('hex');
    const owner = databaseId ? [databaseLabel, databaseId] : [legacyDatabaseLabel, legacyId];
    async function verifyVolume(expectedContainers, allowLegacy) {
      const details = (await inspectVolume()).trim();
      const [createdAt, labels, driver, options] = details.split('\t').map(value => JSON.parse(value));
      const projectCreated = Math.floor(Date.parse(info.manifest.createdAt) / 1000) * 1000;
      const legacyMatch = allowLegacy && !databaseId && !labels?.[databaseLabel] && !labels?.[legacyDatabaseLabel] &&
        expectedContainers.length && Date.parse(createdAt) >= projectCreated;
      if (driver !== 'local' || Object.keys(options ?? {}).length || labels?.[composeProjectLabel] !== model.name ||
          labels?.[composeVolumeLabel] !== mount.source || (labels?.[owner[0]] !== owner[1] && !legacyMatch)) {
        throw new Error(unverifiedDatabase);
      }
      const users = (await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `volume=${name}`])).trim().split(/\r?\n/).filter(Boolean);
      if (users.some(id => !expectedContainers.some(container => id === container.id))) {
        throw new Error('The database volume is shared with another container.');
      }
      if (expectedContainers.some(container => !users.includes(container.id))) throw new Error(unverifiedDatabase);
      return details;
    }
    const details = exists && await verifyVolume(containers, true);
    const [container] = containers;
    const endpoints = databaseEndpoints(spec, container, project.database);
    const verifyFolder = async () => {
      await inspectRecordedProject(project);
      if (!sameDirectory(await lstat(config.cwd, { bigint: true }), folder)) throw new Error(unverifiedDatabase);
    };
    await verifyFolder();
    const verifyStartup = async () => {
      await verifyComposeDatabaseStartup(spec, project.database, model, config.cwd);
      if (container) await verifyExistingDatabaseStartup(docker, container.id, project.database);
      await verifyFolder();
    };
    return {
      config, containers, docker, volume: exists ? name : undefined, environment: spec.environment,
      endpoints, verifyStartup,
      async verifyLauncher() {
        if (Object.keys(model.services).length !== 1) {
          throw new Error('The StackForge launcher requires a Compose file with only the database service.');
        }
        await verifyStartup();
      },
      async recheckVolume() {
        if ((await inspectVolume()).trim() !== details) throw new Error(unverifiedDatabase);
      },
      start: async options => {
        await verifyStartup();
        if (container) {
          if (!['running', 'starting', 'unhealthy'].includes(container.status)) {
            await this.command('docker', ['container', 'start', container.id], { ...config, ...options });
          }
          return;
        }
        await verifyFolder();
        if (!exists) await docker(['volume', 'create', '--driver', 'local', '--label', `${composeProjectLabel}=${model.name}`,
          '--label', `${composeVolumeLabel}=${mount.source}`, '--label', owner.join('='), name]);
        await verifyVolume([], false);
        await verifyFolder();
        const input = pinnedDatabaseCompose(model, 'db', mount, name);
        await this.command('docker', ['compose', '--project-directory', config.cwd, '-p', model.name, '-f', '-', 'up', '-d', '--wait',
          '--no-deps', '--no-recreate', 'db'], { ...config, ...options, input });
        const verified = await this.verifiedManagedDatabase(project, ports, info, signal);
        if (!verified.containers.length) throw new Error(unverifiedDatabase);
      }
    };
  }

  async databaseDeletionTarget(project, ports, signal) {
    if (project.unmanaged) throw new Error('This action requires a StackForge project.');
    const info = await inspectRecordedProject(project);
    const target = await this.verifiedManagedDatabase(project, ports, info, signal);
    if (!target.volume) throw new Error('There is no project database volume to delete.');
    if (target.containers.some(container => !['exited', 'created', 'dead'].includes(container.status))) {
      throw new Error('Stop the database before deleting its data volume.');
    }
    return target;
  }

  async removeDatabase(project, ports, confirmVolume, signal, verifyDeletion) {
    const target = await this.databaseDeletionTarget(project, ports, signal);
    const { containers, docker, volume, recheckVolume } = target;
    if (confirmVolume !== volume) throw new Error('Enter the exact volume name to confirm database deletion.');
    await verifyDeletion?.(target);
    await inspectRecordedProject(project);
    await recheckVolume();
    throwIfCancelled(signal);
    try {
      if (containers.length) await docker(['container', 'rm', ...containers.map(container => container.id)]);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Docker could not finish deleting the database. Check that Docker is running and retry.');
    }
    await recheckVolume();
    throwIfCancelled(signal);
    try { await docker(['volume', 'rm', volume]); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Docker could not finish deleting the database. Check that Docker is running and retry.');
    }
  }
}
