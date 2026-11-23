import { commandDiagnostic } from '../projects/project-diagnostics.mjs';
import { createDatabaseArchiveRoutes } from './database-archive-routes.mjs';
import { send } from './response.mjs';

const resourceActions = new Set(['database-connection-config', 'database-postgres-setup', 'database-local-status',
  'database-remote-profile', 'database-sqlite-inspect', 'database-sqlite-create', 'database-development',
  'database-drizzle-preview', 'database-drizzle-apply', 'database-alembic-preview', 'database-ef-core-preview',
  'database-flyway-preview', 'database-liquibase-preview', 'database-native-migration']);
const localActions = new Set(['database-local-check', 'database-initialization-plan', 'database-initialize']);

export function createDatabaseRoutes({ database, managedProjects, runtime }) {
  const archive = createDatabaseArchiveRoutes({ database, managedProjects, runtime });

  async function view(res, project, type, searchParams) {
    try {
      return send(res, 200, await database.inspect(project, type, {
        includeCapabilities: searchParams.has('capabilities'), logs: searchParams.has('logs'), requested: searchParams.get('binding')
      }));
    } catch (error) {
      const message = database.redact(error.message);
      return send(res, 409, { error: message.split('\n')[0].trim(), diagnostic: type === 'database' ? commandDiagnostic(message) : undefined });
    }
  }

  async function action(res, project, type, payload) {
    const run = resourceActions.has(type) ? database.resourceAction : localActions.has(type) ? database.localAction : undefined;
    if (!run) return false;
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    try { send(res, 200, await run(project, type, payload, controller)); }
    catch (error) { if (!res.destroyed) send(res, 409, { error: database.redact(error.message).split('\n')[0] }); }
    return true;
  }

  return { view, archive, action };
}
