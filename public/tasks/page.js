import { setText, setupI18n, translate } from '/i18n.js';
import { activityLabels as labels, activityOutcomes as outcomes } from '/projects/activity.js';

setupI18n();
const $ = id => document.getElementById(id);
const pending = new Set();
let snapshot, timer, loading, feedback;

function showMessage(id, message) {
  const element = $(id);
  if (element.dataset.message === message) return;
  element.dataset.message = message;
  setText(element, message);
}

async function request(url, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function taskRow(task) {
  const row = document.createElement('li');
  row.className = 'task-row';
  const main = document.createElement('div');
  main.className = 'task-main';
  const action = document.createElement('strong');
  action.id = 'task-action-' + task.id;
  setText(action, labels[task.action]);
  const link = document.createElement('a');
  link.id = 'task-link-' + task.id;
  link.href = task.jobId ? '/?job=' + encodeURIComponent(task.jobId) + '#activity' : '/projects?project=' + encodeURIComponent(task.projectId);
  link.textContent = task.name;
  const time = document.createElement('time');
  time.className = 'task-time';
  time.dateTime = task.finishedAt ?? task.startedAt;
  const outcome = document.createElement('span');
  outcome.className = 'task-status';
  outcome.dataset.status = task.status;
  setText(outcome, outcomes[task.status]);
  main.append(action, link, time);
  row.append(main, outcome);
  if (task.canCancel) {
    const button = document.createElement('button');
    button.className = 'secondary task-cancel';
    button.id = 'task-cancel-' + task.id;
    button.type = 'button';
    button.disabled = pending.has(task.id);
    button.setAttribute('aria-describedby', action.id + ' ' + link.id);
    setText(button, 'Cancel task');
    button.addEventListener('click', () => void cancel(task));
    row.append(button);
  }
  return row;
}

function renderTimes() {
  const format = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'medium' });
  for (const time of document.querySelectorAll('.task-time')) {
    const value = format.format(new Date(time.dateTime));
    if (time.textContent !== value) time.textContent = value;
  }
}

function renderList(id, rows) {
  const list = $(id);
  const key = JSON.stringify(rows);
  if (list.dataset.key !== key) {
    const focused = list.contains(document.activeElement) ? document.activeElement.id : undefined;
    list.replaceChildren(...rows.map(taskRow));
    if (focused) {
      const target = $(focused);
      const heading = $(id === 'active-tasks' ? 'active-task-title' : 'task-history-title');
      (target && !target.disabled ? target : heading).focus();
    }
    list.dataset.key = key;
  }
  list.hidden = rows.length === 0;
}

function render() {
  showMessage('task-feedback', feedback);
  if (!snapshot) return;
  const { active, history, limited, historyUnavailable } = snapshot;
  const query = $('task-search').value.trim().toLocaleLowerCase();
  const status = $('task-status').value;
  const visible = history.filter(task => (status === 'all' || task.status === status) &&
    (!query || [task.name, labels[task.action], translate(labels[task.action])].some(value => value?.toLocaleLowerCase().includes(query))));
  renderList('active-tasks', active);
  renderList('recent-tasks', visible);
  $('active-task-empty').hidden = active.length > 0;
  $('history-task-empty').hidden = visible.length > 0;
  showMessage('history-task-empty', history.length ? 'No recent tasks match these filters.' : 'Finished tasks will appear here.');
  showMessage('history-task-notice', historyUnavailable ? 'Some task history is temporarily unavailable.' :
    limited ? 'Older records may be outside the recent activity window.' : '');
  renderTimes();
}

async function load() {
  clearTimeout(timer);
  if (loading || document.hidden) return;
  loading = true;
  try {
    snapshot = await request('/api/tasks');
    for (const id of pending) if (!snapshot.active.some(task => task.id === id && task.canCancel)) pending.delete(id);
    if (feedback === 'Loading tasks…' || feedback === 'Could not load tasks. Reconnecting…') feedback = '';
  } catch { feedback = 'Could not load tasks. Reconnecting…'; }
  finally {
    loading = false;
    render();
    if (!document.hidden) timer = setTimeout(load, 3000);
  }
}

async function cancel({ id, action }) {
  if (pending.has(id)) return;
  pending.add(id);
  const button = $('task-cancel-' + id);
  if (button) button.disabled = true;
  try {
    const { token } = await request('/api/state');
    await request('/api/tasks/cancel', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-StackForge-Token': token
    }, body: JSON.stringify({ id }) });
    feedback = ['database-migrate', 'database-rollback'].includes(action) ?
      'Cancellation requested. Check database history before starting again.' : 'Cancellation requested.';
  } catch (error) {
    pending.delete(id);
    const current = $('task-cancel-' + id);
    if (current) current.disabled = false;
    feedback = error.message;
  } finally {
    render();
    void load();
  }
}

feedback = 'Loading tasks…';
render();
$('task-refresh').addEventListener('click', load);
$('task-search').addEventListener('input', render);
$('task-status').addEventListener('change', render);
$('language').addEventListener('change', render);
document.addEventListener('visibilitychange', load);
void load();
