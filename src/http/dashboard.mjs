const rowLimit = 4;
const projectOrder = { failed: 0, offline: 1, starting: 2, stopping: 3, running: 4, ready: 5, deleting: 6, stopped: 7 };

export async function dashboardSnapshot({ projects, databases, tasks }) {
  const [workspace, taskSource] = await Promise.all([projects(), tasks(rowLimit).catch(() => undefined)]);
  const byId = new Map(workspace.map(project => [project.id, project.name]));
  const databaseSource = await databases(workspace.filter(project => project.status !== 'offline' && project.status !== 'deleting'))
    .catch(() => undefined);
  const projectRows = workspace.map(({ id, name, status }) => ({ id, name, status }))
    .sort((left, right) => (projectOrder[left.status] ?? 8) - (projectOrder[right.status] ?? 8));
  const services = workspace.flatMap(project => project.services.map(service => ({ ...service, projectId: project.id, projectName: project.name })));
  const { active, history, historyUnavailable, limited } = taskSource ?? { active: [], history: [] };
  const activePreview = active.slice(0, history.length ? rowLimit - 1 : rowLimit);
  return {
    projects: { total: workspace.length, running: workspace.filter(project => ['running', 'ready'].includes(project.status)).length,
      rows: projectRows.slice(0, rowLimit) },
    services: { total: services.length, rows: services.slice(0, rowLimit) },
    databases: { total: databaseSource?.length, attention: databaseSource?.filter(row => row.status === 'attention').length,
      rows: (databaseSource ?? []).slice(0, rowLimit).map(row => ({ ...row, projectName: byId.get(row.projectId) })), unavailable: !databaseSource },
    tasks: { active: taskSource && active.length, rows: [...activePreview, ...history.slice(0, rowLimit - activePreview.length)],
      unavailable: !taskSource, partial: Boolean(historyUnavailable || limited) }
  };
}
