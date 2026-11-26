import { locationExists } from '../platform/paths.mjs';
import { hasImportedCompose } from '../database/docker/imported-database.mjs';
import { defaultPorts } from './project-config.mjs';
import { removeOnly } from './project-removal.mjs';
import { inspectRecordedProject } from './project-folder.mjs';
import { detectDependencyPlan } from './dependency-plan.mjs';
import { detectStartupSuggestions } from './detection/startup-suggestions.mjs';
import { startupPreflight } from './project-preflight.mjs';
import { recentOperationLimit } from '../platform/operation-journal.mjs';

function projectDetails(project) {
  const { cloneId, cloneIdentity, folderIdentity, startup, ...details } = project;
  return { ...details, ...(cloneId && { cloned: true }), ...(removeOnly(project) && { removeOnly: true }),
    ...(project.imported && project.unmanaged && folderIdentity && { canDevelopPostgres: true }),
    ...(project.unmanaged && { external: !project.frameworks.length,
      hasStartup: Boolean(startup?.services.some(service => service.command)),
      hasInstallCommands: Boolean(startup?.services.some(service => service.installCommand)) }) };
}

export function createProjectQueries({ projects, projectConfig, runtime, operations, removals, databaseOperation, activity, databaseActivity }) {
  async function describe(project) {
    return { ...projectDetails(project), ...(project.unmanaged && { hasComposeDatabase: await hasImportedCompose(project) }) };
  }

  async function visibleProjects(selected) {
    const visible = await Promise.all(projects.list().map(async project => {
      const removal = removals.get(project.path);
      const deleting = removal?.moving ?? false;
      const session = runtime.status(project, project.id === selected);
      const offline = !deleting && !['starting', 'running', 'stopping'].includes(session.status) && !await locationExists(project.path);
      if (!offline || !projectConfig.value.hiddenWhenMissing[project.id]) return { project, removal, deleting, session, offline };
    }));
    return visible.filter(Boolean);
  }

  async function list(selected) {
    return Promise.all((await visibleProjects(selected)).map(async ({ project, removal, deleting, session, offline }) => {
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
  }

  async function overview() {
    return (await visibleProjects()).map(({ project, deleting, offline, session }) => {
      const { id, name, database } = project;
      const status = deleting ? 'deleting' : offline ? 'offline' : session.ready && session.status === 'running' ? 'ready' : session.status;
      const services = status === 'ready' || status === 'running' ? Object.entries(session.services ?? {}).flatMap(([key, service]) => {
        if (!service.ready) return [];
        const kind = service.kind || (key === 'frontend' ? 'web' : key === 'backend' ? 'api' : 'service');
        const address = service.name && kind === 'api' ? service.openUrl : service.openUrl ?? service.url;
        let url;
        try {
          const candidate = new URL(address);
          if (['http:', 'https:'].includes(candidate.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname) &&
              !candidate.username && !candidate.password && !candidate.search && !candidate.hash) url = candidate.href;
        } catch { /* The existing project action can guide missing or invalid access paths. */ }
        return [{ ...(service.name && { name: service.name }), kind, ...(url && { url }) }];
      }) : [];
      return { id, name, database, status, services };
    });
  }

  async function inspect(project, view) {
    if (view === 'activity') {
      const histories = await Promise.all([activity(project), databaseActivity(project)]);
      const entries = histories.flatMap(({ entries }) => entries).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
      return { entries: entries.slice(0, recentOperationLimit), limited: histories.some(history => history.limited) };
    }
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

  return { describe, list, inspect, overview };
}
