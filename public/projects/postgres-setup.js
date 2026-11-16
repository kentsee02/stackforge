import { setText } from '/i18n.js';

const messages = {
  server: 'No server responded on this port. Start PostgreSQL and check again.',
  stopped: 'A local PostgreSQL service is installed and stopped. Start it and check again.',
  client: 'The port is open. Install psql to identify the server and check the database.',
  credentials: 'The port is open. Enter the PostgreSQL account to check the database.',
  check: 'Check the saved connection and migration status.',
  authentication: 'PostgreSQL rejected the username or password.',
  permission: 'PostgreSQL denied access. Check the account permissions or server access rules.',
  tls: 'PostgreSQL could not establish the requested TLS connection.',
  connection: 'Could not verify the PostgreSQL connection.',
  remote: 'Use the remote connection panel below to test this hosted database.',
  database: 'The PostgreSQL server is reachable. The selected database is missing.',
  configure: 'The database is reachable. Save its connection in the project environment file.',
  'migrations-unavailable': 'No supported Prisma migration files were detected.',
  'migration-conflict': 'Migration history or existing tables need review before applying changes.',
  'prisma-client': 'Install the project dependencies to make the local Prisma 7 CLI available.',
  migration: 'Review the pending migrations. Applying them runs SQL from this project.',
  'migration-failed': 'Prisma migration failed. Check the target and migration history before retrying.',
  empty: 'Prisma migration history is up to date, but the target schema has no tables.',
  'loopback-ambiguous': 'Both IPv4 and IPv6 are listening. Use an explicit loopback address in the database URL.',
  ready: 'Database is ready. The connection, migration history, and tables were verified.',
  'environment-conflict': 'StackForge could not verify that Prisma and the project use the same database URL. Check the environment configuration.'
};

export function createPostgresSetup({ $, post, request, state, renderPage, reload, edit }) {
  const el = suffix => $('postgres-setup-' + suffix);
  let current, result, busy = false;

  function render() {
    const mode = result?.status === 'configure' ? 'save' : result?.planId && (result.status === 'database' ? 'create' : 'migrate');
    const conflict = result?.status === 'environment-conflict';
    el('guide').hidden = !['server', 'stopped', 'client'].includes(result?.status);
    el('edit').hidden = busy || !current?.requirement.environmentEdit ||
      !['server', 'authentication', 'permission', 'tls', 'connection', 'remote', 'loopback-ambiguous'].includes(result?.status);
    el('dependencies').hidden = busy || result?.status !== 'prisma-client';
    el('fields').hidden = conflict || current?.configured;
    el('fields').disabled = busy || conflict || Boolean(current?.configured);
    el('check').hidden = conflict || ['ready', 'remote'].includes(result?.status);
    el('check').disabled = busy;
    el('close').disabled = busy;
    el('next').hidden = !mode;
    el('next').dataset.mode = mode || '';
    el('confirm-field').hidden = !mode || mode === 'save';
    el('confirm').disabled = busy || el('confirm-field').hidden;
    el('confirm-target').textContent = result?.target?.name ?? '';
    el('next').disabled = busy || (mode !== 'save' && el('confirm').value !== result?.target?.name);
    if (mode) setText(el('next'), { create: 'Create database', save: 'Save database URL', migrate: 'Apply Prisma migrations' }[mode]);
  }

  function show(next) {
    result = next;
    el('confirm').value = '';
    const address = next.target?.host.includes(':') ? `[${next.target.host}]` : next.target?.host;
    el('target').textContent = next.target ? `${address}:${next.target.port}/${next.target.name} · ${next.target.variable} · ${next.target.envPath}` : '';
    setText(el('status'), [messages[next.status], next.code, typeof next.tables === 'number' && `${next.tables} database tables`,
      next.sources?.length && `Review ${next.sources.join(', ')} and rescan database configuration.`,
      next.status === 'database' && !next.planId && 'Use an account with permission to create databases.']);
    el('migrations').replaceChildren(...(next.pending ?? []).map(name => {
      const item = document.createElement('li');
      item.textContent = name;
      return item;
    }));
    render();
  }

  async function send(mode) {
    if (busy || state.pending || !current) return;
    const payload = { mode, requirementId: current.requirement.id, planId: result?.planId, confirmName: el('confirm').value };
    if (['create', 'save'].includes(mode) && current.requirement.status === 'placeholder') {
      payload.revision = current.requirement.environmentEdit?.revision;
    }
    if (!current.configured) Object.assign(payload, { name: el('name').value.trim(), host: el('host').value,
      port: el('port').valueAsNumber, user: el('user').value.trim(), password: el('password').value });
    busy = true;
    state.pending = { id: current.projectId, action: 'database-postgres-setup' };
    setText(el('status'), 'Checking PostgreSQL setup…');
    render();
    renderPage();
    try {
      const { token } = await request('/api/state');
      const endpoint = `/api/projects/${current.projectId}/database-postgres-setup`;
      const next = await post(endpoint, token, payload, 145_000);
      if (mode === 'save') {
        current.requirement = await reload(current.requirement.id) ?? current.requirement;
        current.configured = true;
        el('password').value = '';
        show(await post(endpoint, token, { mode: 'inspect', requirementId: current.requirement.id }, 45_000));
      } else show(next);
    } catch (error) {
      result = undefined;
      setText(el('status'), error.message);
    } finally {
      state.pending = undefined;
      busy = false;
      render();
      renderPage();
    }
  }

  el('form').addEventListener('submit', event => { event.preventDefault(); void send('inspect'); });
  el('fields').addEventListener('input', () => show({}));
  el('confirm').addEventListener('input', render);
  el('next').addEventListener('click', () => { if (el('form').reportValidity()) void send(el('next').dataset.mode); });
  el('close').addEventListener('click', () => el('dialog').close());
  el('edit').addEventListener('click', () => {
    const selected = current;
    el('dialog').close();
    edit(selected.projectId, selected.requirement);
  });
  el('dependencies').addEventListener('click', () => {
    el('dialog').close();
    $('install-dependencies').focus();
  });
  el('dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  el('dialog').addEventListener('close', () => { el('form').reset(); current = result = undefined; });
  return (projectId, projectName, requirement) => {
    if (busy || state.pending) return;
    el('form').reset();
    current = { projectId, requirement, configured: requirement.status === 'configured' };
    el('name').value = projectName.replace(/[^\w-]/g, '_').slice(0, 63);
    show({});
    el('dialog').showModal();
    void send(current.configured ? 'inspect' : 'probe');
  };
}
