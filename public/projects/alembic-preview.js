import { setText } from '/i18n.js';
import { labelledMigrationControl, migrationHistoryName, postgresHistoryMessages } from '/projects/migration-history.js';

const messages = {
  ready: 'Local Alembic revisions found. Database status is unverified.',
  empty: 'No Alembic revision files were found in this directory.',
  'unsupported-config': 'This layout needs a manual Alembic check. Preview supports a standard alembic.ini with one versions directory.',
  'files-unavailable': 'The Alembic revision directory or its files could not be read. Check the displayed path and scan again.',
  unverified: 'Some revisions could not be linked. Check for missing files, duplicate revisions, or dynamic declarations.'
};

const databaseMessages = {
  ...postgresHistoryMessages,
  current: 'The recorded revision history covers every local revision.',
  pending: 'Some local revisions are pending on the selected database.',
  'history-missing': 'This database has existing objects but no recorded Alembic revisions. Check the target and version table.',
  'history-conflict': 'The recorded Alembic revisions do not match the local graph. Check the target and revision files.',
  'history-unavailable': 'The selected table does not have a supported migration history layout.'
};

const address = ({ host, port, name }) => `${host.includes(':') ? '[' + host + ']' : host}:${port}/${name}`;

export function alembicPreview(projectId, source, targets, { request, post }) {
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
  const guide = document.createElement('p');
  const form = document.createElement('form');
  const controls = document.createElement('fieldset');
  const label = document.createElement('label');
  const labelText = document.createElement('span');
  const select = document.createElement('select');
  const check = document.createElement('button');
  const location = document.createElement('details');
  const locationSummary = document.createElement('summary');
  const schema = migrationHistoryName('public');
  const table = migrationHistoryName('alembic_version');
  const databaseStatus = document.createElement('p');
  const databaseTarget = document.createElement('p');
  const databaseHeads = document.createElement('p');
  const databaseHeadsLabel = document.createElement('span');
  const databaseHeadIds = document.createElement('code');

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
  setText(refresh, 'Rescan Alembic files');
  guide.className = databaseStatus.className = databaseTarget.className = databaseHeads.className = 'hint';
  guide.hidden = form.hidden = true;
  setText(guide, 'Set up Project PostgreSQL or save a direct local PostgreSQL URL, then rescan database configuration.');
  controls.className = 'migration-history-controls';
  check.className = 'secondary';
  check.type = 'submit';
  check.disabled = true;
  select.required = true;
  const empty = new Option('', '');
  setText(empty, 'Choose a PostgreSQL database');
  select.append(empty);
  for (const target of targets) {
    const option = new Option(address(target), target.id);
    if (target.projectPostgres) setText(option, ['Project PostgreSQL', address(target)]);
    else option.textContent = [address(target), target.source, target.variable].filter(Boolean).join(' · ');
    select.append(option);
  }
  setText(labelText, 'Database for public.alembic_version');
  setText(check, 'Check database history');
  label.append(labelText, select);
  location.className = 'migration-history-location';
  setText(locationSummary, 'History table');
  location.append(locationSummary, labelledMigrationControl('History schema', schema), labelledMigrationControl('History table name', table));
  controls.append(label, location, check);
  form.append(controls);
  databaseStatus.setAttribute('role', 'status');
  setText(databaseHeadsLabel, 'Recorded revisions');
  databaseHeads.append(databaseHeadsLabel, ' · ', databaseHeadIds);
  details.append(summary, status, directory, heads, guide, form, databaseTarget, databaseStatus, databaseHeads, revisions, refresh);

  let loading = false;
  function showDatabase(result) {
    databaseTarget.hidden = !result?.target;
    databaseTarget.textContent = result?.target ? address(result.target) + ' · ' +
      [result.history?.schema ?? 'public', result.history?.table ?? 'alembic_version'].join('.') : '';
    setText(databaseStatus, databaseMessages[result?.status] ?? '');
    databaseHeads.hidden = !result?.heads?.length;
    databaseHeadIds.textContent = result?.heads?.join(', ') ?? '';
  }

  async function load(targetId) {
    if (loading) return;
    loading = true;
    select.disabled = check.disabled = true;
    schema.disabled = table.disabled = true;
    directory.hidden = heads.hidden = refresh.hidden = true;
    revisions.replaceChildren();
    showDatabase();
    setText(status, targetId ? 'Checking PostgreSQL migration history…' : 'Reading Alembic revision files…');
    try {
      const { token } = await request('/api/state');
      const selection = targetId ? { targetId, schema: schema.value, table: table.value } : {};
      const result = await post(`/api/projects/${projectId}/database-alembic-preview`, token, { sourceId: source.id, ...selection }, 40000);
      form.hidden = result.status !== 'ready' || !targets.length;
      guide.hidden = result.status !== 'ready' || Boolean(targets.length);
      setText(status, result.database ? 'Local Alembic revisions found.' : messages[result.status]);
      showDatabase(result.database);
      if (result.directory) {
        directory.textContent = result.directory;
        directory.hidden = false;
      }
      if (result.heads?.length) {
        headIds.textContent = result.heads.join(', ');
        heads.hidden = false;
      }
      const recordedStates = new Map(result.database?.revisions?.map(item => [item.revision, item.state]));
      revisions.replaceChildren(...result.revisions.map(({ revision, file }) => {
        const row = document.createElement('li');
        row.dataset.revision = revision ?? '';
        const label = document.createElement(revision ? 'code' : 'span');
        if (revision) label.textContent = revision;
        else setText(label, 'Unverified');
        row.append(label, ' · ', file.split('/').at(-1));
        const state = recordedStates.get(revision);
        if (state) {
          const badge = document.createElement('span');
          badge.className = 'alembic-revision-state';
          const stateLabel = document.createElement('span');
          setText(stateLabel, state === 'applied' ? 'Applied' : 'Pending');
          badge.append(' · ', stateLabel);
          row.append(badge);
        }
        return row;
      }));
    } catch (error) {
      setText(status, error.message);
    } finally {
      refresh.hidden = false;
      loading = false;
      select.disabled = false;
      schema.disabled = table.disabled = false;
      check.disabled = !select.value;
    }
  }
  form.addEventListener('input', () => {
    check.disabled = !select.value;
    showDatabase();
    setText(status, messages.ready);
    for (const badge of revisions.querySelectorAll('.alembic-revision-state')) badge.remove();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (select.value) void load(select.value);
  });
  details.addEventListener('toggle', () => { if (details.open) void load(); });
  refresh.addEventListener('click', () => void load());
  return details;
}
