import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { hasNodeBackend } from './catalog.mjs';
import { installMavenDependencies, installNodeDependencies, maven, npm, run, throwIfCancelled } from './process.mjs';
import { projectPathKey } from './project-config.mjs';
import { inspectRecordedProject, startupDiagnostic } from './project-runtime.mjs';
import { projectChecks, projectGitStatus } from './project-tools.mjs';
import { databaseReady, transferDatabase } from './database-backup.mjs';
import { addContainerSecretFiles, databaseRedactor, databaseSecretFiles } from './database-secrets.mjs';
import { resolveStartup } from './project-startup.mjs';
import { detectDependencyPlan } from './dependency-plan.mjs';
import { inspectImportedDatabase } from './imported-database.mjs';
import { directoryIdentity, sameDirectory } from './project-identity.mjs';
import { composeProjectLabel, composeServiceLabel, composeVolumeLabel, databaseDataDirectory, databaseDockerEnvironment,
  databaseImageEngine, databaseMountMatches, databaseSecretTargets, databaseStartupRestricted, pinnedDatabaseCompose, verifyComposeDatabaseStartup,
  verifyExistingDatabaseStartup } from './database-compose.mjs';

const logLimit = 64 * 1024;
// Compose probes can take several seconds while Docker Desktop is busy.
const dockerProbeTimeout = 15_000;
const databaseLabel = 'io.stackforge.database-id';
const legacyDatabaseLabel = 'io.stackforge.legacy-database-id';
const unverifiedDatabase = 'The database volume could not be verified as belonging to this project.';
const composeStatusFormat = [
  '{{.Id}}', '{{json .Config.Labels}}', '{{json .Config.Image}}',
  '{{.State.Status}}',
  '{{if .State.Health}}{{.State.Health.Status}}{{end}}', '{{json .Mounts}}'
].join('\t');

function databaseTaskOutput(append, redact) {
  let line = '';
  let discard = false;
  return {
    write(chunk) {
      if (discard) {
        const end = chunk.indexOf('\n');
        if (end < 0) return;
        chunk = chunk.slice(end + 1);
        discard = false;
      }
      line += chunk;
      const end = line.lastIndexOf('\n') + 1;
      if (end) {
        append(redact.text(line.slice(0, end)));
        line = line.slice(end);
      }
      if (line.length > logLimit) {
        line = '';
        discard = true;
      }
    },
    flush() { if (line) append(redact.text(line)); }
  };
}

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

export class ProjectOperations {
  constructor({ command = run, install = npm } = {}) {
    this.command = command;
    this.install = install;
    this.projects = new Map();
    this.closing = false;
  }

  active(project) {
    return this.projects.get(projectPathKey(project.path))?.active;
  }

  status(project, includeLogs = false) {
    const entry = this.projects.get(projectPathKey(project.path));
    if (!entry) return {};
    const result = { operation: entry.active?.kind };
    if (includeLogs) for (const kind of ['dependencies', 'databaseTask', 'checkTask']) {
      const task = entry[kind];
      if (task) result[kind] = { status: task.status, phase: task.phase, log: task.log, error: task.error, diagnostic: task.diagnostic };
    }
    return result;
  }

  start(project, action, ports, { checkId, installPlanId, confirmVolume, record } = {}) {
    if (this.closing) throw new Error('StackForge is shutting down.');
    const key = projectPathKey(project.path);
    const entry = this.projects.get(key) ?? {};
    if (entry.active) throw new Error('Wait for the current project operation to finish.');
    const kind = action === 'install' ? 'dependencies' : action === 'run-check' ? 'checkTask' : 'databaseTask';
    if (kind === 'checkTask' && (typeof checkId !== 'string' || !/^(?:(?:root|frontend|backend|(?:service|tool|custom):[a-f0-9]{24}):(?:build|test|lint)|maven:(?:package|test))$/.test(checkId))) {
      throw new Error('Choose an available project check.');
    }
    const controller = new AbortController();
    const task = { kind, phase: kind === 'checkTask' ? checkId : action, status: 'running', controller, log: '' };
    entry.active = entry[kind] = task;
    this.projects.set(key, entry);
    const append = chunk => { task.log = (task.log + chunk).slice(-logLimit); };
    const redact = kind === 'databaseTask' ? databaseRedactor(process.env) : undefined;
    const output = redact && databaseTaskOutput(append, redact);
    const options = { signal: controller.signal, log: output?.write ?? append, addDatabaseSecrets: redact?.add };
    const work = {
      dependencies: () => project.unmanaged
        ? installPlanId ? this.installDetectedDependencies(project, task, options, installPlanId) : this.installConfiguredDependencies(project, task, options)
        : this.installDependencies(project, task, options),
      databaseTask: () => action === 'database-delete'
        ? this.removeDatabase(project, ports, confirmVolume, options.signal)
        : this.changeDatabase(project, action, ports, options),
      checkTask: () => this.runCheck(project, checkId, options)
    };
    let outcome = 'succeeded';
    task.done = work[kind]()
      .catch(error => {
        outcome = error.name === 'AbortError' ? 'cancelled' : 'failed';
        if (outcome === 'failed') {
          const message = redact ? redact.text(error.message) : error.message;
          task.error = kind === 'checkTask' && Number.isInteger(error.exitCode)
            ? `Check command exited with code ${error.exitCode}.`
            : message.split('\n')[0].trim();
          task.diagnostic = startupDiagnostic(project, `${message}\n${task.log.slice(-12000)}`);
        }
      })
      .finally(async () => {
        output?.flush();
        try { if (record) await record(outcome); }
        finally {
          task.status = outcome;
          entry.active = undefined;
        }
      });
  }

  cancel(project, kind) {
    const task = this.active(project);
    if (task?.kind !== kind) return;
    task.status = 'cancelling';
    task.controller.abort();
  }

  async checks(project) {
    return (await projectChecks(project)).map(({ id, scope, directory, tool, name, command }) => ({ id, scope, directory, tool, name, command }));
  }

  git(project) {
    return projectGitStatus(project, this.command);
  }

  async runCheck(project, checkId, options) {
    const checks = await projectChecks(project);
    throwIfCancelled(options.signal);
    const check = checks.find(item => item.id === checkId);
    if (!check) throw new Error('This project check is no longer available.');
    const identity = check.tool === 'custom' ? project.customChecks.identity : project.startup?.identity ?? project.cloneIdentity ?? project.folderIdentity;
    const { commands: [verified] } = await resolveStartup(project, [check], identity);
    if (projectPathKey(verified.cwd) !== projectPathKey(check.cwd)) throw new Error('This project check is no longer available.');
    throwIfCancelled(options.signal);
    const config = { ...options, cwd: check.cwd };
    options.log(`[${check.directory}] ${check.command}\n`);
    if (check.tool === 'maven') await maven(check.args, config, this.command, check.wrapper);
    else if (check.tool === 'npm') await npm(['run', check.name], config);
    else if (check.program && !check.shell) await this.command(check.program, check.args, config);
    else await this.command(check.command, [], { ...config, shell: true });
  }

  async installDependencies(project, task, options) {
    const { directory } = await inspectRecordedProject(project);
    throwIfCancelled(options.signal);
    if (project.frontend !== 'none' || hasNodeBackend(project.backend)) {
      task.phase = 'npm';
      const manifest = await lstat(join(directory, 'package.json')).catch(() => null);
      if (!manifest?.isFile()) throw new Error('The project is missing its package.json file.');
      await installNodeDependencies({ ...options, cwd: directory }, this.install);
    }
    if (project.backend === 'spring') {
      task.phase = 'maven';
      const backend = join(directory, 'backend');
      const wrapper = await lstat(join(backend, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw')).catch(() => null);
      if (!wrapper?.isFile() || projectPathKey(await realpath(backend)) !== projectPathKey(backend)) throw new Error('The project is missing its Maven Wrapper.');
      await installMavenDependencies({ ...options, cwd: backend }, this.command);
    }
  }

  async installConfiguredDependencies(project, task, options) {
    const services = project.startup?.services.filter(service => service.installCommand);
    if (!services?.length) throw new Error('Save an install command before installing dependencies.');
    const { commands } = await resolveStartup(project, services, project.startup.identity);
    task.phase = 'custom';
    for (const { name, cwd, installCommand } of commands) {
      throwIfCancelled(options.signal);
      options.log(`[${name}]\n`);
      await this.command(installCommand, [], { ...options, cwd, shell: true });
    }
  }

  async installDetectedDependencies(project, task, options, reviewedId) {
    const plan = await detectDependencyPlan(project);
    throwIfCancelled(options.signal);
    if (!plan.steps.length || plan.id !== reviewedId) throw new Error('The detected install plan changed. Refresh detection and review it again.');
    const { commands } = await resolveStartup(project, plan.steps, plan.identity);
    task.phase = 'detected';
    for (const { tool, command, args, directory, executable, wrapper, program, shell, cwd } of commands) {
      throwIfCancelled(options.signal);
      options.log(`[${directory}] ${command}\n`);
      const config = { ...options, cwd };
      if (tool === 'npm') await this.install(args, config);
      else if (tool === 'Maven') await maven(args, config, this.command, wrapper);
      else if (executable) await this.command(join(cwd, executable), args, config);
      else if (program && !shell) await this.command(program, args, config);
      else await this.command(command, [], { ...config, shell: true });
    }
  }

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
      const [id, rawLabels, image, state, health, mounts] = line.split('\t');
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
        mounts: JSON.parse(mounts) ?? [] });
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

  async database(project, ports, logs = false) {
    const { config, container, engine } = await this.databaseTarget(project, ports);
    const status = ['exited', 'created', 'dead'].includes(container?.status) ? 'stopped' : container?.status ?? 'absent';
    const state = { ...(project.unmanaged && { engine }), status };
    if (status === 'running' && !await databaseReady({ engine, container: container.id, config, command: this.command })) state.status = 'starting';
    if (logs && container) state.log = await this.databaseLogs(config, container);
    return state;
  }

  async databaseTarget(project, ports, signal) {
    if (project.unmanaged) return inspectImportedDatabase(project, this.command, signal);
    const info = await inspectRecordedProject(project);
    const target = await this.verifiedManagedDatabase(project, ports, info, signal);
    return { ...target, engine: project.database, container: target.containers[0] };
  }

  async changeDatabase(project, action, ports, options) {
    const { config, container, start, environment } = await this.databaseTarget(project, ports, options.signal);
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

  async removeDatabase(project, ports, confirmVolume, signal) {
    const { containers, docker, volume, recheckVolume } = await this.databaseDeletionTarget(project, ports, signal);
    if (confirmVolume !== volume) throw new Error('Enter the exact volume name to confirm database deletion.');
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

  async shutdown() {
    this.closing = true;
    const active = [...this.projects.values()].map(entry => entry.active).filter(Boolean);
    for (const task of active) task.controller.abort();
    await Promise.all(active.map(task => task.done));
  }
}
