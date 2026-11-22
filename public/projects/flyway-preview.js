import { setText } from '/i18n.js';

const messages = {
  ready: 'Local Flyway SQL migrations found. Database history is unverified.',
  partial: 'Some Flyway files need review. Check duplicate migrations, file names and migration folders.',
  empty: 'No Flyway SQL migrations were found in these folders.',
  disabled: 'Flyway is disabled in this configuration.',
  'unsupported-config': 'This Flyway configuration could not be resolved from local files. Check its migration locations and naming settings.'
};

const types = {
  versioned: 'Versioned migration',
  repeatable: 'Repeatable migration',
  baseline: 'Baseline migration',
  undo: 'Undo migration'
};

const scopes = { standalone: 'Flyway CLI', spring: 'Spring Boot', maven: 'Maven', gradle: 'Gradle', runtime: 'JVM' };

export function flywayPreview(projectId, source, { request, post }) {
  const prefix = source.directory === '.' ? '' : source.directory + '/';
  const relativePath = path => path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const details = document.createElement('details');
  details.className = 'migration-preview flyway-preview';
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  setText(title, 'Preview Flyway migrations');
  summary.append(title, ' · ', source.source, ' · ', [scopes[source.scope], source.profile].filter(Boolean).join(' / '));
  const status = document.createElement('p');
  status.className = 'hint';
  status.setAttribute('role', 'status');
  const folders = document.createElement('p');
  folders.className = 'hint';
  folders.hidden = true;
  const list = document.createElement('ul');
  list.className = 'check-list';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'secondary';
  refresh.hidden = true;
  setText(refresh, 'Rescan Flyway files');
  details.append(summary, status, folders, list, refresh);

  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    refresh.hidden = folders.hidden = true;
    list.replaceChildren();
    setText(status, 'Reading Flyway migration files…');
    try {
      const { token } = await request('/api/state');
      const result = await post('/api/projects/' + projectId + '/database-flyway-preview', token, { sourceId: source.id }, 25000);
      setText(status, messages[result.status]);
      folders.textContent = result.locations.map(relativePath).join(' · ');
      folders.hidden = result.locations.length === 0;
      for (const item of result.migrations) {
        const row = document.createElement('li');
        const kind = document.createElement('span');
        setText(kind, types[item.kind]);
        const file = document.createElement('code');
        file.textContent = relativePath(item.file);
        row.append(kind, ' · ', file);
        if (!item.verified) {
          const flag = document.createElement('span');
          setText(flag, 'Unverified');
          row.append(' · ', flag);
        }
        list.append(row);
      }
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
