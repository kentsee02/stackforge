import { setText, setupI18n } from './i18n.js';

setupI18n();

const $ = id => document.getElementById(id);
const stateLabels = { stopped: '已停止', starting: '正在启动…', running: '运行中', stopping: '正在停止…', failed: '启动失败或异常退出' };
const stackNames = { vue: 'Vue', react: 'React', express: 'Express', spring: 'Spring Boot', mysql: 'MySQL', postgres: 'PostgreSQL' };
const diagnosticMessages = {
  port: 'Free the occupied port, or choose a different one under Development ports if this project supports it.',
  java: 'Set JAVA_HOME and PATH to a JDK that supports Java 21, then restart StackForge and try again.',
  docker: 'Start Docker Desktop or the Docker Engine, wait until it is ready, then start the project again.',
  database: 'Check the database startup output for Docker, port, or configuration errors, then try again.',
  dependencies: 'Run npm install from the project folder, then start the project again.',
  waiting: 'The process is still running. Check the log for progress, especially on a first build or database download.'
};
const rows = new Map();
let projects = [];
let selected;
let pending;
let confirming;
let actionError;
let portMessage;
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
  $('runtime-services').hidden = !project.services;
  $('runtime-readiness').hidden = project.ready;
  for (const key of ['frontend', 'backend']) {
    const link = $('runtime-' + key);
    const service = project.services?.[key];
    link.hidden = !service?.ready;
    if (service?.ready) link.href = service.url;
    else link.removeAttribute('href');
  }
}

function renderPorts(project, busy) {
  const details = $('project-ports');
  const form = $('project-port-form');
  details.hidden = !project.portDefaults;
  if (!project.portDefaults) return;
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
      row.querySelector('small').textContent = [project.frontend, project.backend, project.database].map(key => stackNames[key]).filter(Boolean).join(' / ');
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
    showState(row.querySelector('.runtime-state'), project.ready ? 'ready' : project.status);
  }
  $('project-no-match').hidden = matches > 0;
}

function render() {
  $('project-manager').hidden = !projects.length;
  $('project-empty').hidden = projects.length > 0;
  renderRows();
  const project = projects.find(item => item.id === selected);
  if (!project) return;
  if ($('selected-project-name').textContent !== project.name) $('selected-project-name').textContent = project.name;
  if ($('selected-project-path').textContent !== project.path) $('selected-project-path').textContent = project.path;
  showState($('selected-project-state'), project.ready ? 'ready' : project.status);
  renderServices(project);
  const running = project.status === 'running' || project.status === 'starting';
  const busy = running || project.status === 'stopping';
  const deleting = project.deleting || (pending?.id === project.id && pending.action === 'trash');
  renderPorts(project, busy || deleting || Boolean(pending));
  const action = $('runtime-action');
  action.dataset.action = running ? 'stop' : 'start';
  action.className = running || project.status === 'stopping' ? 'secondary' : 'primary';
  action.disabled = Boolean(pending) || deleting || project.status === 'stopping';
  setText(action.firstElementChild, project.status === 'stopping' ? 'Stopping…' : running ? 'Stop project' : 'Start project');
  const error = actionError?.id === project.id ? actionError.message : project.error;
  $('runtime-error').hidden = !error;
  showMessage($('runtime-error'), error);
  const diagnostic = diagnosticMessages[(actionError?.id === project.id && actionError.diagnostic) || project.diagnostic];
  const diagnosticField = $('runtime-diagnostic');
  showMessage(diagnosticField, diagnostic);
  diagnosticField.hidden = !diagnostic;
  $('runtime-database').hidden = project.database === 'none';
  $('project-delete').disabled = Boolean(pending) || busy || deleting;
  $('project-delete-hint').hidden = !busy && !deleting;
  setText($('project-delete-hint'), deleting ? 'Moving to trash…' : 'Stop the project first.');
  const output = $('runtime-output');
  const log = project.log ?? '';
  const follow = output.dataset.project !== project.id || output.scrollHeight - output.scrollTop - output.clientHeight < 32;
  output.dataset.project = project.id;
  output.hidden = !log;
  $('runtime-log-empty').hidden = Boolean(log);
  $('runtime-log-truncated').hidden = !project.truncated;
  if (output.textContent !== log) { output.textContent = log; if (follow) output.scrollTop = output.scrollHeight; }
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
    const runtime = await post(`/api/projects/${id}/${action}`, token, action === 'trash' ? { confirm: true } : body, action === 'trash' ? 30000 : 5000);
    if (action === 'trash') {
      projects = projects.filter(item => item.id !== id);
      if (selected === id) selected = projects[0]?.id;
      setText($('project-feedback'), 'Project moved to the system trash.');
    } else if (action === 'ports') {
      const project = projects.find(item => item.id === id);
      if (project) project.ports = runtime.ports;
      portMessage = { id, message: 'Development ports saved.' };
    } else {
      const project = projects.find(item => item.id === id);
      if (project) Object.assign(project, { status: runtime.status, error: runtime.error, services: runtime.services, ready: runtime.ready, diagnostic: runtime.diagnostic });
    }
  } catch (error) {
    if (action === 'trash') {
      $('project-feedback').dataset.status = 'error';
      setText($('project-feedback'), error.message);
    } else if (action === 'ports') portMessage = { id, message: error.message };
    else actionError = { id, message: error.message, diagnostic: error.diagnostic };
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
  if (open) $('project-import-path').focus();
}

async function importAction(browse) {
  const path = $('project-import-path');
  if (path.readOnly) return;
  const controls = [$('project-import-toggle'), $('project-import-browse'), $('project-import-submit')];
  for (const control of controls) control.disabled = true;
  path.readOnly = true;
  const message = $('project-import-message');
  setText(message, browse ? 'Choose a folder in the system dialog.' : 'Adding project…');
  try {
    const { token, defaultDir } = await request('/api/state');
    if (browse) {
      const result = await post('/api/desktop/pick-directory', token, { initialDir: path.value.trim() || defaultDir, language: document.documentElement.lang }, 610000);
      if (result.path) path.value = result.path;
      setText(message, result.path ? 'Folder selected.' : 'Folder selection cancelled.');
    } else {
      const project = await post('/api/projects/import', token, { path: path.value.trim() });
      selected = project.id;
      projects = [{ ...project, status: 'stopped' }, ...projects.filter(item => item.id !== project.id)];
      $('project-search').value = '';
      path.value = '';
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
    for (const control of controls) control.disabled = false;
    path.readOnly = false;
  }
}

$('project-search').addEventListener('input', renderRows);
$('project-import-toggle').addEventListener('click', () => showImport($('project-import').hidden));
$('project-import-browse').addEventListener('click', () => importAction(true));
$('project-import-form').addEventListener('submit', event => { event.preventDefault(); importAction(false); });
$('project-port-form').addEventListener('submit', event => {
  event.preventDefault();
  const ports = {};
  for (const field of event.currentTarget.querySelectorAll('input')) if (!field.parentElement.hidden && field.value) ports[field.name] = field.valueAsNumber;
  portMessage = undefined;
  act(selected, 'ports', { ports });
});
$('runtime-action').addEventListener('click', event => act(selected, event.currentTarget.dataset.action));
$('project-delete').addEventListener('click', () => {
  const project = projects.find(item => item.id === selected);
  if (!project || pending) return;
  confirming = project.id;
  $('project-trash-path').textContent = project.path;
  $('project-trash-dialog').showModal();
});
$('project-trash-confirm').addEventListener('click', () => {
  $('project-trash-dialog').close();
  act(confirming, 'trash');
});
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });
refresh();
