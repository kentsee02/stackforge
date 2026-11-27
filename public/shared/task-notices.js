export const taskNoticeKey = 'stackforge.taskNotices';
export const normalizeTaskNotice = mode => ['attention', 'all'].includes(mode) ? mode : 'off';
const cursorKey = 'stackforge.taskNoticeCursor';
const pollInterval = 5000;

export function readTaskNoticeMode() {
  try { return normalizeTaskNotice(localStorage.getItem(taskNoticeKey)); } catch { return 'off'; }
}

export function startTaskNotices(setText) {
  let mode, cursor, timer, polling, notice;
  function saveCursor() {
    try {
      if (cursor) sessionStorage.setItem(cursorKey, JSON.stringify({ mode, since: cursor.since, seen: [...cursor.seen] }));
      else sessionStorage.removeItem(cursorKey);
    } catch {}
  }
  function loadCursor() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(cursorKey));
      if (saved?.mode === mode && Number.isFinite(saved.since) && Array.isArray(saved.seen)) {
        return { since: saved.since, seen: new Set(saved.seen.slice(-120)) };
      }
    } catch {}
    return { since: Date.now(), seen: new Set() };
  }
  function closeNotice() {
    if (notice) notice.hidden = true;
  }
  function showNotice(completed, attention) {
    if (!notice) {
      notice = document.createElement('aside');
      notice.className = 'workspace-notice';
      const message = document.createElement('p');
      message.setAttribute('role', 'status');
      const actions = document.createElement('div');
      const tasks = document.createElement('a');
      tasks.href = '/tasks';
      setText(tasks, 'View tasks');
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'text-button';
      setText(dismiss, 'Dismiss notification');
      dismiss.addEventListener('click', closeNotice);
      actions.append(tasks, dismiss);
      notice.append(message, actions);
      document.body.append(notice);
    }
    notice.hidden = false;
    setText(notice.firstElementChild, [attention && `Tasks needing attention: ${attention}`, completed && `Successful tasks: ${completed}`]);
  }
  async function poll() {
    clearTimeout(timer);
    if (!cursor || polling || document.hidden) return;
    const current = cursor;
    polling = true;
    try {
      const response = await fetch('/api/tasks', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const { history } = await response.json();
      if (current !== cursor || document.hidden || !Array.isArray(history)) return;
      let completed = 0, attention = 0;
      for (const task of history) {
        if (typeof task.id !== 'string' || !(Date.parse(task.finishedAt) >= current.since)) continue;
        const key = task.id + '|' + task.finishedAt;
        if (current.seen.has(key)) continue;
        current.seen.add(key);
        if (task.status === 'failed' || task.status === 'partially-completed') attention++;
        if (mode === 'all' && task.status === 'succeeded') completed++;
      }
      while (current.seen.size > 120) current.seen.delete(current.seen.values().next().value);
      saveCursor();
      if (completed || attention) showNotice(completed, attention);
    } catch { /* the next foreground poll can recover */ }
    finally {
      polling = false;
      if (cursor && !document.hidden) timer = setTimeout(poll, pollInterval);
    }
  }
  function updateMode() {
    const next = readTaskNoticeMode();
    if (next === mode) return;
    mode = next;
    closeNotice();
    cursor = mode === 'off' ? undefined : loadCursor();
    saveCursor();
    void poll();
  }
  window.addEventListener('stackforge:task-notices', updateMode);
  window.addEventListener('storage', event => {
    if (event.key === taskNoticeKey || event.key === null) updateMode();
  });
  document.addEventListener('visibilitychange', poll);
  updateMode();
}
