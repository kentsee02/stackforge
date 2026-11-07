import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { installMavenDependencies, installNodeDependencies, npm, run, throwIfCancelled } from './process.mjs';
import { projectPathKey } from './project-config.mjs';
import { inspectRecordedProject, startupDiagnostic } from './project-runtime.mjs';

const logLimit = 64 * 1024;
const composeStatusFormat = [
  '{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}',
  '{{index .Config.Labels "com.docker.compose.service"}}',
  '{{.State.Status}}',
  '{{if .State.Health}}{{.State.Health.Status}}{{end}}'
].join('\t');

async function databaseOptions(project, ports) {
  if (project.database === 'none') throw new Error('This project has no database.');
  const { directory, manifest } = await inspectRecordedProject(project);
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
    if (includeLogs) for (const kind of ['dependencies', 'databaseTask']) {
      const task = entry[kind];
      if (task) result[kind] = { status: task.status, phase: task.phase, log: task.log, error: task.error, diagnostic: task.diagnostic };
    }
    return result;
  }

  start(project, action, ports) {
    if (this.closing) throw new Error('StackForge is shutting down.');
    const key = projectPathKey(project.path);
    const entry = this.projects.get(key) ?? {};
    if (entry.active) throw new Error('Wait for the current project operation to finish.');
    const kind = action === 'install' ? 'dependencies' : 'databaseTask';
    const controller = new AbortController();
    const task = { kind, phase: action, status: 'running', controller, log: '' };
    entry.active = entry[kind] = task;
    this.projects.set(key, entry);
    const options = { signal: controller.signal, log: chunk => { task.log = (task.log + chunk).slice(-logLimit); } };
    task.done = (action === 'install' ? this.installDependencies(project, task, options) : this.changeDatabase(project, action, ports, options))
      .then(() => { task.status = 'succeeded'; })
      .catch(error => {
        task.status = error.name === 'AbortError' ? 'cancelled' : 'failed';
        if (task.status === 'failed') {
          task.error = error.message.split('\n')[0].trim();
          task.diagnostic = startupDiagnostic(project, `${error.message}\n${task.log.slice(-12000)}`);
        }
      })
      .finally(() => { entry.active = undefined; });
  }

  cancelInstall(project) {
    const task = this.active(project);
    if (task?.kind !== 'dependencies') return;
    task.status = 'cancelling';
    task.controller.abort();
  }

  async installDependencies(project, task, options) {
    const { directory } = await inspectRecordedProject(project);
    throwIfCancelled(options.signal);
    if (project.frontend !== 'none' || project.backend === 'express') {
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

  async databaseState(config) {
    const options = { ...config, stdoutOnly: true, timeout: 3000 };
    const ids = (await this.command('docker', ['compose', 'ps', '--all', '--format', '{{.ID}}'], options)).trim().split(/\r?\n/).filter(Boolean);
    if (!ids.length) return { status: 'absent' };
    if (!ids.every(id => /^[a-f0-9]{12,64}$/.test(id))) throw new Error('Docker returned an unexpected container identifier.');
    const details = await this.command('docker', ['inspect', '--type', 'container', '--format', composeStatusFormat, ...ids], options);
    const containers = details.trimEnd().split(/\r?\n/).map(line => line.split('\t'));
    if (containers.length !== ids.length) throw new Error('Docker returned an unexpected container identifier.');
    for (const [label] of containers) {
      const path = JSON.parse(label);
      const owner = path && await realpath(path).catch(() => path);
      if (!owner || projectPathKey(owner) !== projectPathKey(config.cwd)) throw new Error('This Compose database belongs to another project folder.');
    }
    const states = containers.filter(([, service]) => service === 'db')
      .map(([, , state, health]) => state === 'running' && ['unhealthy', 'starting'].includes(health) ? health : state);
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
        ...config, timeout: 3000, log: chunk => { output = (output + chunk).slice(-logLimit); }
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

  async shutdown() {
    this.closing = true;
    const active = [...this.projects.values()].map(entry => entry.active).filter(Boolean);
    for (const task of active) task.controller.abort();
    await Promise.all(active.map(task => task.done));
  }
}
