import { setText } from '/i18n.js';

const messages = {
  ready: 'Local Alembic revisions found. Database status is unverified.',
  empty: 'No Alembic revision files were found in this directory.',
  'unsupported-config': 'This layout needs a manual Alembic check. Preview supports a standard alembic.ini with one versions directory.',
  'files-unavailable': 'The Alembic revision directory or its files could not be read. Check the displayed path and scan again.',
  unverified: 'Some revisions could not be linked. Check for missing files, duplicate revisions, or dynamic declarations.'
};

export function alembicPreview(projectId, source, { request, post }) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  const status = document.createElement('p');
  const directory = document.createElement('p');
  const heads = document.createElement('p');
  const headsLabel = document.createElement('span');
  const headIds = document.createElement('code');
  const revisions = document.createElement('ul');
  const refresh = document.createElement('button');

  details.className = 'migration-preview alembic-preview';
  setText(title, 'Preview Alembic migrations');
  summary.append(title, ' · ', source.source);
  status.className = directory.className = heads.className = 'hint';
  status.setAttribute('role', 'status');
  directory.hidden = heads.hidden = refresh.hidden = true;
  setText(headsLabel, 'Declared heads');
  heads.append(headsLabel, ' · ', headIds);
  revisions.className = 'check-list';
  refresh.type = 'button';
  refresh.className = 'secondary';
  setText(refresh, 'Check again');
  details.append(summary, status, directory, heads, revisions, refresh);

  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    directory.hidden = heads.hidden = refresh.hidden = true;
    revisions.replaceChildren();
    setText(status, 'Reading Alembic revision files…');
    try {
      const { token } = await request('/api/state');
      const result = await post(`/api/projects/${projectId}/database-alembic-preview`, token, { sourceId: source.id }, 25000);
      setText(status, messages[result.status]);
      if (result.directory) {
        directory.textContent = result.directory;
        directory.hidden = false;
      }
      if (result.heads?.length) {
        headIds.textContent = result.heads.join(', ');
        heads.hidden = false;
      }
      revisions.replaceChildren(...result.revisions.map(({ revision, file }) => {
        const row = document.createElement('li');
        const label = document.createElement(revision ? 'code' : 'span');
        if (revision) label.textContent = revision;
        else setText(label, 'Unverified');
        row.append(label, ' · ', file.split('/').at(-1));
        return row;
      }));
    } catch (error) {
      setText(status, error.message);
    } finally {
      refresh.hidden = false;
      loading = false;
    }
  }
  details.addEventListener('toggle', () => { if (details.open) void load(); });
  refresh.addEventListener('click', () => void load());
  return details;
}
