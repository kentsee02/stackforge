import { createProjectClone } from '../projects/project-clone.mjs';
import { ProjectActionError } from '../projects/project-workflows.mjs';
import { send } from './response.mjs';

const savedActions = new Set(['ports', 'check-config', 'startup', 'trash', 'remove', 'install-terminal']);

export function matchProjectAction(pathname) {
  return /^\/api\/projects\/([^/]+)\/(start|stop|startup|trash|remove|ports|install|install-cancel|install-terminal|database-start|database-stop|database-delete|database-local-check|database-initialization-plan|database-initialize|database-connection-config|database-postgres-setup|database-development|database-drizzle-preview|database-drizzle-apply|database-alembic-preview|database-ef-core-preview|database-local-status|database-remote-profile|database-sqlite-inspect|database-sqlite-create|run-check|check-cancel|check-config)$/.exec(pathname);
}

export function createProjectRoutes({ projects, queries, databaseRoutes, removals, isCreatingProject, clone, execute }) {
  const clones = createProjectClone({ clone, beforePromotion: projects.guardCloneReplacement,
    register: async (path, cloneInfo) => queries.describe(await projects.register(path, cloneInfo)) });

  async function get(res, url) {
    const reply = (status, value) => { send(res, status, value); return true; };
    if (url.pathname === '/api/projects') {
      return reply(200, { projects: await queries.list(url.searchParams.get('logs')) });
    }
    const projectView = /^\/api\/projects\/([^/]+)\/(database|database-discovery|database-delete|database-development|checks|git|dependencies|startup-suggestions|startup-preflight)$/.exec(url.pathname);
    if (projectView) {
      const [, id, view] = projectView;
      const project = projects.list().find(item => item.id === id);
      if (!project) return reply(404, { error: 'This project was not found in StackForge.' });
      try {
        if (view.startsWith('database')) { await databaseRoutes.view(res, project, view, url.searchParams); return true; }
        return reply(200, await queries.inspect(project, view));
      } catch (error) {
        return reply(409, { error: error.message.split('\n')[0].trim() });
      }
    }
    return false;
  }

  async function post(req, res, pathname, projectAction, payload) {
    if (pathname === '/api/projects/clone-cancel') {
      try { clones.cancel(payload.requestId); }
      catch (error) { return send(res, 409, { error: error.message }); }
      return send(res, 202, { cancelling: true });
    }
    if (pathname === '/api/projects/clone') {
      if (isCreatingProject() || removals.size) return send(res, 409, { error: 'Wait for StackForge to finish its current task.' });
      const { requestId } = payload;
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId))) {
        return send(res, 400, { error: 'Invalid JSON request.' });
      }
      const task = clones.start(payload);
      res.once('close', () => { if (!res.writableFinished) task.cancelIfPending(); });
      try {
        const project = await task.done;
        if (!res.destroyed) return send(res, 201, project);
      } catch (error) {
        if (!res.destroyed) return send(res, 409, { error: error.name === 'AbortError' ? 'Cloning cancelled.' : error.message });
      }
      return;
    }
    if (pathname === '/api/projects/import') {
      if (isCreatingProject()) return send(res, 409, { error: 'Wait for StackForge to finish its current task.' });
      try { return send(res, 201, await queries.describe(await projects.register(payload.path))); }
      catch (error) { return send(res, 400, { error: error.message }); }
    }
    const [, id, action] = projectAction;
    const project = projects.list().find(item => item.id === id);
    if (!project) return send(res, 404, { error: 'This project was not found in StackForge.' });
    if (await databaseRoutes.action(res, project, action, payload)) return;
    if (!projects.list().some(item => item.id === id && item.path === project.path)) {
      return send(res, 409, { error: 'The project registration has changed. Refresh Projects and try again.' });
    }
    try { return send(res, savedActions.has(action) ? 200 : 202, await execute(project, action, payload)); }
    catch (error) {
      if (!(error instanceof ProjectActionError)) throw error;
      return send(res, error.invalid ? 400 : 409, { error: error.message, diagnostic: error.diagnostic });
    }
  }

  return { get, post, get cloning() { return clones.active; }, shutdown: clones.shutdown };
}
