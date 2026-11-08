import { setText, setupI18n, translate } from './i18n.js';

setupI18n();

const $ = id => document.getElementById(id);
const stateLabels = { stopped: '已停止', starting: '正在启动…', running: '运行中', stopping: '正在停止…', failed: '启动失败或异常退出' };
const stackNames = { vue: 'Vue', react: 'React', express: 'Express', nestjs: 'NestJS', spring: 'Spring Boot', mysql: 'MySQL', postgres: 'PostgreSQL' };
const removesFiles = project => !project.removeOnly;
const diagnosticMessages = {
  port: 'Free the occupied port, or choose a different one under Development ports if this project supports it.',
  java: 'Set JAVA_HOME and PATH to a JDK that supports Java 21, then restart StackForge and try again.',
  docker: 'Start Docker Desktop or the Docker Engine, wait until it is ready, then start the project again.',
  database: 'Check the database startup output for Docker, port, or configuration errors, then try again.',
  dependencies: 'Use Install dependencies, then start the project again.',
  waiting: 'The process is still running. Check the log for progress, especially on a first build or database download.'
};
const rows = new Map();
let projects = [];
let selected;
let pending;
let confirming;
let restoring;
let transferMessage;
let importing = false;
let actionError;
let portMessage;
let startupMessage;
let databaseView;
let toolsView;
let timer;
let revision = 0;

async function request(url, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { diagnostic: data.diagnostic });
  return data;
}

function post(url, token, data, timeout = 5000) {
  return request(url, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(data) });
}

function showState(element, status) {
  if (element.dataset.state === status) return;
  element.dataset.state = status;
  setText(element, status === 'ready' ? '已就绪' : stateLabels[status]);
}

function showMessage(element, message = '') {
  if (element.dataset.message === message) return;
  element.dataset.message = message;
  setText(element, message);
}

function renderServices(project) {
  const readyCustom = Object.values(project.services ?? {}).filter(service => service.name && service.ready);
  const links = $('runtime-custom-links');
  const saved = JSON.stringify(readyCustom);
  if (links.dataset.saved !== saved) {
    links.dataset.saved = saved;
    links.replaceChildren(...readyCustom.map(service => {
      const link = document.createElement('a');
      Object.assign(link, { className: 'secondary', href: service.url, target: '_blank', rel: 'noopener noreferrer', textContent: service.name });
      return link;
    }));
  }
  links.hidden = !readyCustom.length;
  $('runtime-services').hidden = !Object.keys(project.services ?? {}).length;
  $('runtime-readiness').hidden = project.ready;
  for (const key of ['frontend', 'backend']) {
    const link = $('runtime-' + key);
    const service = project.services?.[key];
    link.hidden = !service?.ready;
    if (service?.ready) link.href = service.url;
    else link.removeAttribute('href');
  }
}

function startupDraft() {
  return [...$('project-startup-services').children].map(row => {
    const { name, directory, command, port } = Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.name, input.value.trim()]));
    return { name, directory: directory.replaceAll('\\', '/') || '.', command, ...(port && { port: Number(port) }) };
  });
}

function addStartupService(service = {}) {
  const row = $('project-startup-service').content.firstElementChild.cloneNode(true);
  for (const element of row.querySelectorAll('[data-i18n]')) setText(element, element.dataset.i18n);
  for (const input of row.querySelectorAll('input')) {
    input.value = service[input.name] ?? '';
    if (input.dataset.i18nPlaceholder) input.placeholder = translate(input.dataset.i18nPlaceholder);
  }
  $('project-startup-services').append(row);
  return row;
}

function renderStartup(project, locked) {
  const panel = $('project-startup');
  const form = $('project-startup-form');
  const rows = $('project-startup-services');
  panel.hidden = !project.unmanaged;
  if (panel.hidden) return false;
  if (form.dataset.project !== project.id) {
    panel.open = !project.hasStartup;
    form.dataset.project = project.id;
    delete form.dataset.saved;
    rows.replaceChildren();
  }
  if (project.startupServices) {
    const saved = JSON.stringify(project.startupServices);
    if (form.dataset.saved !== saved) {
      form.dataset.saved = saved;
      rows.replaceChildren();
      project.startupServices.forEach(addStartupService);
    }
  }
  form.hidden = form.dataset.saved === undefined;
  const dirty = !form.hidden && JSON.stringify(startupDraft()) !== form.dataset.saved;
  for (const [index, row] of [...rows.children].entries()) {
    setText(row.querySelector('legend'), `Service ${index + 1}`);
    row.disabled = locked;
  }
  $('project-startup-empty').hidden = Boolean(rows.childElementCount);
  $('project-startup-hint').hidden = !rows.childElementCount;
  $('project-startup-add').disabled = locked || rows.childElementCount >= 6;
  $('project-startup-save').disabled = locked || !dirty;
  const message = startupMessage?.id === project.id ? startupMessage : undefined;
  const saving = pending?.id === project.id && pending.action === 'startup';
  const feedback = $('project-startup-message');
  feedback.classList.toggle('project-operation-error', Boolean(message?.error) && !saving);
  showMessage(feedback, saving ? 'Saving startup configuration…' : message?.message || (dirty ? 'Save changes before starting the project.' : ''));
  return dirty;
}

function renderPorts(project, busy) {
  const details = $('project-ports');
  const form = $('project-port-form');
  details.hidden = project.unmanaged || !project.portDefaults;
  if (details.hidden) return;
  $('project-ports-legacy').hidden = project.canConfigurePorts;
  form.hidden = !project.canConfigurePorts;
  const saved = JSON.stringify(project.ports);
  const changed = form.dataset.project !== project.id || form.dataset.saved !== saved;
  for (const field of form.querySelectorAll('input')) {
    field.parentElement.hidden = !Object.hasOwn(project.portDefaults, field.name);
    field.placeholder = project.portDefaults[field.name] ?? '';
    field.disabled = busy;
    if (changed) field.value = project.ports[field.name] ?? '';
  }
  form.dataset.project = project.id;
  form.dataset.saved = saved;
  form.querySelector('button').disabled = busy;
  const hint = $('project-ports-hint');
  if (hint.dataset.busy !== String(busy)) {
    hint.dataset.busy = String(busy);
    setText(hint, busy ? 'Stop the project before changing its ports.' : 'Leave fields blank to use project defaults. Changes apply on the next start.');
  }
  showMessage($('project-port-message'), portMessage?.id === project.id ? portMessage.message : '');
}

function renderOutput(output, id, log = '') {
  const follow = output.dataset.project !== id || output.scrollHeight - output.scrollTop - output.clientHeight < 32;
  output.dataset.project = id;
  if (output.textContent !== log) {
    output.textContent = log;
    if (follow) output.scrollTop = output.scrollHeight;
  }
}

function renderDependencies(project, busy, unavailable) {
  const task = project.dependencies;
  const installing = project.operation === 'dependencies' || (pending?.id === project.id && pending.action === 'install');
  const phases = { npm: 'Installing npm dependencies…', maven: 'Downloading Maven dependencies…' };
  const results = { succeeded: 'Dependencies installed.', failed: 'Installation failed.', cancelled: 'Installation cancelled.' };
  let status = results[task?.status] ?? (busy ? 'Stop the project before installing dependencies.' : '');
  if (installing) status = task?.status === 'cancelling' ? 'Cancelling installation…' : phases[task?.phase] ?? 'Preparing installation…';
  showMessage($('dependency-status'), status);
  $('install-dependencies').hidden = installing;
  $('install-dependencies').disabled = busy || unavailable;
  $('cancel-install').hidden = !installing;
  $('cancel-install').disabled = Boolean(pending) || task?.status === 'cancelling';
  const error = actionError?.id === project.id && actionError.action?.startsWith('install') ? actionError.message : task?.error;
  showMessage($('dependency-error'), error);
  $('dependency-error').hidden = !error;
  const details = $('dependency-log');
  if (details.dataset.project !== project.id) details.open = false;
  details.dataset.project = project.id;
  details.hidden = !task?.log;
  renderOutput($('dependency-output'), project.id, task?.log);
}

const databaseLabels = { absent: 'Database not created', stopped: '已停止', running: '运行中', starting: '正在启动…', stopping: '正在停止…', restarting: 'Restarting…', unhealthy: 'Health check failed', paused: 'Paused' };

function renderDatabase(project, busy, unavailable) {
  const details = $('project-database');
  details.hidden = project.database === 'none';
  if (databaseView?.id !== project.id) databaseView = { id: project.id, next: 0 };
  const view = databaseView;
  const task = project.databaseTask;
  if (view.taskStatus !== task?.status) view.next = 0;
  view.taskStatus = task?.status;
  const changing = project.operation === 'databaseTask';
  const state = changing ? (task?.phase === 'database-stop' ? 'stopping' : 'starting') : view.status;
  $('database-engine').textContent = stackNames[project.database] ?? '';
  showMessage($('database-status'), databaseLabels[state] ?? (view.error ? 'Database status unavailable' : 'Checking database…'));
  const transitioning = busy && !project.initialized;
  const disabled = unavailable || transitioning || !view.status || Boolean(view.error);
  $('database-start').disabled = disabled || ['running', 'starting', 'restarting', 'paused'].includes(state);
  $('database-stop').disabled = disabled || ['absent', 'stopped'].includes(state);
  $('database-logs').disabled = view.loading || !view.status || state === 'absent' || Boolean(view.error);
  $('database-backup').disabled = unavailable || state !== 'running';
  $('database-restore').disabled = unavailable || busy || state !== 'running';
  const transfer = transferMessage?.id === project.id ? transferMessage.message : '';
  showMessage($('database-transfer-message'), transfer);
  $('database-transfer-message').hidden = !transfer;
  const issue = task?.diagnostic ?? view.diagnostic;
  const hint = issue === 'docker' ? 'Start Docker Desktop or the Docker Engine to manage the database.' : diagnosticMessages[issue];
  const error = actionError?.id === project.id && actionError.action?.startsWith('database-') ? actionError.message : hint ?? task?.error ?? view.error;
  showMessage($('database-error'), error);
  $('database-error').hidden = !error;
  $('database-transition').hidden = !transitioning || Boolean(error);
  $('database-output').hidden = !task?.log || task.status === 'succeeded';
  renderOutput($('database-output'), project.id, task?.log);
  $('database-log-empty').hidden = view.log !== '';
  $('database-container-log').hidden = !view.log;
  renderOutput($('database-container-log'), project.id, view.log);
}

async function backupAction(project, file) {
  if (!project || pending) return;
  pending = { id: project.id, action: file ? 'database-restore' : 'database-backup' };
  transferMessage = { id: project.id, message: file ? 'Restoring database…' : 'Preparing backup…' };
  render();
  try {
    const { token } = await request('/api/state');
    const response = await fetch(`/api/projects/${project.id}/${pending.action}`, {
      method: 'POST', signal: AbortSignal.timeout(660_000),
      headers: { 'X-StackForge-Token': token, 'Content-Type': file ? 'application/octet-stream' : 'application/json',
        ...(file && { 'X-StackForge-Confirm-Name': project.name }) },
      body: file ?? '{}'
    });
    if (!response.ok) throw new Error((await response.json()).error);
    if (!file) {
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition'))?.[1] ?? 'database-backup';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    transferMessage.message = file ? 'Database restored.' : 'Backup download started.';
  } catch (error) { transferMessage.message = error.message; }
  finally {
    pending = undefined;
    render();
    refresh();
  }
}

async function loadDatabase(logs = false) {
  const view = databaseView;
  if (!view || view.loading || (!logs && Date.now() < view.next) || !$('project-database').open || $('project-database').hidden) return;
  view.loading = true;
  $('database-logs').disabled = true;
  try {
    // Allow time for the Compose list, inspection, and optional log commands.
    const state = await request(`/api/projects/${view.id}/database${logs ? '?logs=1' : ''}`, { signal: AbortSignal.timeout(50_000) });
    Object.assign(view, state, { error: undefined, diagnostic: undefined });
    if (logs && state.log === undefined) view.log = '';
    if (!logs && state.status === 'absent') view.log = undefined;
  } catch (error) { Object.assign(view, { error: error.message, diagnostic: error.diagnostic }); }
  finally {
    view.loading = false;
    view.next = Date.now() + 3500;
    if (view === databaseView) render();
  }
}

const checkStates = { running: 'Check running…', cancelling: 'Cancelling check…', succeeded: 'Check passed', failed: 'Check failed', cancelled: 'Check cancelled' };
const checkScopes = { root: 'Project · {command}', frontend: 'Frontend · {command}', backend: 'Backend · {command}', maven: 'Backend · {command}' };

function checkLabel(id) {
  const [scope, name] = id.split(':');
  const command = scope === 'maven' ? `Maven Wrapper ${name}` : `npm run ${name}`;
  return checkScopes[scope].replace('{command}', command);
}

function renderChecks(project, busy, unavailable) {
  const view = toolsView.checks;
  const task = project.checkTask;
  const launching = pending?.id === project.id && pending.action === 'run-check';
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
  $('check-cancel').disabled = Boolean(pending) || status === 'cancelling';
  showMessage($('check-message'), view.loading ? 'Reading available checks…' : view.data && !loaded ? 'No build, test, or lint commands were found.' : loaded && busy ? 'Stop the project before running checks.' : '');
  const error = actionError?.id === project.id && ['run-check', 'check-cancel'].includes(actionError.action) ? actionError.message : view.error ?? task?.error;
  showMessage($('check-error'), error);
  $('check-error').hidden = !error;
  $('check-last').hidden = !task?.phase;
  showMessage($('check-last-command'), task?.phase ? checkLabel(task.phase) : '');
  $('check-output').hidden = !task?.log;
  renderOutput($('check-output'), project.id, task?.log);
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
  if (!view || current.id !== selected || !$('project-' + tool).open || view.loading || (!reload && (view.data || view.error))) return;
  view.loading = true;
  render();
  try {
    view.data = await request(`/api/projects/${current.id}/${tool}`, { signal: AbortSignal.timeout(12000) });
    view.error = undefined;
    if (tool === 'checks' && current === toolsView) {
      const field = $('check-command');
      const previous = field.value;
      field.replaceChildren(...view.data.checks.map(({ id }) => {
        const option = document.createElement('option');
        option.value = id;
        setText(option, checkLabel(id));
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

function renderRows() {
  const filter = $('project-search').value.trim().toLowerCase();
  const list = $('project-list');
  for (const [id, row] of rows) if (!projects.some(project => project.id === id)) { row.remove(); rows.delete(id); }
  let matches = 0;
  for (const [index, project] of projects.entries()) {
    let row = rows.get(project.id);
    if (!row) {
      row = $('project-row').content.firstElementChild.cloneNode(true);
      row.querySelector('strong').textContent = project.name;
      const frameworks = project.unmanaged ? project.frameworks : [project.frontend, project.backend, project.database].map(key => stackNames[key]).filter(Boolean);
      setText(row.querySelector('small'), frameworks.join(' / ') || 'External project');
      row.firstElementChild.addEventListener('click', () => {
        if (selected !== project.id) actionError = undefined;
        selected = project.id;
        render();
        refresh();
        if (matchMedia('(max-width: 800px)').matches) {
          $('selected-project-name').focus({ preventScroll: true });
          $('project-detail').scrollIntoView({ block: 'start' });
        }
      });
      rows.set(project.id, row);
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    row.hidden = !project.name.toLowerCase().includes(filter) && !project.path.toLowerCase().includes(filter);
    if (!row.hidden) matches++;
    row.firstElementChild.setAttribute('aria-pressed', String(project.id === selected));
    const status = row.querySelector('.runtime-state');
    status.hidden = Boolean(project.unmanaged && !project.hasStartup);
    showState(status, project.ready ? 'ready' : project.status);
  }
  $('project-no-match').hidden = matches > 0;
}

function render() {
  if ($('project-trash-dialog').open) {
    const backingUp = pending?.action === 'database-backup';
    $('project-trash-backup').disabled = Boolean(pending);
    $('project-trash-confirm').disabled = backingUp || $('project-trash-name').value !== confirming?.name;
    const message = confirming?.database !== 'none' && transferMessage?.id === confirming?.id ? transferMessage?.message : '';
    showMessage($('project-trash-backup-message'), message);
    $('project-trash-backup-message').hidden = !message;
  }
  $('project-manager').hidden = !projects.length;
  $('project-empty').hidden = projects.length > 0;
  renderRows();
  const project = projects.find(item => item.id === selected);
  if (!project) return;
  for (const id of ['runtime-action', 'selected-project-state', 'project-runtime-log']) $(id).hidden = Boolean(project.unmanaged && !project.hasStartup);
  $('project-dependencies').hidden = Boolean(project.unmanaged);
  if ($('selected-project-name').textContent !== project.name) $('selected-project-name').textContent = project.name;
  if ($('selected-project-path').textContent !== project.path) $('selected-project-path').textContent = project.path;
  showState($('selected-project-state'), project.ready ? 'ready' : project.status);
  renderServices(project);
  const running = project.status === 'running' || project.status === 'starting';
  const busy = running || project.status === 'stopping';
  const deleting = project.deleting || (pending?.id === project.id && pending.action === 'trash');
  const unavailable = deleting || Boolean(pending) || Boolean(project.operation);
  const startupDirty = renderStartup(project, busy || unavailable);
  renderPorts(project, busy || unavailable);
  renderDependencies(project, busy, unavailable);
  renderDatabase(project, busy, unavailable);
  if (toolsView?.id !== project.id) {
    toolsView = { id: project.id, checks: {}, git: {} };
    $('check-command').replaceChildren();
  }
  renderChecks(project, busy, unavailable);
  renderGit();
  const action = $('runtime-action');
  action.dataset.action = running ? 'stop' : 'start';
  action.className = running || project.status === 'stopping' ? 'secondary' : 'primary';
  action.disabled = Boolean(pending) || deleting || project.status === 'stopping' || (!running && (Boolean(project.operation) || startupDirty));
  setText(action.firstElementChild, project.status === 'stopping' ? 'Stopping…' : running ? 'Stop project' : 'Start project');
  const devError = actionError?.id === project.id && ['start', 'stop'].includes(actionError.action) ? actionError : undefined;
  const error = devError?.message ?? project.error;
  $('runtime-error').hidden = !error;
  showMessage($('runtime-error'), error);
  const issue = devError?.diagnostic ?? project.diagnostic;
  const diagnostic = issue === 'dependencies' && project.dependencies?.status === 'succeeded' ? undefined : diagnosticMessages[issue];
  const diagnosticField = $('runtime-diagnostic');
  showMessage(diagnosticField, diagnostic);
  diagnosticField.hidden = !diagnostic;
  $('project-delete').disabled = busy || unavailable;
  setText($('project-delete').querySelector('span'), removesFiles(project) ? 'Delete project' : 'Remove from Projects');
  $('project-delete-hint').hidden = !busy && !deleting && !project.operation;
  setText($('project-delete-hint'), deleting ? 'Moving to trash…' : project.operation ? 'Wait for the current project operation to finish.' : 'Stop the project first.');
  const output = $('runtime-output');
  const log = project.log ?? '';
  output.hidden = !log;
  $('runtime-log-empty').hidden = Boolean(log);
  $('runtime-log-truncated').hidden = !project.truncated;
  renderOutput(output, project.id, log);
}

async function refresh() {
  clearTimeout(timer);
  const version = ++revision;
  const requested = selected;
  try {
    const data = await request('/api/projects' + (requested ? `?logs=${encodeURIComponent(requested)}` : ''));
    if (version !== revision) return;
    projects = data.projects;
    if (!projects.some(item => item.id === selected)) selected = projects[0]?.id;
    $('project-connection').hidden = true;
    render();
    if (selected && selected !== requested) { refresh(); return; }
    loadDatabase();
    loadProjectTool('checks');
    loadProjectTool('git');
  } catch {
    if (version !== revision) return;
    $('project-connection').hidden = false;
    setText($('project-connection'), 'Cannot reach StackForge. Reconnecting…');
  } finally {
    if (version === revision && !document.hidden) timer = setTimeout(refresh, 1200);
  }
}

async function act(id, action, body = {}) {
  if (!id || pending) return;
  pending = { id, action };
  actionError = undefined;
  $('project-feedback').dataset.status = 'ok';
  setText($('project-feedback'), '');
  render();
  try {
    const { token } = await request('/api/state');
    const runtime = await post(`/api/projects/${id}/${action}`, token, body, action === 'trash' ? 180_000 : 5000);
    if (action === 'trash') {
      projects = projects.filter(item => item.id !== id);
      if (selected === id) selected = projects[0]?.id;
      setText($('project-feedback'), runtime.removed ? 'Project removed from Projects.' :
        runtime.databaseDeleted ? 'Project moved to the system trash and its database was deleted.' : 'Project moved to the system trash.');
    } else if (action === 'ports') {
      const project = projects.find(item => item.id === id);
      if (project) project.ports = runtime.ports;
      portMessage = { id, message: 'Development ports saved.' };
    } else if (action === 'startup') {
      const project = projects.find(item => item.id === id);
      if (project) Object.assign(project, { startupServices: runtime.services, hasStartup: Boolean(runtime.services.length) });
      startupMessage = { id, message: 'Startup configuration saved.' };
    } else if (['install', 'install-cancel', 'database-start', 'database-stop', 'run-check', 'check-cancel'].includes(action)) {
      const project = projects.find(item => item.id === id);
      if (project) Object.assign(project, runtime);
    } else {
      const project = projects.find(item => item.id === id);
      if (project) Object.assign(project, { status: runtime.status, error: runtime.error, services: runtime.services, ready: runtime.ready, initialized: runtime.initialized, diagnostic: runtime.diagnostic });
    }
  } catch (error) {
    if (action === 'trash') {
      $('project-feedback').dataset.status = 'error';
      setText($('project-feedback'), error.message);
    } else if (action === 'ports') portMessage = { id, message: error.message };
    else if (action === 'startup') startupMessage = { id, message: error.message, error: true };
    else actionError = { id, action, message: error.message, diagnostic: error.diagnostic };
  }
  finally {
    pending = undefined;
    render();
    if (action === 'trash') $('project-feedback').focus();
    refresh();
  }
}

function showImport(open) {
  $('project-import').hidden = !open;
  $('project-import-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    $('project-import-path').focus();
    request('/api/state').then(({ defaultDir }) => { $('project-clone-parent').value ||= defaultDir; }).catch(() => {});
  }
}

async function importAction(browse, clone = false) {
  if (importing) return;
  importing = true;
  const path = $(clone ? 'project-clone-parent' : 'project-import-path');
  const controls = ['project-import-toggle', 'project-import-browse', 'project-import-submit', 'project-clone-browse', 'project-clone-submit'].map($);
  for (const control of controls) control.disabled = true;
  path.readOnly = true;
  const message = $(clone ? 'project-clone-message' : 'project-import-message');
  setText(message, browse ? 'Choose a folder in the system dialog.' : clone ? 'Cloning repository…' : 'Adding project…');
  try {
    const { token, defaultDir } = await request('/api/state');
    if (browse) {
      const result = await post('/api/desktop/pick-directory', token, { initialDir: path.value.trim() || defaultDir, language: document.documentElement.lang }, 610000);
      if (result.path) path.value = result.path;
      setText(message, result.path ? 'Folder selected.' : 'Folder selection cancelled.');
    } else {
      const project = clone ? await post('/api/projects/clone', token, { repository: $('project-clone-url').value.trim(), parentDir: path.value.trim() }, 190000)
        : await post('/api/projects/import', token, { path: path.value.trim() });
      selected = project.id;
      projects = [{ ...project, status: 'stopped' }, ...projects.filter(item => item.id !== project.id)];
      $('project-search').value = '';
      if (clone) $('project-clone-url').value = '';
      else path.value = '';
      showImport(false);
      setText(message, '');
      $('project-feedback').dataset.status = 'ok';
      setText($('project-feedback'), 'Project added to Projects.');
      render();
      $('project-feedback').focus();
      refresh();
    }
  } catch (error) { setText(message, error.message); }
  finally {
    importing = false;
    for (const control of controls) control.disabled = false;
    path.readOnly = false;
  }
}

$('project-search').addEventListener('input', renderRows);
$('project-import-toggle').addEventListener('click', () => showImport($('project-import').hidden));
$('project-import-browse').addEventListener('click', () => importAction(true));
$('project-import-form').addEventListener('submit', event => { event.preventDefault(); importAction(false); });
$('project-clone-browse').addEventListener('click', () => importAction(true, true));
$('project-clone-form').addEventListener('submit', event => { event.preventDefault(); importAction(false, true); });
$('project-port-form').addEventListener('submit', event => {
  event.preventDefault();
  const ports = {};
  for (const field of event.currentTarget.querySelectorAll('input')) if (!field.parentElement.hidden && field.value) ports[field.name] = field.valueAsNumber;
  portMessage = undefined;
  act(selected, 'ports', { ports });
});
$('runtime-action').addEventListener('click', event => act(selected, event.currentTarget.dataset.action));
$('project-startup-add').addEventListener('click', () => {
  startupMessage = undefined;
  const row = addStartupService();
  render();
  row.querySelector('input').focus();
});
$('project-startup-services').addEventListener('click', event => {
  if (!event.target.closest('.startup-remove')) return;
  const row = event.target.closest('.startup-service');
  const next = row.nextElementSibling ?? row.previousElementSibling;
  row.remove();
  startupMessage = undefined;
  render();
  (next?.querySelector('input') ?? $('project-startup-add')).focus();
});
$('project-startup-form').addEventListener('input', () => {
  startupMessage = undefined;
  render();
});
$('project-startup-form').addEventListener('submit', event => {
  event.preventDefault();
  act(selected, 'startup', { services: startupDraft() });
});
$('install-dependencies').addEventListener('click', () => { $('dependency-log').open = true; act(selected, 'install'); });
$('cancel-install').addEventListener('click', () => act(selected, 'install-cancel'));
$('project-database').addEventListener('toggle', () => loadDatabase());
$('database-start').addEventListener('click', () => act(selected, 'database-start'));
$('database-stop').addEventListener('click', () => act(selected, 'database-stop'));
$('database-logs').addEventListener('click', () => loadDatabase(true));
$('database-backup').addEventListener('click', () => backupAction(projects.find(project => project.id === selected)));
$('database-restore').addEventListener('click', () => {
  restoring = projects.find(project => project.id === selected);
  if (!restoring || pending) return;
  $('database-restore-form').reset();
  $('database-restore-file').accept = restoring.database === 'postgres' ? '.dump' : '.sql';
  $('database-restore-expected').textContent = restoring.name;
  $('database-restore-submit').disabled = true;
  $('database-restore-dialog').showModal();
});
function validRestore() {
  const file = $('database-restore-file').files[0];
  return file?.size > 0 && file.size <= 64 * 1024 * 1024 && $('database-restore-name').value === restoring?.name && !pending;
}
$('database-restore-form').addEventListener('input', () => { $('database-restore-submit').disabled = !validRestore(); });
$('database-restore-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!validRestore()) return;
  $('database-restore-dialog').close();
  backupAction(restoring, $('database-restore-file').files[0]);
});
$('database-restore-cancel').addEventListener('click', () => $('database-restore-dialog').close());
for (const tool of ['checks', 'git']) $('project-' + tool).addEventListener('toggle', () => loadProjectTool(tool, true));
$('git-refresh').addEventListener('click', () => loadProjectTool('git', true));
$('check-form').addEventListener('submit', event => {
  event.preventDefault();
  act(selected, 'run-check', { check: $('check-command').value });
});
$('check-cancel').addEventListener('click', () => act(selected, 'check-cancel'));
$('project-delete').addEventListener('click', () => {
  const project = projects.find(item => item.id === selected);
  if (!project || pending) return;
  confirming = project;
  transferMessage = undefined;
  $('project-trash-path').textContent = project.path;
  $('project-trash-expected').textContent = project.name;
  $('project-trash-name').value = '';
  $('project-trash-confirm').disabled = true;
  const deleteFiles = removesFiles(project);
  $('project-trash-backup').hidden = !deleteFiles || project.database === 'none';
  setText($('project-trash-title'), deleteFiles ? 'Delete project?' : 'Remove project from Projects?');
  setText($('project-trash-instruction'), deleteFiles ? 'Type the project name below to confirm deletion.' : 'Type the project name below to confirm removal.');
  setText($('project-trash-confirm'), deleteFiles ? 'Delete project' : 'Remove from Projects');
  setText($('project-trash-description'), !deleteFiles ? 'This removes the entry from the Projects list. Your files stay in this folder.' : project.database !== 'none'
    ? 'The project folder will move to the system trash. Its local database and data volume will be permanently deleted.'
    : 'The entire local project folder will move to the system trash. You can restore it from there.');
  $('project-trash-dialog').showModal();
  render();
});
$('project-trash-backup').addEventListener('click', () => backupAction(confirming));
$('project-trash-cancel').addEventListener('click', () => $('project-trash-dialog').close());
$('project-trash-name').addEventListener('input', event => {
  $('project-trash-confirm').disabled = Boolean(pending) || event.target.value !== confirming?.name;
});
$('project-trash-form').addEventListener('submit', event => {
  event.preventDefault();
  const confirmName = $('project-trash-name').value;
  if (!confirming || pending || confirmName !== confirming.name) return;
  $('project-trash-dialog').close();
  act(confirming.id, 'trash', { confirmName });
});
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });
refresh();
