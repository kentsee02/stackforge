import { setText, setupI18n } from '/i18n.js';
import { createDatabasePanel } from '/projects/database.js';
import { createStartupPanel } from '/projects/startup.js';
import { createPreflightPanel } from '/projects/preflight.js';
import { createDependenciesPanel } from '/projects/dependencies.js';
import { createProjectToolsPanel } from '/projects/tools.js';
import { createDevelopmentPostgres } from '/projects/development-postgres.js';
import { createActivityPanel } from '/projects/activity.js';

setupI18n();

const $ = id => document.getElementById(id);
const stateLabels = { offline: '项目目录缺失', stopped: '已停止', starting: '正在启动…', running: '运行中', stopping: '正在停止…', failed: '启动失败或异常退出' };
const stackNames = { vue: 'Vue', react: 'React', express: 'Express', nestjs: 'NestJS', spring: 'Spring Boot', mysql: 'MySQL', postgres: 'PostgreSQL' };
const removesFiles = project => !project.removeOnly;
const diagnosticMessages = {
  port: 'Free the occupied port, or choose a different one under Development ports if this project supports it.',
  java: 'Java is missing or incompatible. Set JAVA_HOME and PATH to the JDK version required by this project, then restart StackForge.',
  databaseUrl: 'DATABASE_URL is missing. Set it in the project’s environment file or shell, then retry.',
  databaseConnection: 'Prisma could not reach the database. Start the database and check the host and port in DATABASE_URL.',
  dotnetSdk: 'The .NET SDK is missing or incompatible. Check the project’s target framework and any global.json version pin.',
  lockfile: 'The dependency lockfile does not match the project. Update it with the project’s package manager, then retry.',
  pnpmBuildApproval: 'pnpm blocked build scripts that need review. Check the Dependencies panel.',
  pythonDependencies: 'Python could not import a module. Check the service’s virtual environment and install its dependencies.',
  toolMissing: 'A required command was not found. Check the tool named in the log and make sure it is on PATH.',
  docker: 'Start Docker Desktop or the Docker Engine, wait until it is ready, then start the project again.',
  database: 'Check the database startup output for Docker, port, or configuration errors, then try again.',
  dependencies: 'Use Install dependencies, then start the project again.',
  waiting: 'The process is still running. Check the log for progress, especially on a first build or database download.',
  waitingLink: 'The configured access URL has not responded successfully. Check its HTTP port and access path in Startup configuration.'
};
const state = { pending: undefined, actionError: undefined };
const rows = new Map();
let projects = [];
let selected = new URLSearchParams(window.location.search).get('project') || undefined;
let confirming;
let importing = false;
let cloneRequest;
let portMessage;
let timer;
let revision = 0;

async function request(url, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { diagnostic: data.diagnostic });
  return data;
}

function post(url, token, data, timeout = 5000, signal) {
  const deadline = AbortSignal.timeout(timeout);
  return request(url, { method: 'POST', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(data) });
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
  const custom = Object.values(project.services ?? {}).filter(service => service.name && service.ready);
  const readyCustom = custom.filter(service => service.kind !== 'api' || service.openUrl);
  const links = $('runtime-custom-links');
  const saved = JSON.stringify(readyCustom);
  if (links.dataset.saved !== saved) {
    links.dataset.saved = saved;
    links.replaceChildren(...readyCustom.map(service => {
      const link = document.createElement('a');
      Object.assign(link, { className: 'secondary', href: service.openUrl ?? service.url, target: '_blank', rel: 'noopener noreferrer', title: service.name });
      const label = service.kind === 'web' ? 'Open app' : service.kind === 'api' ? 'Open API' : undefined;
      if (label) setText(link, readyCustom.filter(item => item.kind === service.kind).length > 1 ? `${label} · ${service.name}` : label);
      else link.textContent = service.name;
      return link;
    }));
  }
  links.hidden = !readyCustom.length;
  $('runtime-api-path-hint').hidden = !custom.some(service => service.kind === 'api' && !service.openUrl);
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
        if (selected !== project.id) state.actionError = undefined;
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
    status.hidden = !project.offline && Boolean(project.unmanaged && !project.hasStartup);
    showState(status, project.offline ? 'offline' : project.ready ? 'ready' : project.status);
  }
  $('project-no-match').hidden = matches > 0;
}

function render() {
  if ($('project-trash-dialog').open) {
    $('project-trash-confirm').disabled = Boolean(state.pending) || $('project-trash-name').value !== confirming?.name;
  }
  $('project-manager').hidden = !projects.length;
  $('project-empty').hidden = projects.length > 0;
  renderRows();
  const project = projects.find(item => item.id === selected);
  activity.render(project);
  if (!project) { preflight.render(); developmentPostgres.render(); return; }
  $('project-detail').classList.toggle('project-offline', Boolean(project.offline));
  $('project-offline').hidden = !project.offline;
  for (const id of ['runtime-action', 'selected-project-state', 'project-runtime-log']) $(id).hidden = Boolean(project.unmanaged && !project.hasStartup);
  if (project.offline) $('selected-project-state').hidden = false;
  if ($('selected-project-name').textContent !== project.name) $('selected-project-name').textContent = project.name;
  if ($('selected-project-path').textContent !== project.path) $('selected-project-path').textContent = project.path;
  showState($('selected-project-state'), project.offline ? 'offline' : project.ready ? 'ready' : project.status);
  renderServices(project);
  const running = project.status === 'running' || project.status === 'starting';
  const busy = running || project.status === 'stopping';
  const deleting = project.deleting || (removesFiles(project) && state.pending?.id === project.id && state.pending.action === 'trash');
  const unavailable = deleting || Boolean(state.pending) || Boolean(project.operation);
  const startupDirty = startup.render(project, busy || unavailable);
  renderPorts(project, busy || unavailable);
  dependencies.render(project, busy, unavailable, startupDirty);
  database.render(project, busy, unavailable);
  developmentPostgres.render(project, busy || unavailable);
  tools.render(project, busy, unavailable);
  const action = $('runtime-action');
  action.dataset.action = running ? 'stop' : 'start';
  action.className = running || project.status === 'stopping' ? 'secondary' : 'primary';
  action.disabled = Boolean(state.pending) || deleting || project.status === 'stopping' || (!running && (Boolean(project.operation) || startupDirty));
  setText(action.firstElementChild, project.status === 'stopping' ? 'Stopping…' : running ? 'Stop project' : 'Start project');
  preflight.render(project, unavailable, !busy && !project.offline && !action.hidden && !action.disabled);
  const devError = state.actionError?.id === project.id && ['start', 'stop'].includes(state.actionError.action) ? state.actionError : undefined;
  const error = devError?.message ?? project.error;
  $('runtime-error').hidden = !error;
  showMessage($('runtime-error'), error);
  const issue = devError ? devError.diagnostic : project.diagnostic;
  const diagnostic = issue === 'dependencies' && project.unmanaged && !project.hasInstallCommands
    ? 'Add an install command under Startup configuration if this project needs one.'
    : issue === 'dependencies' && project.dependencies?.status === 'succeeded' ? undefined : diagnosticMessages[issue];
  const diagnosticField = $('runtime-diagnostic');
  showMessage(diagnosticField, diagnostic);
  diagnosticField.hidden = !diagnostic;
  $('runtime-database-config').hidden = issue !== 'databaseUrl';
  $('project-delete').disabled = busy || unavailable;
  $('project-remove').hidden = !project.imported || !removesFiles(project);
  $('project-remove').disabled = busy || unavailable;
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
    if (projects.find(item => item.id === selected)?.offline) return;
    database.refresh();
    dependencies.load();
    tools.load('checks');
    tools.load('git');
  } catch {
    if (version !== revision) return;
    $('project-connection').hidden = false;
    setText($('project-connection'), 'Cannot reach StackForge. Reconnecting…');
  } finally {
    if (version === revision && !document.hidden) timer = setTimeout(refresh, 1200);
  }
}

async function act(id, action, body = {}) {
  if (!id || state.pending) return;
  const removing = action === 'trash' || action === 'remove';
  state.pending = { id, action };
  state.actionError = undefined;
  $('project-feedback').dataset.status = 'ok';
  setText($('project-feedback'), '');
  render();
  try {
    const { token } = await request('/api/state');
    const timeout = action === 'trash' ? 180_000 : action === 'install-terminal' ? 20_000 : 5000;
    const runtime = await post(`/api/projects/${id}/${action}`, token, body, timeout);
    if (removing) {
      projects = projects.filter(item => item.id !== id);
      if (selected === id) selected = projects[0]?.id;
      setText($('project-feedback'), runtime.removed ? 'Project removed from Projects.' : 'Project moved to the system trash.');
    } else if (action === 'install-terminal') {
      setText($('project-feedback'), 'Project terminal opened.');
    } else if (action === 'ports') {
      const project = projects.find(item => item.id === id);
      if (project) project.ports = runtime.ports;
      portMessage = { id, message: 'Development ports saved.' };
    } else if (action === 'startup') {
      const project = projects.find(item => item.id === id);
      if (project) Object.assign(project, { startupServices: runtime.services,
        hasStartup: runtime.services.some(service => service.command),
        hasInstallCommands: runtime.services.some(service => service.installCommand) });
      tools.invalidateChecks(id);
      startup.setMessage({ id, message: 'Startup configuration saved.' });
    } else if (action === 'check-config') {
      tools.saveChecks(id, runtime.commands);
    } else if (['install', 'install-cancel', 'database-start', 'database-stop', 'database-delete', 'run-check', 'check-cancel'].includes(action)) {
      const project = projects.find(item => item.id === id);
      if (project) Object.assign(project, runtime);
    } else {
      const project = projects.find(item => item.id === id);
      if (project) Object.assign(project, { status: runtime.status, error: runtime.error, services: runtime.services, ready: runtime.ready, initialized: runtime.initialized, diagnostic: runtime.diagnostic });
    }
  } catch (error) {
    if (removing) {
      $('project-feedback').dataset.status = 'error';
      setText($('project-feedback'), error.message);
    } else if (action === 'ports') portMessage = { id, message: error.message };
    else if (action === 'startup') startup.setMessage({ id, message: error.message, error: true });
    else if (action === 'check-config') tools.setMessage({ id, message: error.message, error: true });
    else state.actionError = { id, action, message: error.message, diagnostic: error.diagnostic };
  }
  finally {
    state.pending = undefined;
    render();
    if (removing) $('project-feedback').focus();
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

function openProjectSection(id) {
  const panel = $(id);
  if (panel.tagName === 'DETAILS') panel.open = true;
  const heading = panel.querySelector('summary, h3');
  if (heading.tagName === 'H3') heading.tabIndex = -1;
  panel.scrollIntoView({ block: 'start' });
  heading.focus({ preventScroll: true });
}

async function importAction(browse, clone = false) {
  if (importing) return;
  importing = true;
  const path = $(clone ? 'project-clone-parent' : 'project-import-path');
  const controls = ['project-import-toggle', 'project-import-browse', 'project-import-submit', 'project-clone-browse', 'project-clone-submit'].map($);
  for (const control of controls) control.disabled = true;
  path.readOnly = true;
  const repository = $('project-clone-url');
  const cancel = $('project-clone-cancel');
  if (clone) repository.readOnly = true;
  const message = $(clone ? 'project-clone-message' : 'project-import-message');
  setText(message, browse ? 'Choose a folder in the system dialog.' : clone ? 'Cloning repository…' : 'Adding project…');
  try {
    const { token, defaultDir } = await request('/api/state');
    if (browse) {
      const result = await post('/api/desktop/pick-directory', token, { initialDir: path.value.trim() || defaultDir, language: document.documentElement.lang }, 610000);
      if (result.path) path.value = result.path;
      setText(message, result.path ? 'Folder selected.' : 'Folder selection cancelled.');
    } else {
      let project;
      if (clone) {
        const requestId = crypto.randomUUID();
        cloneRequest = { requestId, token };
        cancel.hidden = false;
        project = await post('/api/projects/clone', token, { repository: repository.value.trim(), parentDir: path.value.trim(), requestId }, 190000);
      } else {
        project = await post('/api/projects/import', token, { path: path.value.trim() });
      }
      selected = project.id;
      projects = [{ ...project, status: 'stopped' }, ...projects.filter(item => item.id !== project.id)];
      $('project-search').value = '';
      if (clone) repository.value = '';
      else path.value = '';
      showImport(false);
      setText(message, '');
      $('project-feedback').dataset.status = 'ok';
      const feedback = project.databaseRefreshPending ? 'Project moved. Open Database discovery and refresh its bindings.' :
        project.relocated ? 'Project moved to its verified location.' :
          project.cloneCleanupPending ? 'Clone added. StackForge will retry old database credential cleanup when it restarts.' :
            'Project added to Projects.';
      setText($('project-feedback'), feedback);
      render();
      $('project-feedback').focus();
      refresh();
    }
  } catch (error) { setText(message, error.message); }
  finally {
    importing = false;
    for (const control of controls) control.disabled = false;
    path.readOnly = false;
    if (clone) {
      cloneRequest = undefined;
      cancel.hidden = true;
      cancel.disabled = false;
      repository.readOnly = false;
    }
  }
}

$('project-search').addEventListener('input', renderRows);
$('project-import-toggle').addEventListener('click', () => showImport($('project-import').hidden));
$('project-import-browse').addEventListener('click', () => importAction(true));
$('project-import-form').addEventListener('submit', event => { event.preventDefault(); importAction(false); });
$('project-clone-browse').addEventListener('click', () => importAction(true, true));
$('project-clone-form').addEventListener('submit', event => { event.preventDefault(); importAction(false, true); });
$('project-clone-cancel').addEventListener('click', async event => {
  const cancel = event.currentTarget;
  const current = cloneRequest;
  if (!current || cancel.disabled) return;
  const message = $('project-clone-message');
  cancel.disabled = true;
  setText(message, 'Cancelling clone…');
  try {
    await post('/api/projects/clone-cancel', current.token, { requestId: current.requestId });
  } catch (error) {
    if (cloneRequest === current) {
      setText(message, error.message);
      cancel.disabled = false;
    }
  }
});
$('project-port-form').addEventListener('submit', event => {
  event.preventDefault();
  const ports = {};
  for (const field of event.currentTarget.querySelectorAll('input')) if (!field.parentElement.hidden && field.value) ports[field.name] = field.valueAsNumber;
  portMessage = undefined;
  act(selected, 'ports', { ports });
});
$('runtime-action').addEventListener('click', event => act(selected, event.currentTarget.dataset.action));
$('language').addEventListener('change', render);
function confirmProjectRemoval(action) {
  const project = projects.find(item => item.id === selected);
  if (!project || state.pending) return;
  confirming = { ...project, action };
  database.clearTransferMessage();
  $('project-trash-path').textContent = project.path;
  $('project-trash-expected').textContent = project.name;
  $('project-trash-name').value = '';
  $('project-trash-confirm').disabled = true;
  const deleteFiles = action === 'trash' && removesFiles(project);
  setText($('project-trash-title'), deleteFiles ? 'Delete project?' : 'Remove project from Projects?');
  setText($('project-trash-instruction'), deleteFiles ? 'Type the project name below to confirm deletion.' : 'Type the project name below to confirm removal.');
  setText($('project-trash-confirm'), deleteFiles ? 'Delete project' : 'Remove from Projects');
  setText($('project-trash-description'), !deleteFiles ? 'This removes the entry from the Projects list. Your files stay in this folder.' : project.database !== 'none'
    ? 'The project folder will move to the system trash. Its database and data volume will be kept.'
    : 'The entire local project folder will move to the system trash. You can restore it from there.');
  $('project-trash-dialog').showModal();
  render();
}
$('project-delete').addEventListener('click', () => confirmProjectRemoval(projects.find(item => item.id === selected)?.offline ? 'remove' : 'trash'));
$('project-remove').addEventListener('click', () => confirmProjectRemoval('remove'));
$('project-trash-cancel').addEventListener('click', () => $('project-trash-dialog').close());
$('project-trash-name').addEventListener('input', event => {
  $('project-trash-confirm').disabled = Boolean(state.pending) || event.target.value !== confirming?.name;
});
$('project-trash-form').addEventListener('submit', event => {
  event.preventDefault();
  const confirmName = $('project-trash-name').value;
  if (!confirming || state.pending || confirmName !== confirming.name) return;
  $('project-trash-dialog').close();
  act(confirming.id, confirming.action, { confirmName });
});
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });
const selectedId = () => selected;
const selectedProject = () => projects.find(project => project.id === selected);
const startup = createStartupPanel({ $, request, showMessage, state, selectedId, selectedProject, renderPage: render, act });
const dependencies = createDependenciesPanel({ $, request, showMessage, renderOutput, diagnosticMessages, state, selectedId, selectedProject, renderPage: render, act });
const tools = createProjectToolsPanel({ $, request, showMessage, renderOutput, state, selectedId, renderPage: render, act });
const activity = createActivityPanel({ $, request, showMessage });
const developmentPostgres = createDevelopmentPostgres({ $, request, post, state, renderPage: render,
  reloadDiscovery: () => database.reloadDiscovery(), openExisting: action => database.openExisting(action),
  archive: (mode, id) => database.developmentArchive(mode, id) });
const database = createDatabasePanel({ $, request, post, showMessage, renderOutput, stackNames, diagnosticMessages, state,
  selectedId, selectedProject, renderPage: render, refresh, act, openDevelopment: developmentPostgres.open, refreshDevelopment: developmentPostgres.refresh });
const preflight = createPreflightPanel({ $, request, selectedProject, start: async id => {
  await act(id, 'start');
  if (selected === id && !$('runtime-action').disabled) $('runtime-action').focus({ preventScroll: true });
}, followAction(item) {
  if (item.action === 'import') return showImport(true);
  if (item.action === 'postgres') return database.openDetectedSetup(item.requirementId);
  const panel = { startup: 'project-startup', dependencies: 'project-dependencies',
    database: 'project-database-discovery', ports: 'project-ports' }[item.action];
  if (panel) openProjectSection(panel);
} });
refresh();
