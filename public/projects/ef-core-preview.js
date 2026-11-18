import { setText } from '/i18n.js';
import { postgresHistoryMessages } from '/projects/alembic-preview.js';

const messages = {
  ready: 'Local EF Core migrations found. Database status is unverified.',
  partial: 'Some EF Core migrations could not be verified from local files. Review the project configuration.',
  empty: 'No supported EF Core migration declarations were found.'
};

const databaseMessages = {
  ...postgresHistoryMessages,
  current: 'The selected history table records every local migration for this DbContext.',
  pending: 'Some local EF Core migrations are pending on the selected database.',
  'history-missing': 'The selected history table was not found. Check the schema and table name.',
  'history-unavailable': 'The selected table does not have a supported EF Core history layout.',
  'history-conflict': 'The recorded migration IDs differ from this DbContext. Check the selected database, table and migration files.'
};

const address = ({ host, port, name }) => (host.includes(':') ? '[' + host + ']' : host) + ':' + port + '/' + name;

function labelledControl(text, control) {
  const label = document.createElement('label');
  const caption = document.createElement('span');
  setText(caption, text);
  label.append(caption, control);
  return label;
}

export function efCorePreview(projectId, source, targets, { request, post }) {
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
  const form = document.createElement('form');
  form.hidden = true;
  const controls = document.createElement('fieldset');
  controls.className = 'migration-history-controls';
  const context = document.createElement('select');
  const target = document.createElement('select');
  context.name = 'groupId';
  target.name = 'targetId';
  context.required = target.required = true;
  const targetPlaceholder = new Option('', '');
  setText(targetPlaceholder, 'Choose a PostgreSQL database');
  target.append(targetPlaceholder);
  for (const item of targets) {
    const option = new Option('', item.id);
    if (item.projectPostgres) setText(option, ['Project PostgreSQL', address(item)]);
    else option.textContent = [address(item), item.source, item.variable].filter(Boolean).join(' · ');
    target.append(option);
  }
  const location = document.createElement('details');
  location.className = 'migration-history-location';
  const locationSummary = document.createElement('summary');
  setText(locationSummary, 'History table');
  const schema = document.createElement('input');
  const table = document.createElement('input');
  for (const input of [schema, table]) {
    input.maxLength = 63;
    input.pattern = '[A-Za-z_][A-Za-z0-9_]{0,62}';
    input.required = true;
    input.spellcheck = false;
  }
  schema.value = 'public';
  table.value = '__EFMigrationsHistory';
  location.append(locationSummary, labelledControl('History schema', schema), labelledControl('History table name', table));
  const check = document.createElement('button');
  check.className = 'secondary';
  check.type = 'submit';
  setText(check, 'Check database history');
  controls.append(labelledControl('DbContext', context), labelledControl('PostgreSQL database', target), location, check);
  form.append(controls);
  const guide = document.createElement('p');
  guide.className = 'hint';
  guide.hidden = true;
  setText(guide, 'Set up Project PostgreSQL or save a local PostgreSQL connection, then rescan database configuration.');
  const databaseStatus = document.createElement('p');
  databaseStatus.className = 'hint';
  databaseStatus.setAttribute('role', 'status');
  const checkedTable = document.createElement('p');
  checkedTable.className = 'hint';
  checkedTable.hidden = true;
  details.append(summary, status, guide, form, checkedTable, databaseStatus, results, refresh);

  function groupView(group, database) {
    const section = document.createElement('section');
    const header = document.createElement('p');
    const context = document.createElement('strong');
    if (group.context) context.textContent = group.context;
    else setText(context, 'Unverified DbContext');
    header.append(context);
    if (group.namespace) header.append(' · ', group.namespace);
    const list = document.createElement('ul');
    list.className = 'check-list';
    const states = new Map(database?.groupId === group.id ? database.migrations?.map(item => [item.id, item.state]) : []);
    for (const item of group.migrations) {
      const row = document.createElement('li');
      const name = document.createElement('code');
      name.textContent = item.id;
      const path = item.file.startsWith(folder) ? item.file.slice(folder.length) : item.file;
      row.append(name, ' · ', path);
      const state = states.get(item.id);
      if (!item.verified || state) {
        const flag = document.createElement('span');
        setText(flag, !item.verified ? 'Unverified' : state === 'applied' ? 'Applied' : 'Pending');
        row.append(' · ', flag);
      }
      list.append(row);
    }
    section.append(header, list);
    return section;
  }

  let loading = false, groups = [], showingHistory = false;
  function showDatabase(database) {
    showingHistory = Boolean(database);
    setText(databaseStatus, databaseMessages[database?.status] ?? '');
    checkedTable.hidden = !database?.target;
    checkedTable.textContent = database ? address(database.target) + ' · ' + database.history.schema + '.' + database.history.table : '';
    results.replaceChildren(...groups.map(group => groupView(group, database)));
    check.disabled = loading || !context.value || !target.value;
  }
  async function load(selection) {
    if (loading) return;
    loading = true;
    refresh.hidden = true;
    for (const control of [context, target, schema, table, check]) control.disabled = true;
    showDatabase();
    if (selection) setText(databaseStatus, 'Checking PostgreSQL migration history…');
    else setText(status, 'Reading EF Core migration files…');
    try {
      const { token } = await request('/api/state');
      const result = await post(`/api/projects/${projectId}/database-ef-core-preview`, token, { sourceId: source.id, ...selection }, 45000);
      groups = result.groups;
      const previous = context.value;
      const placeholder = new Option('', '');
      setText(placeholder, 'Choose a DbContext');
      context.replaceChildren(placeholder, ...groups.map(item => new Option([item.context, item.namespace].filter(Boolean).join(' · '), item.id)));
      if (groups.some(item => item.id === previous)) context.value = previous;
      else if (groups.length === 1) context.value = groups[0].id;
      form.hidden = result.status !== 'ready' || !targets.length;
      guide.hidden = result.status !== 'ready' || Boolean(targets.length);
      setText(status, result.database ? 'Local EF Core migrations found.' : messages[result.status]);
      showDatabase(result.database);
    } catch (error) {
      setText(selection ? databaseStatus : status, error.message);
      if (!selection) form.hidden = guide.hidden = true;
    } finally {
      loading = false;
      refresh.hidden = false;
      for (const control of [context, target, schema, table]) control.disabled = false;
      check.disabled = !context.value || !target.value;
    }
  }
  details.addEventListener('toggle', () => { if (details.open) void load(); });
  refresh.addEventListener('click', () => void load());
  form.addEventListener('input', () => {
    if (showingHistory) {
      setText(status, messages.ready);
      showDatabase();
    } else {
      setText(databaseStatus, '');
      check.disabled = !context.value || !target.value;
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    void load({ groupId: context.value, targetId: target.value, schema: schema.value, table: table.value });
  });
  return details;
}
