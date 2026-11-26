import { setText, setupI18n } from '/i18n.js';
import { activityLabels, activityOutcomes } from '/projects/activity.js';

setupI18n();
const $ = id => document.getElementById(id);
const projectLabels = { ready: '已就绪', running: '运行中', starting: 'Starting…', stopping: 'Stopping…',
  offline: 'Project folder missing', failed: 'Startup failed', deleting: 'Moving to trash…', stopped: 'Stopped' };
const databaseLabels = { attention: 'Review configuration', connected: 'Connection previously verified',
  development: 'Development database recorded', configured: 'Connection configured', declared: 'Detected' };
const databaseSections = { controls: 'project-database', development: 'project-development-postgres', discovery: 'project-database-discovery' };
const serviceLabels = { web: 'Web app', api: 'API service', service: 'Service' };
let snapshot, loading, timer;

function message(id, text) {
  const element = $(id);
  if (element.dataset.message === text) return;
  element.dataset.message = text;
  setText(element, text);
}

function projectLink(id, section) {
  return '/projects?project=' + encodeURIComponent(id) + (section ? '#' + section : '');
}

function link(url, name, translated = false) {
  const element = document.createElement('a');
  element.href = url;
  if (translated) setText(element, name);
  else element.textContent = name;
  return element;
}

function row(title, status, label, detail) {
  const element = document.createElement('li');
  element.className = 'dashboard-item';
  const main = document.createElement('div');
  main.className = 'dashboard-item-main';
  main.append(title);
  if (detail) {
    detail.classList.add('dashboard-item-detail');
    main.append(detail);
  }
  const state = document.createElement('div');
  state.className = 'dashboard-item-state';
  state.dataset.status = status;
  if (typeof label === 'string' || !label) setText(state, label ?? 'Unverified');
  else state.append(label);
  element.append(main, state);
  return element;
}

function projectRow(project) {
  return row(link(projectLink(project.id), project.name), project.status, projectLabels[project.status]);
}

function serviceRow(service) {
  const project = link(projectLink(service.projectId), service.name || serviceLabels[service.kind] || 'Service', !service.name);
  const detail = document.createElement('span');
  detail.textContent = service.projectName;
  if (!service.url) return row(project, 'ready', 'Access link unavailable', detail);
  const open = link(service.url, ({ api: 'Open API', web: 'Open app' })[service.kind] ?? 'Open service', true);
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  return row(project, 'ready', open, detail);
}

function databaseRow(database) {
  const name = link(projectLink(database.projectId, databaseSections[database.target]), database.engine);
  const detail = document.createElement('span');
  detail.textContent = database.projectName;
  return row(name, database.status, databaseLabels[database.status], detail);
}

function taskRow(task) {
  const url = task.jobId ? '/?job=' + encodeURIComponent(task.jobId) + '#activity' : projectLink(task.projectId);
  const title = link(url, activityLabels[task.action] ?? 'Task', true);
  const detail = document.createElement('span');
  const time = document.createElement('time');
  time.dateTime = task.finishedAt ?? task.startedAt;
  detail.append(task.name, ' · ', time);
  return row(title, task.status, activityOutcomes[task.status], detail);
}

function renderRows(section, rows, createRow, empty, notice) {
  const list = $('overview-' + section);
  const key = JSON.stringify(rows);
  if (list.dataset.key !== key) {
    const focused = list.contains(document.activeElement) ? document.activeElement.getAttribute('href') : undefined;
    list.replaceChildren(...rows.map(createRow));
    if (focused) [...list.querySelectorAll('a')].find(element => element.getAttribute('href') === focused)?.focus({ preventScroll: true });
    list.dataset.key = key;
  }
  list.hidden = rows.length === 0;
  message('dashboard-' + section + '-message', notice || (rows.length ? '' : empty));
}

function render() {
  if (!snapshot) return;
  const { projects, services, databases, tasks } = snapshot;
  const locale = document.documentElement.lang;
  const format = new Intl.NumberFormat(locale);
  for (const [name, count] of Object.entries({ running: projects.running, ready: services.total, 'database-attention': databases.attention, active: tasks.active })) {
    const value = count === undefined ? '—' : format.format(count);
    if ($('dashboard-' + name).textContent !== value) $('dashboard-' + name).textContent = value;
  }
  $('dashboard-database-attention').toggleAttribute('data-attention', databases.attention > 0);
  renderRows('projects', projects.rows, projectRow, 'Create or import a project to get started.');
  renderRows('services', services.rows, serviceRow, 'No services are ready. Start a project to see its ready services.');
  renderRows('databases', databases.rows, databaseRow, 'No database configuration has been recorded.',
    databases.unavailable && 'Saved database information is temporarily unavailable.');
  renderRows('tasks', tasks.rows, taskRow, 'No recent tasks.', tasks.unavailable ? 'Task information is temporarily unavailable.' :
    tasks.partial ? 'Some task history may be unavailable.' : '');
  const formatTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  for (const time of $('overview-tasks').querySelectorAll('time')) {
    const value = formatTime.format(new Date(time.dateTime));
    if (time.textContent !== value) time.textContent = value;
  }
}

async function refresh() {
  clearTimeout(timer);
  if (loading || document.hidden) return;
  loading = true;
  try {
    const response = await fetch('/api/dashboard', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    snapshot = await response.json();
    render();
    message('dashboard-feedback', '');
  } catch {
    message('dashboard-feedback', snapshot ? 'Could not refresh the overview. Showing the last available results.' : 'Could not load the workspace overview.');
  } finally {
    loading = false;
    if (!document.hidden) timer = setTimeout(refresh, 5000);
  }
}

$('dashboard-refresh').addEventListener('click', refresh);
$('language').addEventListener('change', render);
document.addEventListener('visibilitychange', refresh);
void refresh();
