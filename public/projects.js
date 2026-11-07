import { setText, setupI18n } from './i18n.js';

setupI18n();

const $ = id => document.getElementById(id);
const stateLabels = { stopped: '已停止', starting: '正在启动…', running: '运行中', stopping: '正在停止…', failed: '启动失败或异常退出' };
const stackNames = { vue: 'Vue', react: 'React', express: 'Express', spring: 'Spring Boot', mysql: 'MySQL', postgres: 'PostgreSQL' };
const rows = new Map();
let projects = [];
let selected;
let pending;
let actionError;
let timer;
let revision = 0;

async function request(url, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function showState(element, status) {
  if (element.dataset.state === status) return;
  element.dataset.state = status;
  setText(element, stateLabels[status]);
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
    showState(row.querySelector('.runtime-state'), project.status);
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
  showState($('selected-project-state'), project.status);
  const running = project.status === 'running' || project.status === 'starting';
  const action = $('runtime-action');
  action.dataset.action = running ? 'stop' : 'start';
  action.className = running || project.status === 'stopping' ? 'secondary' : 'primary';
  action.disabled = Boolean(pending) || project.status === 'stopping';
  setText(action.firstElementChild, project.status === 'stopping' ? 'Stopping…' : running ? 'Stop project' : 'Start project');
  const error = actionError?.id === project.id ? actionError.message : project.error;
  $('runtime-error').hidden = !error;
  setText($('runtime-error'), error || '');
  $('runtime-database').hidden = project.database === 'none';
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

$('project-search').addEventListener('input', renderRows);
$('runtime-action').addEventListener('click', async event => {
  if (!selected || pending) return;
  const id = selected;
  const action = event.currentTarget.dataset.action;
  pending = id;
  actionError = undefined;
  render();
  try {
    const { token } = await request('/api/state');
    const runtime = await request(`/api/projects/${id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: '{}'
    });
    const project = projects.find(item => item.id === id);
    if (project) Object.assign(project, { status: runtime.status, error: runtime.error });
  } catch (error) { actionError = { id, message: error.message }; }
  finally { pending = undefined; render(); refresh(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });
refresh();
