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

export function drizzlePreview(projectId, requirement, { request, post }) {
  const details = document.createElement('details');
  details.className = 'migration-preview drizzle-preview';
  const summary = document.createElement('summary');
  const target = document.createElement('p');
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
  setText(risk, 'Review the full SQL and back up this project database. The migration may change or remove existing data.');
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
  details.append(summary, target, status, cancel, files, rollbackSettings, form, refresh);
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
        { requirementId: requirement.id, ...selection, ...approval }, approval ? 170000 : 60000, operation.signal);
      const endpoint = result.target;
      const address = endpoint && (endpoint.host.includes(':') ? '[' + endpoint.host + ']' : endpoint.host);
      target.textContent = [result.variable, endpoint && address + ':' + endpoint.port + '/' + endpoint.name, result.history].filter(Boolean).join(' · ');
      target.hidden = false;
      setText(status, [statuses[result.status], result.sources?.join(', '),
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
