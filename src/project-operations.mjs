import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { hasNodeBackend } from './catalog.mjs';
import { installMavenDependencies, installNodeDependencies, maven, npm, run, throwIfCancelled } from './process.mjs';
import { projectPathKey } from './project-config.mjs';
import { inspectRecordedProject, startupDiagnostic } from './project-runtime.mjs';
import { projectChecks, projectGitStatus } from './project-tools.mjs';
import { transferDatabase } from './database-backup.mjs';
import { resolveStartup } from './project-startup.mjs';

const logLimit = 64 * 1024;
// Compose probes can take several seconds while Docker Desktop is busy.
const dockerProbeTimeout = 15_000;
const databaseLabel = 'io.stackforge.database-id';
const unverifiedDatabase = 'The database volume could not be verified as belonging to this project.';
const composeStatusFormat = [
  '{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}',
  '{{index .Config.Labels "com.docker.compose.service"}}',
  '{{.State.Status}}',
  '{{if .State.Health}}{{.State.Health.Status}}{{end}}'
].join('\t');

async function databaseOptions(project, ports, info) {
  if (project.database === 'none') throw new Error('This project has no database.');
  const { directory, manifest } = info ?? await inspectRecordedProject(project);
  const file = await lstat(join(directory, 'compose.yaml')).catch(() => null);
  if (!file?.isFile()) throw new Error('The project is missing its compose.yaml file.');
  const env = { ...process.env, STACKFORGE_DATABASE_PORT: '' };
  try { Object.assign(env, parseEnv(await readFile(join(directory, '.env'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = ports.database ?? env.STACKFORGE_DATABASE_PORT;
  if (manifest.portConfig === 1 && port) env.DB_PORT = String(port);
  return { cwd: directory, env };
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

  start(project, action, ports, checkId) {
    if (this.closing) throw new Error('StackForge is shutting down.');
    const key = projectPathKey(project.path);
    const entry = this.projects.get(key) ?? {};
    if (entry.active) throw new Error('Wait for the current project operation to finish.');
    const kind = action === 'install' ? 'dependencies' : action === 'run-check' ? 'checkTask' : 'databaseTask';
    if (kind === 'checkTask' && (typeof checkId !== 'string' || !/^(?:(?:root|frontend|backend):(?:build|test|lint)|maven:(?:package|test))$/.test(checkId))) {
      throw new Error('Choose an available project check.');
    }
    const controller = new AbortController();
    const task = { kind, phase: kind === 'checkTask' ? checkId : action, status: 'running', controller, log: '' };
    entry.active = entry[kind] = task;
    this.projects.set(key, entry);
    const options = { signal: controller.signal, log: chunk => { task.log = (task.log + chunk).slice(-logLimit); } };
    const work = {
      dependencies: () => project.unmanaged ? this.installConfiguredDependencies(project, task, options) : this.installDependencies(project, task, options),
      databaseTask: () => this.changeDatabase(project, action, ports, options),
      checkTask: () => this.runCheck(project, checkId, options)
    };
    task.done = work[kind]()
      .then(() => { task.status = 'succeeded'; })
      .catch(error => {
        task.status = error.name === 'AbortError' ? 'cancelled' : 'failed';
        if (task.status === 'failed') {
          task.error = kind === 'checkTask' && Number.isInteger(error.exitCode)
            ? `Check command exited with code ${error.exitCode}.`
            : error.message.split('\n')[0].trim();
          task.diagnostic = startupDiagnostic(project, `${error.message}\n${task.log.slice(-12000)}`);
        }
      })
      .finally(() => { entry.active = undefined; });
  }

  cancel(project, kind) {
    const task = this.active(project);
    if (task?.kind !== kind) return;
    task.status = 'cancelling';
    task.controller.abort();
  }

  async checks(project) {
    return (await projectChecks(project)).map(({ id, scope, tool, name }) => ({ id, scope, tool, name }));
  }

  git(project) {
    return projectGitStatus(project, this.command);
  }

  async runCheck(project, checkId, options) {
    const checks = await projectChecks(project);
    throwIfCancelled(options.signal);
    const check = checks.find(item => item.id === checkId);
    if (!check) throw new Error('This project check is no longer available.');
    const config = { ...options, cwd: check.cwd };
    if (check.tool === 'maven') await maven(['-B', check.name], config, this.command);
    else await npm(['run', check.name], config);
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

  async databaseContainers(config, includeMounts = false) {
    const options = { ...config, stdoutOnly: true, timeout: dockerProbeTimeout };
    const ids = (await this.command('docker', ['compose', 'ps', '--all', '--format', '{{.ID}}'], options)).trim().split(/\r?\n/).filter(Boolean);
    if (!ids.length) return [];
    if (!ids.every(id => /^[a-f0-9]{12,64}$/.test(id))) throw new Error('Docker returned an unexpected container identifier.');
    const format = includeMounts ? composeStatusFormat + '\t{{json .Mounts}}' : composeStatusFormat;
    const details = await this.command('docker', ['inspect', '--type', 'container', '--format', format, ...ids], options);
    const containers = details.trimEnd().split(/\r?\n/).map(line => line.split('\t'));
    if (containers.length !== ids.length) throw new Error('Docker returned an unexpected container identifier.');
    for (const [label] of containers) {
      const path = JSON.parse(label);
      const owner = path && await realpath(path).catch(() => path);
      if (!owner || projectPathKey(owner) !== projectPathKey(config.cwd)) throw new Error('This Compose database belongs to another project folder.');
    }
    return containers.flatMap(([, service, state, health, mounts], index) => service === 'db' ? [{
      id: ids[index],
      status: state === 'running' && ['unhealthy', 'starting'].includes(health) ? health : state,
      mounts: includeMounts ? JSON.parse(mounts) ?? [] : []
    }] : []);
  }

  async databaseState(config) {
    const states = (await this.databaseContainers(config)).map(container => container.status);
    if (!states.length) return { status: 'absent' };
    const status = ['unhealthy', 'restarting', 'starting', 'running', 'paused'].find(state => states.includes(state)) ?? 'stopped';
    return { status };
  }

  async database(project, ports, logs = false) {
    const config = await databaseOptions(project, ports);
    const state = await this.databaseState(config);
    if (logs && state.status !== 'absent') {
      let output = '';
      await this.command('docker', ['compose', 'logs', '--no-color', '--tail', '100', 'db'], {
        ...config, timeout: dockerProbeTimeout, log: chunk => { output = (output + chunk).slice(-logLimit); }
      });
      state.log = output;
    }
    return state;
  }

  async changeDatabase(project, action, ports, options) {
    const config = await databaseOptions(project, ports);
    const state = await this.databaseState({ ...config, signal: options.signal });
    throwIfCancelled(options.signal);
    if (action === 'database-stop' && state.status === 'absent') return;
    const args = action === 'database-start' ? ['up', '-d', '--wait', '--no-deps', 'db'] : ['stop', 'db'];
    await this.command('docker', ['compose', ...args], { ...config, ...options });
  }

  async databaseBackup(project, ports, file, signal) {
    const config = await databaseOptions(project, ports);
    const containers = await this.databaseContainers({ ...config, signal });
    if (containers.length !== 1 || containers[0].status !== 'running') {
      throw new Error('Start the project database before backing it up or restoring it.');
    }
    return transferDatabase({ engine: project.database, project: project.name, container: containers[0].id,
      config, command: this.command, file, signal });
  }

  async removeDatabase(project, ports, info) {
    const config = await databaseOptions(project, ports, info);
    const docker = async args => {
      try {
        return await this.command('docker', args, { ...config, timeout: dockerProbeTimeout, stdoutOnly: true, stdoutLimit: 128 * 1024 });
      } catch {
        throw new Error('Docker could not finish deleting the database. Check that Docker is running and retry.');
      }
    };
    let model;
    try { model = JSON.parse(await docker(['compose', 'config', '--format', 'json'])); }
    catch { throw new Error('The database Compose configuration could not be read. Check compose.yaml and .env before retrying.'); }
    const mounts = model.services?.db?.volumes ?? [];
    const [mount] = mounts;
    const volume = model.volumes?.[mount?.source];
    const name = volume?.name;
    if (mounts.length !== 1 || mount?.type !== 'volume' || volume?.external || volume?.driver_opts ||
        (volume?.driver && volume.driver !== 'local') || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name ?? '')) {
      throw new Error('Only a dedicated, Compose-managed database volume can be deleted with a project.');
    }
    for (const [service, options] of Object.entries(model.services)) {
      if (service !== 'db' && options.volumes?.some(item => item.type === 'volume' && model.volumes?.[item.source]?.name === name)) {
        throw new Error('The database volume is shared with another container.');
      }
    }
    const containers = await this.databaseContainers(config, true);
    if (containers.some(container => container.mounts.length !== 1 ||
        !container.mounts.some(item => item.Type === 'volume' && item.Name === name && item.Destination === mount.target))) {
      throw new Error(unverifiedDatabase);
    }
    const names = (await docker(['volume', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'])).trim().split(/\r?\n/);
    if (!names.includes(name)) {
      if (containers.length) throw new Error(unverifiedDatabase);
      return false;
    }
    const details = await docker(['volume', 'inspect', '--format', '{{json .CreatedAt}}\t{{json .Labels}}', name]);
    const [createdAt, labels] = details.trim().split('\t').map(value => JSON.parse(value));
    if (labels?.['com.docker.compose.project'] !== model.name || labels?.['com.docker.compose.volume'] !== mount.source) {
      throw new Error(unverifiedDatabase);
    }
    const databaseId = info.manifest.databaseId;
    const projectCreated = Math.floor(Date.parse(info.manifest.createdAt) / 1000) * 1000;
    const matchesLegacyProject = !labels[databaseLabel] && containers.length && Date.parse(createdAt) >= projectCreated;
    if (databaseId ? labels[databaseLabel] !== databaseId : !matchesLegacyProject) {
      throw new Error(unverifiedDatabase);
    }
    const users = (await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `volume=${name}`])).trim().split(/\r?\n/).filter(Boolean);
    if (users.some(id => !containers.some(container => id.startsWith(container.id)))) {
      throw new Error('The database volume is shared with another container.');
    }
    if (containers.length) await docker(['container', 'rm', '--force', ...containers.map(container => container.id)]);
    await docker(['volume', 'rm', name]);
    return true;
  }

  async shutdown() {
    this.closing = true;
    const active = [...this.projects.values()].map(entry => entry.active).filter(Boolean);
    for (const task of active) task.controller.abort();
    await Promise.all(active.map(task => task.done));
  }
}
