import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hasNodeBackend } from '../generation/catalog.mjs';
import { installMavenDependencies, installNodeDependencies, maven, npm, run, throwIfCancelled } from '../platform/process.mjs';
import { projectPathKey } from './project-config.mjs';
import { commandDiagnostic, pnpmBuildPackages } from './project-diagnostics.mjs';
import { directoryIdentity } from '../platform/project-identity.mjs';
import { inspectRecordedProject } from './project-folder.mjs';
import { projectChecks, projectGitStatus } from './project-tools.mjs';
import { addProjectLogSecrets, databaseRedactor, redactedProcessOutput } from '../database/security/secrets.mjs';
import { resolveStartup } from './project-startup.mjs';
import { detectDependencyPlan } from './dependency-plan.mjs';
import { ProjectDatabase } from '../database/docker/project-database.mjs';

const logLimit = 64 * 1024;

export class ProjectOperations {
  constructor({ command = run, install = npm } = {}) {
    this.command = command;
    this.databaseDriver = new ProjectDatabase(command);
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
      if (task) result[kind] = { status: task.status, phase: task.phase, log: task.log, error: task.error, diagnostic: task.diagnostic,
        ...(task.buildApproval && { buildApproval: task.buildApproval }) };
    }
    return result;
  }

  buildApprovalTarget(project) {
    const task = this.projects.get(projectPathKey(project.path))?.dependencies;
    if (task?.status === 'failed' && task.projectId === project.id && task.buildApproval) return task.installTarget;
  }

  start(project, action, ports, { checkId, installPlanId, confirmVolume, activity = action, chooseDatabase, record, verifyDeletion } = {}) {
    if (this.closing) throw new Error('StackForge is shutting down.');
    const key = projectPathKey(project.path);
    const entry = this.projects.get(key) ?? {};
    if (entry.active) throw new Error('Wait for the current project operation to finish.');
    const kind = action === 'install' ? 'dependencies' : action === 'run-check' ? 'checkTask' : 'databaseTask';
    if (kind === 'checkTask' && (typeof checkId !== 'string' || !/^(?:(?:root|frontend|backend|(?:service|tool|custom):[a-f0-9]{24}):(?:build|test|lint)|maven:(?:package|test))$/.test(checkId))) {
      throw new Error('Choose an available project check.');
    }
    const controller = new AbortController();
    const task = { id: randomUUID(), action: activity, startedAt: new Date().toISOString(), kind,
      phase: kind === 'checkTask' ? checkId : action, status: 'running', controller, log: '', projectId: project.id };
    entry.active = entry[kind] = task;
    this.projects.set(key, entry);
    const append = chunk => { task.log = (task.log + chunk).slice(-logLimit); };
    const redact = databaseRedactor(process.env);
    const output = redactedProcessOutput(append, redact);
    const options = { signal: controller.signal, log: output.write,
      addDatabaseSecrets: redact.add, loadLogSecrets: directory => addProjectLogSecrets(redact, directory) };
    const work = {
      dependencies: () => project.unmanaged
        ? installPlanId ? this.installDetectedDependencies(project, task, options, installPlanId) : this.installConfiguredDependencies(project, task, options)
        : this.installDependencies(project, task, options),
      databaseTask: () => action === 'database-delete'
        ? this.removeDatabase(project, ports, confirmVolume, options.signal, verifyDeletion)
        : this.changeDatabase(project, action, ports, { ...options, chooseDatabase }),
      checkTask: () => this.runCheck(project, checkId, options)
    };
    let outcome = 'succeeded';
    task.done = options.loadLogSecrets(project.path).then(() => work[kind]())
      .catch(error => {
        outcome = error.name === 'AbortError' ? 'cancelled' : 'failed';
        if (outcome === 'failed') {
          const message = redact.text(error.message);
          task.error = kind === 'checkTask' && Number.isInteger(error.exitCode)
            ? `Check command exited with code ${error.exitCode}.`
            : message.split('\n')[0].trim();
          output.flush();
          const diagnosis = commandDiagnostic(message + '\n' + task.log.slice(-12000));
          task.diagnostic = diagnosis;
          if (kind === 'dependencies' && diagnosis === 'pnpmBuildApproval' && task.installTarget) {
            const packages = pnpmBuildPackages(message);
            task.buildApproval = { directory: task.installTarget.directory,
              packages: packages.length ? packages : pnpmBuildPackages(task.log.slice(-12000)), steps: task.installPlan,
              command: process.platform === 'win32' ? 'pnpm.cmd approve-builds' : 'pnpm approve-builds' };
          }
        }
      })
      .finally(async () => {
        task.finishing = true;
        output.flush();
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

  task(project) {
    const task = this.active(project);
    if (!task || task.projectId !== project.id) return;
    const { id, action, status, startedAt, finishing, kind } = task;
    return { id, action, status, startedAt, canCancel: status === 'running' && !finishing && kind !== 'databaseTask' };
  }

  cancelTask(project, id) {
    const current = this.task(project);
    if (current?.id !== id || !current.canCancel) return false;
    this.cancel(project, this.active(project).kind);
    return true;
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
    await options.loadLogSecrets(check.cwd);
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
      await options.loadLogSecrets(backend);
      await installMavenDependencies({ ...options, cwd: backend }, this.command);
    }
  }

  async installConfiguredDependencies(project, task, options) {
    const services = project.startup?.services.filter(service => service.installCommand);
    if (!services?.length) throw new Error('Save an install command before installing dependencies.');
    const { commands } = await resolveStartup(project, services, project.startup.identity);
    task.phase = 'custom';
    await Promise.all(commands.map(({ cwd }) => options.loadLogSecrets(cwd)));
    for (const { name, directory, cwd, installCommand } of commands) {
      throwIfCancelled(options.signal);
      options.log(`[${name}]\n`);
      task.installTarget = { directory, cwd, identity: directoryIdentity(await lstat(cwd, { bigint: true })) };
      await this.command(installCommand, [], { ...options, cwd, shell: true });
    }
  }

  async installDetectedDependencies(project, task, options, reviewedId) {
    const plan = await detectDependencyPlan(project);
    throwIfCancelled(options.signal);
    if (!plan.steps.length || plan.id !== reviewedId) throw new Error('The detected install plan changed. Refresh detection and review it again.');
    const { commands } = await resolveStartup(project, plan.steps, plan.identity);
    task.phase = 'detected';
    task.installPlan = plan.steps.map(({ directory, command }) => ({ directory, command }));
    await Promise.all(commands.map(({ cwd }) => options.loadLogSecrets(cwd)));
    for (const { tool, command, args, directory, executable, wrapper, program, shell, cwd } of commands) {
      throwIfCancelled(options.signal);
      options.log(`[${directory}] ${command}\n`);
      task.installTarget = { directory, cwd, identity: directoryIdentity(await lstat(cwd, { bigint: true })) };
      const config = { ...options, cwd };
      if (tool === 'npm') await this.install(args, config);
      else if (tool === 'Maven') await maven(args, config, this.command, wrapper);
      else if (executable) await this.command(join(cwd, executable), args, config);
      else if (program && !shell) await this.command(program, args, config);
      else await this.command(command, [], { ...config, shell: true });
    }
  }

  database(project, ports, logs, includeCapabilities, selection) {
    return this.databaseDriver.database(project, ports, logs, includeCapabilities, selection);
  }

  databaseTarget(project, ports, signal, selection) {
    return this.databaseDriver.databaseTarget(project, ports, signal, selection);
  }

  changeDatabase(project, action, ports, options) {
    return this.databaseDriver.changeDatabase(project, action, ports, options);
  }

  databaseBackup(project, ports, file, signal) {
    return this.databaseDriver.databaseBackup(project, ports, file, signal);
  }

  databaseDeletionTarget(project, ports, signal) {
    return this.databaseDriver.databaseDeletionTarget(project, ports, signal);
  }

  removeDatabase(project, ports, confirmVolume, signal, verifyDeletion) {
    return this.databaseDriver.removeDatabase(project, ports, confirmVolume, signal, verifyDeletion);
  }

  async shutdown() {
    this.closing = true;
    const active = [...this.projects.values()].map(entry => entry.active).filter(Boolean);
    for (const task of active) task.controller.abort();
    await Promise.all(active.map(task => task.done));
  }
}
