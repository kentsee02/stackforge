import { setText } from '/i18n.js';
import { labelledMigrationControl, migrationHistoryName, postgresHistoryMessages } from '/projects/migration-history.js';
import { nativeMigrationControls } from '/projects/native-migration.js';

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
const sqlServerMessages = {
  'target-changed': 'The SQL Server target changed. Rescan database configuration and select it again.',
  authentication: 'SQL Server rejected the saved credentials.',
  database: 'The selected SQL Server database is unavailable.',
  server: 'SQL Server did not respond on this port.',
  permission: 'SQL Server denied access to migration history.',
  tls: 'Could not establish the SQL Server TLS connection.',
  client: 'Install sqlcmd and add it to PATH to check this database.',
  connection: 'Could not verify the SQL Server connection.'
};

const address = ({ host, port, name }) => (host.includes(':') ? '[' + host + ']' : host) + ':' + port + '/' + name;

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
  setText(targetPlaceholder, 'Choose a migration database');
  target.append(targetPlaceholder);
  for (const item of targets) {
    const option = new Option('', item.id);
    if (item.projectPostgres) setText(option, ['Project PostgreSQL', address(item)]);
    else if (item.projectSqlServer) setText(option, ['Project SQL Server', address(item)]);
    else option.textContent = [item.engine === 'sqlserver' ? 'SQL Server' : 'PostgreSQL', address(item), item.source, item.variable].filter(Boolean).join(' · ');
    target.append(option);
  }
  const location = document.createElement('details');
  location.className = 'migration-history-location';
  const locationSummary = document.createElement('summary');
  setText(locationSummary, 'History table');
  const schema = migrationHistoryName('public');
  const table = migrationHistoryName('__EFMigrationsHistory');
  location.append(locationSummary, labelledMigrationControl('History schema', schema), labelledMigrationControl('History table name', table));
  const check = document.createElement('button');
  check.className = 'secondary';
  check.type = 'submit';
  setText(check, 'Check database history');
  controls.append(labelledMigrationControl('DbContext', context), labelledMigrationControl('Migration database', target), location, check);
  form.append(controls);
  const guide = document.createElement('p');
  guide.className = 'hint';
  guide.hidden = true;
  setText(guide, 'Set up Project PostgreSQL or Project SQL Server, or save a direct local connection to check history.');
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

  let loading = false, groups = [], showingHistory = false, nativeWorking = false, ready = false;
  const selection = () => ({ groupId: context.value, targetId: target.value, schema: schema.value, table: table.value });
  const canMigrate = () => ready && context.value && targets.some(item => item.id === target.value && (item.projectPostgres || item.projectSqlServer));
  const native = nativeMigrationControls(projectId, source, { request, post }, {
    selection,
    lock(locked) { nativeWorking = controls.disabled = refresh.disabled = locked; },
    refresh: () => load(selection(), true)
  });
  details.append(native.element);
  function syncNative() {
    native.setRevisions(groups.find(group => group.id === context.value)?.migrations.map(item => item.id) ?? []);
    native.reset(canMigrate());
  }
  function showDatabase(database) {
    showingHistory = Boolean(database);
    const message = database?.target?.engine === 'sqlserver' && sqlServerMessages[database.status];
    setText(databaseStatus, message || databaseMessages[database?.status] || '');
    checkedTable.hidden = !database?.target;
    checkedTable.textContent = database ? address(database.target) + ' · ' + database.history.schema + '.' + database.history.table : '';
    results.replaceChildren(...groups.map(group => groupView(group, database)));
    check.disabled = loading || !context.value || !target.value;
  }
  async function load(selection, afterExecution = false) {
    if (loading || nativeWorking && !afterExecution) return;
    loading = true;
    refresh.hidden = true;
    for (const control of [context, target, schema, table, check]) control.disabled = true;
    showDatabase();
    if (selection) setText(databaseStatus, 'Checking migration history…');
    else setText(status, 'Reading EF Core migration files…');
    try {
      const { token } = await request('/api/state');
      const result = await post(`/api/projects/${projectId}/database-ef-core-preview`, token, { sourceId: source.id, ...selection }, 45000);
      groups = result.groups;
      ready = result.status === 'ready';
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
      if (!afterExecution) syncNative();
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
  let defaultSchema = 'public';
  target.addEventListener('input', () => {
    const next = targets.find(item => item.id === target.value)?.engine === 'sqlserver' ? 'dbo' : 'public';
    if (schema.value === defaultSchema) schema.value = next;
    defaultSchema = next;
  });
  form.addEventListener('input', () => {
    if (showingHistory) {
      setText(status, messages.ready);
      showDatabase();
    } else {
      setText(databaseStatus, '');
      check.disabled = !context.value || !target.value;
    }
    syncNative();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    void load(selection());
  });
  return details;
}
