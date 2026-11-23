import { setText } from '/i18n.js';
import { labelledMigrationControl, migrationHistoryName, postgresHistoryMessages } from '/projects/migration-history.js';
import { nativeMigrationControls } from '/projects/native-migration.js';

const historyMessages = {
  ...postgresHistoryMessages,
  pending: 'Some local migrations have no current history record on this database.',
  recorded: 'Every listed forward migration has a matching history record.',
  'history-missing': 'The selected history table was not found. Check the schema and table name.',
  'history-conflict': 'The database history differs from the local migration files. Review the selected target and configuration.',
  'history-partial': 'Some database history entries require verification with the migration tool.',
  'history-unavailable': 'The selected table does not have a supported migration history layout.'
};
const mysqlMessages = {
  'target-changed': 'The MySQL target changed. Rescan database configuration and select it again.',
  'container-stopped': 'Start Project MySQL and check the migration history again.',
  authentication: 'MySQL rejected the saved credentials.',
  database: 'The selected MySQL database is unavailable.',
  server: 'MySQL did not respond on this port.',
  permission: 'MySQL denied access to migration history.',
  tls: 'Could not establish the MySQL TLS connection.',
  client: 'Install mysql and add it to PATH to check this database.',
  connection: 'Could not verify the MySQL connection.'
};

export function migrationSourcePreview(projectId, source, { request, post, historyTargets = [] }, { adapter, title, reading, rescan, scope, messages, render, tableName }) {
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
  const guide = document.createElement('p');
  const historyStatus = document.createElement('p');
  const form = document.createElement('form');
  const controls = document.createElement('fieldset');
  const select = document.createElement('select');
  const empty = new Option('', '');
  const schema = migrationHistoryName(source.nativeSchema ?? 'public');
  const table = migrationHistoryName(tableName);
  const check = document.createElement('button');
  select.required = true;
  setText(empty, 'Choose a migration database');
  select.append(empty);
  for (const target of historyTargets) {
    const host = target.host.includes(':') ? '[' + target.host + ']' : target.host;
    const address = host + ':' + target.port + '/' + target.name;
    const option = new Option([address, target.source, target.variable].filter(Boolean).join(' · '), target.id);
    if (target.projectPostgres) setText(option, ['Project PostgreSQL', address]);
    else if (target.projectMysql) setText(option, ['Project MySQL', address]);
    else if (target.engine === 'mysql') option.textContent = 'MySQL · ' + option.textContent;
    select.append(option);
  }
  check.className = 'secondary';
  check.type = 'submit';
  check.disabled = true;
  setText(check, 'Check database history');
  controls.className = 'migration-history-controls';
  const schemaLabel = labelledMigrationControl('History schema', schema);
  controls.append(labelledMigrationControl('Migration database', select), schemaLabel,
    labelledMigrationControl('History table name', table), check);
  form.append(controls);
  guide.className = historyStatus.className = 'hint';
  historyStatus.setAttribute('role', 'status');
  setText(guide, 'Set up a project database or save a direct local PostgreSQL or MySQL connection, then rescan database configuration.');
  guide.hidden = form.hidden = true;
  refresh.type = 'button';
  refresh.className = 'secondary';
  refresh.hidden = true;
  setText(refresh, rescan);
  details.append(summary, status, guide, form, historyStatus, results, refresh);
  const eligible = source.scope === 'standalone' ||
    adapter === 'flyway' && source.nativeLocations ||
    source.scope === 'spring' && !source.profile && /(?:^|\/)application\.properties$/i.test(source.source);
  const selected = () => ({ targetId: select.value, schema: schema.value, table: table.value });
  const canMigrate = () => eligible && historyTargets.some(target => target.id === select.value && (target.projectPostgres || target.projectMysql));
  let nativeWorking = false;
  const native = eligible ? nativeMigrationControls(projectId, source, { request, post }, {
    selection: selected,
    lock(locked) { nativeWorking = controls.disabled = refresh.disabled = locked; },
    refresh: () => load(select.value, true)
  }) : undefined;
  if (native) details.append(native.element);

  let loading = false, lastPreview, defaultTable = tableName;
  function showResult(result) {
    results.replaceChildren(...render(result, relativePath));
    setText(status, result.database ? '' : messages[result.status]);
    const message = result.database?.target?.engine === 'mysql' && mysqlMessages[result.database.status];
    setText(historyStatus, message || historyMessages[result.database?.status] || '');
  }
  async function load(targetId, afterExecution = false) {
    if (loading || nativeWorking && !afterExecution) return;
    loading = true;
    refresh.hidden = true;
    controls.disabled = true;
    if (!targetId) results.replaceChildren();
    setText(historyStatus, '');
    setText(status, targetId ? 'Checking migration history…' : reading);
    try {
      const { token } = await request('/api/state');
      const selection = targetId ? selected() : {};
      const result = await post('/api/projects/' + projectId + '/database-' + adapter + '-preview', token, { sourceId: source.id, ...selection }, 45000);
      const { database, ...preview } = result;
      lastPreview = preview;
      form.hidden = result.status !== 'ready' || !historyTargets.length;
      guide.hidden = result.status !== 'ready' || Boolean(historyTargets.length);
      showResult(result);
      native?.setTags(database?.tags);
      if (!afterExecution) {
        if (adapter === 'flyway') native?.setRevisions(result.migrations.every(item => item.kind === 'versioned') ?
          result.migrations.map(item => item.version) : []);
        native?.reset(result.status === 'ready' && canMigrate());
      }
    } catch (error) {
      setText(status, error.message);
    } finally {
      loading = false;
      refresh.hidden = false;
      controls.disabled = false;
      schema.disabled = schemaLabel.hidden;
    }
  }
  details.addEventListener('toggle', () => { if (details.open) void load(); });
  refresh.addEventListener('click', () => void load());
  form.addEventListener('submit', event => { event.preventDefault(); if (select.value) void load(select.value); });
  form.addEventListener('input', () => {
    check.disabled = !select.value;
    const mysql = historyTargets.find(item => item.id === select.value)?.engine === 'mysql';
    schema.disabled = schemaLabel.hidden = mysql;
    const nextTable = mysql && adapter === 'liquibase' ? 'DATABASECHANGELOG' : tableName;
    if (table.value === defaultTable) table.value = nextTable;
    defaultTable = nextTable;
    native?.setTags();
    if (lastPreview) showResult(lastPreview);
    native?.reset(lastPreview?.status === 'ready' && canMigrate());
  });
  return details;
}

const stateLabels = { applied: 'Applied', pending: 'Pending', recorded: 'Recorded', marked: 'Marked as run',
  changed: 'Checksum changed', outdated: 'Outdated repeatable migration', unverified: 'Unverified' };

export function migrationHistoryState(row, state) {
  if (!stateLabels[state]) return;
  const badge = document.createElement('span');
  setText(badge, stateLabels[state]);
  row.append(' · ', badge);
}

export function markUnverified(row) {
  const flag = document.createElement('span');
  setText(flag, 'Unverified');
  row.append(' · ', flag);
}
