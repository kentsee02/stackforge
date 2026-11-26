import { recentOperationLimit } from '../platform/operation-journal.mjs';
import { send } from './response.mjs';

const taskId = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;

export function createTaskRoutes({ projects, jobs, operations, database, activity }) {
  async function list(res) {
    const registered = new Map(projects().map(project => [project.id, project]));
    const ids = new Set(registered.keys());
    const sources = await Promise.allSettled([activity.recentFor(ids), database.recentTasks(ids)]);
    const generated = jobs.taskRows();
    const projectRows = rows => rows.flatMap(row => {
      const project = registered.get(row.projectId);
      return project ? [{ ...row, name: project.name }] : [];
    });
    const projectTasks = [...registered.values()].flatMap(project => {
      const task = operations.task(project);
      return task ? [{ ...task, name: project.name, projectId: project.id }] : [];
    });
    const active = [...generated.active, ...projectTasks, ...projectRows(database.tasks())]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const stored = sources.flatMap(source => source.status === 'fulfilled' ? [source.value] : []);
    const history = [...generated.recent, ...projectRows(stored.flatMap(source => source.entries))]
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, recentOperationLimit);
    return send(res, 200, { active, history, limited: stored.some(source => source.limited), historyUnavailable: stored.length !== sources.length });
  }

  async function cancel(res, { id }) {
    if (typeof id !== 'string' || !taskId.test(id)) return send(res, 400, { error: 'Choose a running task to cancel.' });
    try {
      if (await jobs.cancelTask(id) || database.cancelTask(id) || projects().some(project => operations.cancelTask(project, id))) {
        return send(res, 202, { cancelling: true });
      }
    } catch { return send(res, 409, { error: 'Could not confirm cancellation. Refresh Tasks to check its status.' }); }
    return send(res, 409, { error: 'This task is no longer cancellable. Refresh Tasks to check its status.' });
  }

  return { list, cancel };
}
