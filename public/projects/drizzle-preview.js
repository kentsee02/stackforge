import { setText } from '/i18n.js';
import { labelledMigrationControl } from '/projects/migration-history.js';

const statuses = {
  pending: 'Drizzle migrations are pending for this database.',
  current: 'All local Drizzle migrations match the database history.',
  applied: 'Drizzle migrations were applied and verified.',
  'rollback-planned': 'Review the Drizzle rollback before confirming.',
  'rolled-back': 'Rollback finished and the database history was verified.',
  'apply-failed': 'Could not complete the Drizzle migration. Check the database and preview again.',
  'apply-unverified': 'The migration transaction finished. Check again to verify the database history.',
  'files-unavailable': 'The PostgreSQL Drizzle journal or one of its SQL files could not be verified.',
  'configuration-needed': 'Save a supported direct PostgreSQL URL in the displayed variable, then check again.',
  'environment-conflict': 'The connection variable has conflicting sources. Resolve them and check again.',
  'remote-target': 'Choose a local PostgreSQL URL to verify migration history.',
  'history-conflict': 'Database history and local migration files could not be matched. Review the target before migrating.',
  'loopback-ambiguous': 'Both IPv4 and IPv6 are listening. Use an explicit loopback address in the database URL.',
  'docker-unreachable': 'Open Project PostgreSQL and verify that the container is running and its port is reachable.',
  authentication: 'PostgreSQL rejected the username or password.',
  database: 'The configured PostgreSQL database is missing.',
  server: 'No server responded on this port. Start PostgreSQL and check again.',
  permission: 'PostgreSQL denied access. Check the account permissions or server access rules.',
  tls: 'PostgreSQL could not establish the requested TLS connection.',
  client: 'Install psql and add it to PATH to check this database.',
  connection: 'Could not verify the PostgreSQL connection.'
};

const states = { applied: 'Applied', pending: 'Pending', unverified: 'Unverified' };
const mysqlStatuses = {
  'files-unavailable': 'The MySQL Drizzle journal or one of its SQL files could not be verified.',
  'configuration-needed': 'Save a supported direct MySQL URL in the displayed variable, then check again.',
  'remote-target': 'Choose a local MySQL URL to verify migration history.',
  'docker-unreachable': 'Open Project MySQL and verify that the container is running and its port is reachable.',
  'project-mysql-required': 'To apply these migrations, configure a project-owned MySQL database.',
  'history-upgrade-required': 'Upgrade the legacy MySQL migration history with Drizzle before using these v1 folders.',
  'unscoped-account': 'MySQL migrations require an account with grants restricted to the target database.',
  'recovery-required': 'MySQL may have committed some changes. Check the target and restore a verified backup to an empty project database before retrying.',
  'apply-unverified': 'MySQL changes ran, but the resulting migration history could not be verified.',
  authentication: 'MySQL rejected the username or password.',
  database: 'The configured MySQL database is missing.',
  server: 'No server responded on this port. Start MySQL and check again.',
  permission: 'MySQL denied access. Check the account permissions or server access rules.',
  tls: 'MySQL could not establish the requested TLS connection.',
  client: 'Install mysql and add it to PATH to check this database.',
  connection: 'Could not verify the MySQL connection.'
};
const sqliteStatuses = {
  'files-unavailable': 'The SQLite Drizzle journal or one of its SQL files could not be verified.',
  'configuration-needed': 'Choose a SQLite database file inside the project, then check again.',
  'history-upgrade-required': 'Upgrade the legacy SQLite migration history with Drizzle before using these v1 folders.',
  'sqlite-file-invalid': 'SQLite could not read or verify the database file.',
  'sqlite-locked': 'The SQLite database is locked. Stop the writer or retry.',
  'sqlite-runtime': 'Use Node.js 24.10 or later to apply SQLite migrations in StackForge.',
  'sqlite-sql-blocked': 'SQLite rolled back the batch because it contains unsupported migration commands.',
  'apply-failed': 'Could not apply the SQLite migrations. The batch was rolled back.',
  'apply-unverified': 'SQLite changes ran, but the resulting migration history could not be verified.'
};

export function drizzlePreview(projectId, requirement, { request, post }) {
  const details = document.createElement('details');
  details.className = 'migration-preview drizzle-preview';
  const summary = document.createElement('summary');
  const target = document.createElement('p');
  const databaseFile = document.createElement('input');
  const databaseChoice = labelledMigrationControl('SQLite file path inside the project', databaseFile);
  const status = document.createElement('p');
  const cancel = document.createElement('button');
  const files = document.createElement('ul');
  const refresh = document.createElement('button');
  const rollbackSettings = document.createElement('fieldset');
  const revision = document.createElement('select');
  const scriptFile = document.createElement('input');
  const previewRollback = document.createElement('button');
  const form = document.createElement('form');
  const fields = document.createElement('fieldset');
  const hint = document.createElement('p');
  const review = document.createElement('pre');
  const range = document.createElement('p');
  const risk = document.createElement('p');
  const label = document.createElement('label');
  const prompt = document.createElement('span');
  const confirm = document.createElement('input');
  const apply = document.createElement('button');
  databaseChoice.hidden = true;
  databaseFile.maxLength = 320;
  databaseFile.autocomplete = 'off';
  databaseFile.spellcheck = false;
  target.className = 'hint';
  target.hidden = true;
  status.className = 'hint';
  status.setAttribute('role', 'status');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.hidden = true;
  setText(cancel, 'Cancel migration operation');
  files.className = 'check-list';
  refresh.className = 'secondary';
  refresh.type = 'button';
  refresh.hidden = true;
  form.hidden = true;
  rollbackSettings.className = 'drizzle-confirmation';
  rollbackSettings.hidden = true;
  scriptFile.maxLength = 380;
  scriptFile.autocomplete = 'off';
  scriptFile.spellcheck = false;
  previewRollback.type = 'button';
  previewRollback.className = 'secondary';
  previewRollback.disabled = true;
  setText(previewRollback, 'Preview rollback plan');
  rollbackSettings.append(labelledMigrationControl('Target revision', revision),
    labelledMigrationControl('Rollback SQL file relative to the project', scriptFile), previewRollback);
  fields.className = 'drizzle-confirmation';
  hint.className = 'hint';
  review.className = 'drizzle-sql-review';
  range.className = 'hint';
  risk.className = 'hint';
  label.className = 'inline-field';
  confirm.autocomplete = 'off';
  confirm.spellcheck = false;
  confirm.required = true;
  apply.className = 'primary';
  apply.disabled = true;
  apply.type = 'submit';
  setText(hint, 'Review the listed SQL files before applying them.');
  setText(prompt, 'Type the target database name to confirm.');
  setText(apply, 'Apply Drizzle migrations');
  label.append(prompt, confirm);
  fields.append(hint, label, apply);
  form.append(range, review, risk, fields);
  setText(summary, 'Preview Drizzle migrations');
  setText(refresh, 'Check again');
  details.append(summary, target, status, databaseChoice, cancel, files, rollbackSettings, form, refresh);
  let active, plan;

  async function load(approval, selection) {
    if (active) return;
    const operation = new AbortController();
    active = operation;
    cancel.hidden = false;
    plan = undefined;
    refresh.hidden = true;
    form.hidden = true;
    rollbackSettings.disabled = true;
    if (!approval) {
      target.hidden = true;
      files.replaceChildren();
    }
    setText(status, approval ? selection ? 'Running the migration tool and verifying database history…' : 'Applying Drizzle migrations…' :
      'Reading migration files and database history…');
    try {
      const { token } = await request('/api/state');
      const endpointName = approval ? 'database-drizzle-apply' : 'database-drizzle-preview';
      const result = await post('/api/projects/' + projectId + '/' + endpointName, token,
        { requirementId: requirement.id, ...selection, ...approval,
          ...(!databaseChoice.hidden && databaseFile.value.trim() && { databaseFile: databaseFile.value.trim() }) },
        approval ? 170000 : 60000, operation.signal);
      const endpoint = result.target;
      const address = endpoint?.host && (endpoint.host.includes(':') ? '[' + endpoint.host + ']' : endpoint.host);
      target.textContent = [result.variable, endpoint?.path ?? (address && address + ':' + endpoint.port + '/' + endpoint.name), result.history].filter(Boolean).join(' · ');
      target.hidden = false;
      databaseChoice.hidden = !result.chooseFile;
      const mysql = result.engine === 'mysql';
      const sqlite = result.engine === 'sqlite';
      setText(status, [(sqlite && sqliteStatuses[result.status]) || (mysql && mysqlStatuses[result.status]) || statuses[result.status], result.sources?.join(', '),
        result.applyBlocked && 'This batch contains SQL outside the supported migration commands for this database.']);
      files.replaceChildren();
      for (const migration of result.migrations ?? []) {
        const row = document.createElement('li');
        const state = document.createElement('strong');
        setText(state, states[migration.state]);
        row.append(state, ' · ', migration.file);
        files.append(row);
      }
      const previous = revision.value;
      const choices = (result.rollbackTargets ?? []).map(tag => {
        if (tag !== null) return new Option(tag, tag);
        const option = new Option('', '');
        setText(option, 'Before the first migration');
        return option;
      });
      revision.replaceChildren(...choices);
      if (choices.some(option => option.value === previous)) revision.value = previous;
      rollbackSettings.hidden = !choices.length;
      if (result.planId) {
        plan = { id: result.planId, name: endpoint.name, selection };
        review.hidden = risk.hidden = !result.reviewSql;
        review.textContent = result.reviewSql ?? '';
        setText(risk, mysql ? 'Back up the database before applying. MySQL schema changes can commit even when a later statement fails.' : sqlite ?
          'Back up the SQLite file before applying. If the selected file is missing, StackForge will create it.' :
          'Review the full SQL and back up this project database. The migration may change or remove existing data.');
        range.hidden = !result.toRevision;
        range.textContent = result.toRevision ? result.fromRevision + ' → ' + result.toRevision : '';
        setText(apply, selection ? 'Run reviewed rollback' : 'Apply Drizzle migrations');
        confirm.value = '';
        apply.disabled = true;
        form.hidden = false;
      }
    } catch (error) {
      setText(status, operation.signal.aborted ? 'Cancellation requested. Check database history before starting again.' : error.message);
    } finally {
      refresh.hidden = false;
      rollbackSettings.disabled = false;
      cancel.hidden = true;
      active = undefined;
    }
  }
  details.addEventListener('toggle', () => { if (details.open) void load(); });
  refresh.addEventListener('click', () => void load());
  cancel.addEventListener('click', () => active?.abort());
  const updateRollback = () => {
    previewRollback.disabled = !scriptFile.value.trim();
    if (plan?.selection) {
      form.hidden = true;
      plan = undefined;
    }
  };
  revision.addEventListener('change', updateRollback);
  databaseFile.addEventListener('input', () => {
    form.hidden = true;
    plan = undefined;
  });
  scriptFile.addEventListener('input', updateRollback);
  previewRollback.addEventListener('click', () => void load(undefined, {
    operation: 'rollback', revision: revision.value || null, scriptFile: scriptFile.value.trim()
  }));
  confirm.addEventListener('input', () => { apply.disabled = !plan || confirm.value !== plan.name; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (plan && confirm.value === plan.name) void load({ planId: plan.id, confirmName: confirm.value }, plan.selection);
  });
  return details;
}
