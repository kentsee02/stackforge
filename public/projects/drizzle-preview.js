import { setText } from '/i18n.js';

const statuses = {
  pending: 'Drizzle migrations are pending for this database.',
  current: 'All local Drizzle migrations match the database history.',
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
  details.className = 'drizzle-preview';
  const summary = document.createElement('summary');
  const target = document.createElement('p');
  const status = document.createElement('p');
  const files = document.createElement('ul');
  const refresh = document.createElement('button');
  target.className = 'hint';
  target.hidden = true;
  status.className = 'hint';
  status.setAttribute('role', 'status');
  files.className = 'check-list';
  refresh.className = 'secondary';
  refresh.type = 'button';
  refresh.hidden = true;
  setText(summary, 'Preview Drizzle migrations');
  setText(refresh, 'Check again');
  details.append(summary, target, status, files, refresh);
  let loading = false;

  async function load() {
    if (loading) return;
    loading = true;
    refresh.hidden = true;
    target.hidden = true;
    files.replaceChildren();
    setText(status, 'Reading migration files and database history…');
    try {
      const { token } = await request('/api/state');
      const result = await post('/api/projects/' + projectId + '/database-drizzle-preview', token,
        { requirementId: requirement.id }, 60000);
      const endpoint = result.target;
      const address = endpoint && (endpoint.host.includes(':') ? '[' + endpoint.host + ']' : endpoint.host);
      target.textContent = [result.variable, endpoint && address + ':' + endpoint.port + '/' + endpoint.name, result.history].filter(Boolean).join(' · ');
      target.hidden = false;
      setText(status, [statuses[result.status], result.sources?.join(', ')]);
      for (const migration of result.migrations ?? []) {
        const row = document.createElement('li');
        const state = document.createElement('strong');
        setText(state, states[migration.state]);
        row.append(state, ' · ', migration.file);
        files.append(row);
      }
    } catch (error) {
      setText(status, error.message);
    } finally {
      refresh.hidden = false;
      loading = false;
    }
  }
  details.addEventListener('toggle', () => { if (details.open) void load(); });
  refresh.addEventListener('click', load);
  return details;
}
