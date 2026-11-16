import { setText } from '/i18n.js';

const statuses = { passed: 'Passed', attention: 'Needs attention', unverified: 'Unverified' };
const order = { attention: 0, unverified: 1, passed: 2 };
const actions = {
  import: 'Import project', startup: 'Review startup configuration', ports: 'Review development ports',
  dependencies: 'Review dependency plan', postgres: 'Set up PostgreSQL', database: 'Review database configuration'
};
const descriptions = {
  'folder-verified': 'Project folder identity verified.',
  'folder-changed': 'The recorded project folder is missing or has changed.',
  'folder-unverified': 'This record has no saved folder identity.',
  'startup-missing': 'Save a startup command for at least one service.',
  'startup-verified': 'Working directory is available and a startup command is saved.',
  'working-directory-invalid': 'The saved working directory is missing or is outside this project.',
  'launcher-verified': 'StackForge development launcher found.',
  'launcher-missing': 'StackForge could not find the development launcher.',
  'command-unverified': 'StackForge could not verify the tool used by this startup command.',
  'tool-found': item => 'Found ' + item.tool + ' in the launch environment.',
  'tool-missing': item => item.tool + ' was not found in the launch environment.',
  'port-free': item => 'Port ' + item.port + ' is available.',
  'port-in-use': item => 'Port ' + item.port + ' is unavailable.',
  'port-active': item => 'Stop the current session to check port ' + item.port + '.',
  'dependencies-installed': 'The last recorded dependency installation succeeded.',
  'dependencies-missing': 'The last startup attempt reported missing dependencies.',
  'dependencies-unverified': 'Installed dependencies could not be verified.',
  'database-missing': item => 'Missing database setting ' + item.variable + '.',
  'database-placeholder': item => 'Database setting ' + item.variable + ' contains a placeholder.',
  'database-configured': 'A database is configured. Its connection is unverified.',
  'database-unverified': 'Database readiness could not be verified.',
  'database-scan-limited': 'The database scan was limited. Review the discovery results.'
};

export function createPreflightPanel({ $, request, selectedProject, followAction, start }) {
  const panel = $('project-preflight');
  const status = $('preflight-status');
  const results = $('preflight-results');
  const check = $('preflight-check');
  const startButton = $('preflight-start');
  let view, rendered, shownMessage;

  function rows(items) {
    return [...items].sort((a, b) => order[a.status] - order[b.status]).map(item => {
      const row = document.createElement('li');
      row.className = 'preflight-row';
      row.dataset.check = item.code;
      row.dataset.status = item.status;
      const indicator = document.createElement('span');
      indicator.className = 'runtime-state';
      indicator.dataset.state = item.status === 'passed' ? 'ready' : item.status;
      setText(indicator, statuses[item.status]);
      const body = document.createElement('div');
      const description = document.createElement('p');
      const message = descriptions[item.code];
      setText(description, typeof message === 'function' ? message(item) : message);
      body.append(description);
      const context = [
        [item.service ?? { frontend: 'Frontend', backend: 'Backend' }[item.role], Boolean(item.role)],
        [item.directory === '.' ? 'Project root' : item.directory, item.directory === '.'],
        [item.source, false]
      ].filter(([text]) => text);
      if (context.length) {
        const detail = document.createElement('p');
        detail.className = 'preflight-context';
        for (const [text, localize] of context) {
          if (detail.childNodes.length) detail.append(' · ');
          const label = document.createElement('span');
          if (localize) setText(label, text);
          else label.textContent = text;
          detail.append(label);
        }
        body.append(detail);
      }
      row.append(indicator, body);
      if (actions[item.action]) {
        const button = document.createElement('button');
        button.className = 'text-button';
        button.type = 'button';
        setText(button, actions[item.action]);
        button.addEventListener('click', () => runAction(item));
        row.append(button);
      }
      return row;
    });
  }

  function update() {
    const message = view.error ?? (view.loading ? 'Checking startup readiness…' : view.message);
    if (shownMessage !== message) {
      shownMessage = message;
      status.hidden = !message;
      setText(status, message);
    }
    if (rendered !== view.items) {
      rendered = view.items;
      results.replaceChildren(...rows(rendered ?? []));
    }
    results.hidden = !view.items;
    check.disabled = view.locked || view.loading || view.opening;
    for (const button of results.querySelectorAll('button')) button.disabled = view.locked || view.opening;
    $('preflight-start-actions').hidden = !view.canStart || !view.items || view.items.some(item => item.status === 'attention');
    startButton.disabled = view.locked || view.opening;
  }

  async function runAction(item) {
    const current = view;
    if (current.locked || current.opening) return;
    current.opening = true;
    current.error = undefined;
    update();
    try { await followAction(item); }
    catch (error) { current.error = error.message; }
    finally {
      current.opening = false;
      if (view === current) update();
    }
  }

  check.addEventListener('click', async () => {
    const project = selectedProject();
    const current = view;
    if (!project?.imported || !current || check.disabled) return;
    Object.assign(current, { loading: true, error: undefined, items: undefined, message: undefined });
    update();
    try {
      const { items } = await request('/api/projects/' + encodeURIComponent(project.id) + '/startup-preflight', { signal: AbortSignal.timeout(15000) });
      current.items = items;
      current.message = items.some(item => item.status === 'attention') ? 'Review the items that need attention.' : 'No blockers found in these checks.';
    } catch (error) {
      current.error = error.name === 'TimeoutError' ? 'Startup preflight timed out. Run it again.' : error.message;
    } finally {
      current.loading = false;
      if (view === current) update();
    }
  });
  startButton.addEventListener('click', () => {
    const project = selectedProject();
    if (project && !startButton.disabled && !$('preflight-start-actions').hidden) void start(project.id);
  });

  return {
    render(project, locked, canStart) {
      panel.hidden = !project?.imported;
      if (panel.hidden) { view = undefined; return; }
      const key = JSON.stringify([project.id, project.path, project.startupServices, project.ports,
        project.status, project.diagnostic, project.dependencies?.status]);
      if (view?.key !== key) {
        const message = view?.id === project.id && view.items && canStart ? 'Project state changed. Run preflight again.' : undefined;
        view = { id: project.id, key, message };
      }
      const hasSelectedDetails = project.unmanaged ? Array.isArray(project.startupServices) : Boolean(project.ports);
      Object.assign(view, { locked: locked || !hasSelectedDetails, canStart });
      update();
    }
  };
}
