import { setText } from '/i18n.js';

const statuses = {
  pending: 'Drizzle migrations are pending for this database.',
  current: 'All local Drizzle migrations match the database history.',
  applied: 'Drizzle migrations were applied and verified.',
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
  const files = document.createElement('ul');
  const refresh = document.createElement('button');
  const form = document.createElement('form');
  const fields = document.createElement('fieldset');
  const hint = document.createElement('p');
  const label = document.createElement('label');
  const prompt = document.createElement('span');
  const confirm = document.createElement('input');
  const apply = document.createElement('button');
  target.className = 'hint';
  target.hidden = true;
  status.className = 'hint';
  status.setAttribute('role', 'status');
  files.className = 'check-list';
  refresh.className = 'secondary';
  refresh.type = 'button';
  refresh.hidden = true;
  form.hidden = true;
  fields.className = 'drizzle-confirmation';
  hint.className = 'hint';
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
  form.append(fields);
  setText(summary, 'Preview Drizzle migrations');
  setText(refresh, 'Check again');
  details.append(summary, target, status, files, form, refresh);
  let loading = false, plan;

  async function load(approval) {
    if (loading) return;
    loading = true;
    plan = undefined;
    refresh.hidden = true;
    form.hidden = true;
    if (!approval) {
      target.hidden = true;
      files.replaceChildren();
    }
    setText(status, approval ? 'Applying Drizzle migrations…' : 'Reading migration files and database history…');
    try {
      const { token } = await request('/api/state');
      const endpointName = approval ? 'database-drizzle-apply' : 'database-drizzle-preview';
      const result = await post('/api/projects/' + projectId + '/' + endpointName, token,
        { requirementId: requirement.id, ...approval }, approval ? 170000 : 60000);
      const endpoint = result.target;
      const address = endpoint && (endpoint.host.includes(':') ? '[' + endpoint.host + ']' : endpoint.host);
      target.textContent = [result.variable, endpoint && address + ':' + endpoint.port + '/' + endpoint.name, result.history].filter(Boolean).join(' · ');
      target.hidden = false;
      setText(status, [statuses[result.status], result.sources?.join(', '),
        result.applyBlocked && 'This batch contains SQL outside the supported schema additions.']);
      files.replaceChildren();
      for (const migration of result.migrations ?? []) {
        const row = document.createElement('li');
        const state = document.createElement('strong');
        setText(state, states[migration.state]);
        row.append(state, ' · ', migration.file);
        files.append(row);
      }
      if (result.planId) {
        plan = { id: result.planId, name: endpoint.name };
        confirm.value = '';
        apply.disabled = true;
        form.hidden = false;
      }
    } catch (error) {
      setText(status, error.message);
    } finally {
      refresh.hidden = false;
      loading = false;
    }
  }
  details.addEventListener('toggle', () => { if (details.open) void load(); });
  refresh.addEventListener('click', () => void load());
  confirm.addEventListener('input', () => { apply.disabled = !plan || confirm.value !== plan.name; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (plan && confirm.value === plan.name) void load({ planId: plan.id, confirmName: confirm.value });
  });
  return details;
}
