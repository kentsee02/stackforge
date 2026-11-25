import { databaseDockerEnvironment } from '../database/docker/compose.mjs';
import { detectFrameworks } from './detection/project-services.mjs';
import { validatePorts } from './project-config.mjs';
import { ProjectRemovalError } from './project-removal.mjs';
import { commandDiagnostic } from './project-diagnostics.mjs';
import { inspectRecordedProject } from './project-folder.mjs';
import { resolveStartup, validateCustomChecks, validateStartup } from './project-startup.mjs';
import { assertDirectoryIdentity } from '../platform/project-identity.mjs';

const externalActions = new Set(['start', 'stop', 'startup', 'install', 'install-cancel', 'run-check',
  'check-cancel', 'check-config', 'trash', 'remove', 'database-start', 'database-stop', 'install-terminal']);
const busy = 'Wait for the current project operation to finish.';
const launcherOnly = 'This project uses the StackForge launcher.';
const active = status => ['starting', 'running', 'stopping'].includes(status);

export class ProjectActionError extends Error {
  constructor(message, { invalid = false, diagnostic } = {}) {
    super(message);
    this.invalid = invalid;
    this.diagnostic = diagnostic;
  }
}

export function createProjectWorkflows({ projectConfig, operations, runtime, removals, configWrites, removeProject,
  databaseBusy, chooseDatabase, recordDatabase, recordActivity, verifyDeletion, syncDatabaseBindings, openProject }) {
  async function saveSettings(project, work) {
    const saving = work();
    configWrites.set(project.path, saving);
    try { return await saving; }
    catch (error) { throw new ProjectActionError(error.message, { invalid: true }); }
    finally { configWrites.delete(project.path); }
  }

  async function changePorts(project, input) {
    if (active(runtime.status(project).status)) throw new ProjectActionError('Stop the project before changing its ports.');
    return saveSettings(project, async () => {
      const ports = validatePorts(project, input);
      const { manifest } = await inspectRecordedProject(project);
      if (manifest.portConfig !== 1) throw new Error('This project uses an older launcher with fixed app ports.');
      await projectConfig.savePorts(project, ports);
      await syncDatabaseBindings(project).catch(() => {});
      return { ports };
    });
  }

  async function changeChecks(project, input) {
    return saveSettings(project, async () => {
      const commands = validateCustomChecks(input);
      let config;
      if (commands.length) {
        await inspectRecordedProject(project);
        const previous = projectConfig.checks(project)?.identity;
        const { identity } = await resolveStartup(project, commands, previous);
        config = { identity, commands };
      }
      await projectConfig.saveChecks(project, config);
      return { commands };
    });
  }

  async function changeStartup(project, input) {
    if (!project.unmanaged) throw new ProjectActionError(launcherOnly);
    if (active(runtime.status(project).status)) throw new ProjectActionError('Stop the project before changing its startup configuration.');
    return saveSettings(project, async () => {
      const services = validateStartup(input);
      let startup;
      if (services.length) {
        const { identity } = await resolveStartup(project, services);
        startup = { identity, services };
      }
      const frameworks = await detectFrameworks({ ...project, startup }).catch(() => project.frameworks);
      await projectConfig.saveStartup(project.id, startup, frameworks);
      return { services };
    });
  }

  function startOperation(project, action, payload, detectedInstall) {
    const session = runtime.status(project);
    const inTransition = ['starting', 'stopping'].includes(session.status);
    const isDatabaseAction = action.startsWith('database-');
    if (action === 'database-delete') {
      if (inTransition || session.status === 'running') throw new ProjectActionError('Stop the project before deleting its database.');
      if (typeof payload.confirmVolume !== 'string' || !payload.confirmVolume) {
        throw new ProjectActionError('Enter the exact volume name to confirm database deletion.', { invalid: true });
      }
    }
    if (inTransition || session.status === 'running') {
      if (action === 'install') throw new ProjectActionError('Stop the project before installing dependencies.');
      if (action === 'run-check') throw new ProjectActionError('Stop the project before running checks.');
    }
    if (isDatabaseAction && (inTransition || !project.unmanaged && session.status === 'running' && !session.initialized)) {
      throw new ProjectActionError('Wait for the project to become ready or stop it first.');
    }
    try {
      const target = action === 'run-check' ? { ...project, customChecks: projectConfig.checks(project) } : project;
      const activity = action === 'run-check' && typeof payload.check === 'string' ? 'check-' + payload.check.split(':').at(-1) : action;
      operations.start(target, action, projectConfig.ports(project), {
        checkId: payload.check, installPlanId: detectedInstall ? payload.planId : undefined, confirmVolume: payload.confirmVolume,
        chooseDatabase: ['database-start', 'database-stop'].includes(action) && payload.bindingId !== undefined ?
          () => chooseDatabase(project, payload.bindingId) : undefined,
        record: isDatabaseAction ? recordDatabase(project, action) : recordActivity(project, activity),
        verifyDeletion: action === 'database-delete' ? target => verifyDeletion(project, target) : undefined
      });
      return operations.status(project, true);
    } catch (error) { throw new ProjectActionError(error.message); }
  }

  function changeRuntime(project, action) {
    try {
      if (action === 'start') {
        const ports = projectConfig.ports(project);
        runtime.start(project, ports, !project.unmanaged && project.database !== 'none' ? async signal => {
          const target = await operations.databaseTarget(project, ports, signal);
          await target.verifyLauncher();
          return { ...databaseDockerEnvironment(), COMPOSE_FILE: target.config.composeFile };
        } : undefined);
      } else runtime.stop(project);
      return runtime.status(project);
    } catch (error) {
      throw new ProjectActionError(error.message, { diagnostic: commandDiagnostic(error.message) });
    }
  }

  async function openBuildApprovalTerminal(project) {
    const target = operations.buildApprovalTarget(project);
    if (!target) throw new ProjectActionError('Run dependency installation to get the current build approval request.');
    const changed = 'The installation directory changed. Run dependency installation again.';
    const verify = async () => {
      if (removals.has(project.path) || operations.buildApprovalTarget(project) !== target) throw new Error(changed);
      const { commands: [resolved] } = await resolveStartup(project, [target]);
      if (resolved.cwd !== target.cwd) throw new Error(changed);
      await assertDirectoryIdentity(resolved.cwd, target.identity, changed);
    };
    try {
      await verify();
      await openProject(target.cwd, 'terminal', verify);
      return { opened: true };
    } catch (error) { throw new ProjectActionError(error.message); }
  }

  return async function execute(project, action, payload) {
    if (databaseBusy(project, action)) throw new ProjectActionError(busy);
    if (project.unmanaged && !externalActions.has(action)) throw new ProjectActionError('This action requires a StackForge project.');
    if (project.unmanaged && action === 'start' && !project.startup?.services.some(service => service.command)) {
      throw new ProjectActionError('Save a startup configuration before starting this project.');
    }
    const detectedInstall = project.unmanaged && action === 'install' && payload.mode === 'detected';
    if (detectedInstall && (typeof payload.planId !== 'string' || !/^[a-f0-9]{64}$/.test(payload.planId))) {
      throw new ProjectActionError('Review the detected install plan before running it.', { invalid: true });
    }
    if (project.unmanaged && action === 'install' && !detectedInstall && !project.startup?.services.some(service => service.installCommand)) {
      throw new ProjectActionError('Save an install command before installing dependencies.');
    }
    const removal = removals.get(project.path);
    if (removal) throw new ProjectActionError(removal.moving ? 'Wait for the project to finish moving to the trash.' : busy);
    if (configWrites.has(project.path)) throw new ProjectActionError('Wait for the project settings to finish saving.');
    if (action === 'install-cancel' || action === 'check-cancel') {
      operations.cancel(project, action === 'install-cancel' ? 'dependencies' : 'checkTask');
      return operations.status(project, true);
    }
    if (action !== 'stop' && operations.active(project)) throw new ProjectActionError(busy);
    if (action === 'install-terminal') return openBuildApprovalTerminal(project);
    if (action === 'install' || action === 'run-check' || action.startsWith('database-')) return startOperation(project, action, payload, detectedInstall);
    if (action === 'ports') return changePorts(project, payload.ports);
    if (action === 'check-config') return changeChecks(project, payload.commands);
    if (action === 'startup') return changeStartup(project, payload.services);
    if (action === 'trash' || action === 'remove') {
      try { return await removeProject(project, { action, confirmName: payload.confirmName }); }
      catch (error) {
        if (!(error instanceof ProjectRemovalError)) throw error;
        throw new ProjectActionError(error.message, { invalid: error.reason === 'invalid-request' });
      }
    }
    return changeRuntime(project, action);
  };
}
