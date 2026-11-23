import { setText } from '/i18n.js';

export function migrationSourcePreview(projectId, source, { request, post }, { adapter, title, reading, rescan, scope, messages, render }) {
  const prefix = source.directory === '.' ? '' : source.directory + '/';
  const relativePath = path => path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const details = document.createElement('details');
  details.className = 'migration-preview ' + adapter + '-preview';
  const summary = document.createElement('summary');
  const label = document.createElement('span');
  setText(label, title);
  summary.append(label, ' · ', [source.source, [scope, source.profile].filter(Boolean).join(' / ')].filter(Boolean).join(' · '));
  const status = document.createElement('p');
  status.className = 'hint';
  status.setAttribute('role', 'status');
  const results = document.createElement('div');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'secondary';
  refresh.hidden = true;
  setText(refresh, rescan);
  details.append(summary, status, results, refresh);

  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    refresh.hidden = true;
    results.replaceChildren();
    setText(status, reading);
    try {
      const { token } = await request('/api/state');
      const result = await post('/api/projects/' + projectId + '/database-' + adapter + '-preview', token, { sourceId: source.id }, 25000);
      setText(status, messages[result.status]);
      results.append(...render(result, relativePath));
    } catch (error) {
      setText(status, error.message);
    } finally {
      loading = false;
      refresh.hidden = false;
    }
  }
  details.addEventListener('toggle', () => { if (details.open) void load(); });
  refresh.addEventListener('click', () => void load());
  return details;
}

export function markUnverified(row) {
  const flag = document.createElement('span');
  setText(flag, 'Unverified');
  row.append(' · ', flag);
}
