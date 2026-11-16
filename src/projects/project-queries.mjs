import { locationExists } from '../platform/paths.mjs';
import { hasImportedCompose } from '../database/docker/imported-database.mjs';
import { defaultPorts } from './project-config.mjs';
import { removeOnly } from './project-removal.mjs';
import { inspectRecordedProject } from './project-folder.mjs';
import { detectDependencyPlan } from './dependency-plan.mjs';
import { detectStartupSuggestions } from './detection/startup-suggestions.mjs';
import { startupPreflight } from './project-preflight.mjs';

function projectDetails(project) {
  const { cloneId, cloneIdentity, folderIdentity, startup, ...details } = project;
  return { ...details, ...(cloneId && { cloned: true }), ...(removeOnly(project) && { removeOnly: true }),
    ...(project.unmanaged && { external: !project.frameworks.length,
      hasStartup: Boolean(startup?.services.some(service => service.command)),
      hasInstallCommands: Boolean(startup?.services.some(service => service.installCommand)) }) };
}

export function createProjectQueries({ projects, projectConfig, runtime, operations, removals, databaseOperation }) {
  async function describe(project) {
    return { ...projectDetails(project), ...(project.unmanaged && { hasComposeDatabase: await hasImportedCompose(project) }) };
  }

  async function list(selected) {
    const details = await Promise.all(projects.list().map(async project => {
      const removal = removals.get(project.path);
      const deleting = removal?.moving ?? false;
      const session = runtime.status(project, project.id === selected);
      const offline = !deleting && !['starting', 'running', 'stopping'].includes(session.status) && !await locationExists(project.path);
      if (offline && projectConfig.value.hiddenWhenMissing[project.id]) return;
      const detail = { ...projectDetails(project), ...session, ...operations.status(project, project.id === selected), deleting,
        ...(offline && { offline: true, removeOnly: true }) };
      if (project.unmanaged && !offline) detail.hasComposeDatabase = await hasImportedCompose(project);
      const operation = removal && !deleting ? 'projectRemoval' : databaseOperation(project);
      if (operation) detail.operation = operation;
      if (project.id === selected) {
        if (project.unmanaged) detail.startupServices = project.startup?.services ?? [];
        else {
          const info = await inspectRecordedProject(project).catch(() => null);
          Object.assign(detail, { portDefaults: defaultPorts(project), ports: projectConfig.ports(project), canConfigurePorts: info?.manifest.portConfig === 1 });
        }
      }
      return detail;
    }));
    return details.filter(Boolean);
  }

  async function inspect(project, view) {
    if (view === 'startup-preflight') {
      if (!project.imported) throw new Error('Startup preflight is available for imported and cloned projects.');
      return startupPreflight(project, { runtime, operations, ports: projectConfig.ports(project) });
    }
    if (view === 'checks') {
      const customChecks = projectConfig.checks(project);
      return { checks: await operations.checks({ ...project, customChecks }), customChecks: customChecks?.commands ?? [] };
    }
    if (view === 'git') return await operations.git(project);
    if (view === 'startup-suggestions') {
      if (!project.unmanaged) throw new Error('This project uses the StackForge launcher.');
      return await detectStartupSuggestions(project);
    }
    if (view === 'dependencies') {
      if (!project.unmanaged) throw new Error('This project uses the StackForge launcher.');
      const { id, steps, issues } = await detectDependencyPlan(project);
      return { id, steps: steps.map(({ tool, command, directory, evidence }) => ({ tool, command, directory, evidence })), issues };
    }
  }

  return { describe, list, inspect };
}
