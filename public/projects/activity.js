import { setText } from '/i18n.js';

export const activityLabels = {
  'create-project': 'Create project',
  'publish-project': 'Publish project to GitHub',
  install: 'Install dependencies',
  'check-build': 'Build project',
  'check-package': 'Build project',
  'check-test': 'Run project tests',
  'check-lint': 'Lint project',
  'database-start': 'Start database',
  'database-stop': 'Stop database',
  'database-delete': 'Delete database volume',
  'database-backup': 'Back up database',
  'database-restore': 'Restore database',
  'database-initialize': 'Initialize database',
  'database-migrate': 'Apply database migrations',
  'database-rollback': 'Roll back database migrations',
  'database-profile-cleanup': 'Clean up saved database profiles',
  'database-development-create': 'Create development database',
  'database-development-start': 'Start development database',
  'database-development-stop': 'Stop development database',
  'database-development-save': 'Save database connection',
  'database-development-delete': 'Delete development database',
  'database-connection-config': 'Save database connection',
  'database-remote-profile-save': 'Save remote database profile',
  'database-remote-profile-remove': 'Remove remote database profile'
};
export const activityOutcomes = { succeeded: 'Completed', failed: 'Operation failed', cancelled: 'Cancelled',
  running: 'Running', cancelling: 'Cancelling…', 'partially-completed': 'Local project created, publishing incomplete' };

export function createActivityPanel({ $, request, showMessage }) {
  const panel = $('project-activity');
  const list = $('project-activity-list');
  const status = $('project-activity-status');
  const button = $('project-activity-refresh');
  let current, operation, updatedAt = 0, requestKey;

  function renderTimes() {
    const format = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'medium' });
    for (const time of list.querySelectorAll('time')) time.textContent = format.format(new Date(time.dateTime));
  }

  async function load({ explicit = false } = {}) {
    if (!current || !panel.open || operation || document.hidden) return;
    const controller = new AbortController();
    operation = controller;
    const id = current;
    if (explicit) {
      showMessage(status, 'Loading project activity…');
      button.disabled = true;
    }
    try {
      const { entries, limited } = await request(`/api/projects/${encodeURIComponent(id)}/activity`,
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      if (operation !== controller || controller.signal.aborted) return;
      const key = JSON.stringify(entries);
      if (key !== requestKey) {
        requestKey = key;
        list.replaceChildren(...entries.map(entry => {
          const row = document.createElement('li');
          const name = document.createElement('strong');
          const outcome = document.createElement('span');
          const time = document.createElement('time');
          setText(name, activityLabels[entry.action]);
          outcome.className = 'small project-check-status';
          outcome.dataset.status = entry.status;
          setText(outcome, activityOutcomes[entry.status]);
          time.dateTime = entry.finishedAt;
          row.append(name, outcome, time);
          return row;
        }));
        renderTimes();
      }
      list.hidden = !entries.length;
      showMessage(status, limited ? 'Older records may be outside the recent activity window.' :
        entries.length ? '' : 'Finished installs, checks and database actions will appear here.');
    } catch {
      if (operation === controller && !controller.signal.aborted) showMessage(status, 'Could not load project activity. Try refreshing.');
    } finally {
      if (operation === controller) {
        operation = undefined;
        updatedAt = Date.now();
        button.disabled = false;
      }
    }
  }

  function stop() {
    operation?.abort();
    operation = undefined;
    button.disabled = false;
  }

  function render(project) {
    if (project?.id !== current) {
      stop();
      current = project?.id;
      updatedAt = 0;
      requestKey = undefined;
      list.replaceChildren();
      list.hidden = true;
      showMessage(status, '');
    }
    if (Date.now() - updatedAt >= 5000) void load({ explicit: requestKey === undefined });
  }

  panel.addEventListener('toggle', () => {
    if (panel.open) void load({ explicit: requestKey === undefined });
    else stop();
  });
  button.addEventListener('click', () => void load({ explicit: true }));
  $('language').addEventListener('change', renderTimes);

  return { render };
}
