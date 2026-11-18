import { setText } from '/i18n.js';

const messages = {
  ready: 'Local EF Core migrations found. Database status is unverified.',
  partial: 'Some EF Core migrations could not be verified from local files. Review the project configuration.',
  empty: 'No supported EF Core migration declarations were found.'
};

export function efCorePreview(projectId, source, { request, post }) {
  const folder = source.source.slice(0, source.source.lastIndexOf('/') + 1);
  const details = document.createElement('details');
  details.className = 'migration-preview ef-core-preview';
  const summary = document.createElement('summary');
  const label = document.createElement('span');
  setText(label, 'Preview EF Core migrations');
  summary.append(label, ' · ', source.source);
  const status = document.createElement('p');
  status.className = 'hint';
  status.setAttribute('role', 'status');
  const results = document.createElement('div');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'secondary';
  refresh.hidden = true;
  setText(refresh, 'Rescan EF Core migration files');
  details.append(summary, status, results, refresh);

  function groupView(group) {
    const section = document.createElement('section');
    const header = document.createElement('p');
    const context = document.createElement('strong');
    if (group.context) context.textContent = group.context;
    else setText(context, 'Unverified DbContext');
    header.append(context);
    if (group.namespace) header.append(' · ', group.namespace);
    const list = document.createElement('ul');
    list.className = 'check-list';
    for (const item of group.migrations) {
      const row = document.createElement('li');
      const name = document.createElement('code');
      name.textContent = item.id;
      const path = item.file.startsWith(folder) ? item.file.slice(folder.length) : item.file;
      row.append(name, ' · ', path);
      if (!item.verified) {
        const flag = document.createElement('span');
        setText(flag, 'Unverified');
        row.append(' · ', flag);
      }
      list.append(row);
    }
    section.append(header, list);
    return section;
  }

  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    refresh.hidden = true;
    results.replaceChildren();
    setText(status, 'Reading EF Core migration files…');
    try {
      const { token } = await request('/api/state');
      const result = await post(`/api/projects/${projectId}/database-ef-core-preview`, token, { sourceId: source.id }, 25000);
      setText(status, messages[result.status]);
      results.replaceChildren(...result.groups.map(groupView));
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
