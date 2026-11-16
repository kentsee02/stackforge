import { setText } from '/i18n.js';

export function createProjectToolsPanel({ $, request, showMessage, renderOutput, state, selectedId, renderPage: render, act }) {
  let toolsView;

  const checkStates = { running: 'Check running…', cancelling: 'Cancelling check…', succeeded: 'Check passed', failed: 'Check failed', cancelled: 'Check cancelled' };
  const checkScopes = { root: 'Project · {command}', frontend: 'Frontend · {command}', backend: 'Backend · {command}', maven: 'Backend · {command}' };
  const checkTypes = { build: 'Build', test: 'Test', lint: 'Lint' };
  let checkConfigMessage;

  function checkLabel(id, check) {
    const parts = id.split(':');
    const scope = parts[0], name = parts.at(-1);
    const command = check?.command ?? (scope === 'maven' ? `Maven Wrapper ${name}` : `npm run ${name}`);
    if (scope === 'custom') return check ? `${check.directory} · Custom ${checkTypes[check.name]} · ${command}` : checkTypes[name];
    if (scope === 'service' || scope === 'tool') return check ? `${check.directory} · ${command}` : checkTypes[name];
    return checkScopes[scope].replace('{command}', command);
  }

  function checkDraft() {
    return [...$('check-config-rows').children].map(row => ({
      name: row.querySelector('[name="name"]').value,
      directory: row.querySelector('[name="directory"]').value.trim().replaceAll('\\', '/') || '.',
      command: row.querySelector('[name="command"]').value.trim()
    }));
  }

  function addCheckRow(check = { name: 'build', directory: '.', command: '' }) {
    const row = $('check-config-row').content.firstElementChild.cloneNode(true);
    for (const element of row.querySelectorAll('[data-i18n]')) setText(element, element.dataset.i18n);
    for (const field of row.querySelectorAll('input, select')) field.value = check[field.name];
    $('check-config-rows').append(row);
    return row;
  }

  function renderCheckConfig(project, locked, data) {
    const rows = $('check-config-rows');
    if (rows.dataset.project !== project.id) {
      rows.dataset.project = project.id;
      delete rows.dataset.saved;
      rows.replaceChildren();
      $('check-config-editor').open = false;
    }
    if (data && rows.dataset.saved === undefined) {
      rows.dataset.saved = JSON.stringify(data.customChecks);
      data.customChecks.forEach(addCheckRow);
    }
    const ready = rows.dataset.saved !== undefined;
    $('check-config-editor').hidden = !ready;
    for (const row of rows.children) row.disabled = locked;
    $('check-config-add').disabled = locked || rows.childElementCount >= 12;
    $('check-config-save').disabled = locked || !ready || JSON.stringify(checkDraft()) === rows.dataset.saved;
    const feedback = checkConfigMessage?.id === project.id ? checkConfigMessage : undefined;
    const message = $('check-config-message');
    message.classList.toggle('project-operation-error', Boolean(feedback?.error));
    showMessage(message, feedback?.message ?? '');
  }

  function renderChecks(project, busy, unavailable) {
    const view = toolsView.checks;
    const task = project.checkTask;
    const launching = state.pending?.id === project.id && state.pending.action === 'run-check';
    const status = launching ? 'running' : task?.status;
    const active = project.operation === 'checkTask' || launching;
    const loaded = Boolean(view.data?.checks.length);
    const statusLabel = $('check-status');
    statusLabel.dataset.status = status ?? '';
    showMessage(statusLabel, active ? checkStates[status] ?? checkStates.running : checkStates[status]);
    $('check-form').hidden = !loaded && !active;
    $('check-command').disabled = unavailable || view.loading || !loaded;
    $('run-check').disabled = busy || unavailable || view.loading || !loaded;
    $('run-check').hidden = active;
    $('check-cancel').hidden = !active;
    $('check-cancel').disabled = Boolean(state.pending) || status === 'cancelling';
    showMessage($('check-message'), view.loading ? 'Reading available checks…' : view.data && !loaded ? 'No build, test, or lint commands were found.' : loaded && busy ? 'Stop the project before running checks.' : '');
    const error = state.actionError?.id === project.id && ['run-check', 'check-cancel'].includes(state.actionError.action) ? state.actionError.message : view.error ?? task?.error;
    showMessage($('check-error'), error);
    $('check-error').hidden = !error;
    $('check-last').hidden = !task?.phase;
    const lastCheck = view.data?.checks.find(check => check.id === task?.phase);
    showMessage($('check-last-command'), task?.phase ? checkLabel(task.phase, lastCheck) : '');
    $('check-output').hidden = !task?.log;
    renderOutput($('check-output'), project.id, task?.log);
    renderCheckConfig(project, unavailable || view.loading, view.data);
  }

  function renderGit() {
    const { data, loading, error } = toolsView.git;
    const available = data?.status === 'available' && !error;
    $('git-summary').hidden = !available;
    $('git-initial').hidden = !available || !data.initial;
    $('git-refresh').disabled = Boolean(loading);
    showMessage($('git-message'), loading ? 'Reading Git status…' : error ?? (data?.status === 'absent' ? 'This project has no local Git repository.' : ''));
    if (!available) return;
    $('git-branch').textContent = data.branch ?? '';
    $('git-branch').hidden = !data.branch;
    $('git-detached').hidden = Boolean(data.branch);
    showMessage($('git-changes'), data.changes === 0 ? 'Clean' : data.changes === 1 ? '1 change' : `${data.changes} changes`);
    $('git-upstream').textContent = data.upstream ?? '';
    $('git-upstream').hidden = !data.upstream;
    $('git-no-upstream').hidden = Boolean(data.upstream);
    $('git-comparison').hidden = !data.upstream;
    showMessage($('git-comparison'), data.ahead === null ? 'Local comparison unavailable' : `${data.ahead} ahead · ${data.behind} behind`);
  }

  async function loadProjectTool(tool, reload = false) {
    const current = toolsView;
    const view = current?.[tool];
    if (!view || current.id !== selectedId() || !$('project-' + tool).open || view.loading || (!reload && (view.data || view.error))) return;
    view.loading = true;
    render();
    try {
      view.data = await request(`/api/projects/${current.id}/${tool}`, { signal: AbortSignal.timeout(12000) });
      view.error = undefined;
      if (tool === 'checks' && current === toolsView) {
        const field = $('check-command');
        const previous = field.value;
        field.replaceChildren(...view.data.checks.map(check => {
          const option = document.createElement('option');
          option.value = check.id;
          setText(option, checkLabel(check.id, check));
          return option;
        }));
        if (view.data.checks.some(check => check.id === previous)) field.value = previous;
      }
    } catch (error) {
      view.data = undefined;
      view.error = error.message;
    } finally {
      view.loading = false;
      if (current === toolsView) render();
    }
  }

  function renderTools(project, busy, unavailable) {
    if (toolsView?.id !== project.id) {
      toolsView = { id: project.id, checks: {}, git: {} };
      $('check-command').replaceChildren();
    }
    renderChecks(project, busy, unavailable);
    renderGit();
  }

  function invalidateChecks(id) {
    if (toolsView?.id === id) toolsView = { ...toolsView, checks: {} };
  }

  function saveChecks(id, commands) {
    if (toolsView?.id === id) $('check-config-rows').dataset.saved = JSON.stringify(commands);
    invalidateChecks(id);
    checkConfigMessage = { id, message: 'Custom check commands saved.' };
  }

  for (const tool of ['checks', 'git']) {
    $('project-' + tool).addEventListener('toggle', () => loadProjectTool(tool, true));
  }
  $('git-refresh').addEventListener('click', () => loadProjectTool('git', true));
  $('check-form').addEventListener('submit', event => {
    event.preventDefault();
    act(selectedId(), 'run-check', { check: $('check-command').value });
  });
  $('check-cancel').addEventListener('click', () => act(selectedId(), 'check-cancel'));
  $('check-config-add').addEventListener('click', () => {
    const row = addCheckRow();
    checkConfigMessage = undefined;
    render();
    row.querySelector('select').focus();
  });
  $('check-config-rows').addEventListener('click', event => {
    const remove = event.target.closest('.startup-remove');
    if (!remove) return;
    remove.closest('fieldset').remove();
    checkConfigMessage = undefined;
    render();
    $('check-config-add').focus();
  });
  $('check-config-form').addEventListener('input', () => { checkConfigMessage = undefined; render(); });
  $('check-config-form').addEventListener('submit', event => {
    event.preventDefault();
    act(selectedId(), 'check-config', { commands: checkDraft() });
  });

  return { render: renderTools, load: loadProjectTool, saveChecks, invalidateChecks, setMessage(message) { checkConfigMessage = message; } };
}
