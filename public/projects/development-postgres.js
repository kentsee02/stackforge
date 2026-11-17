import { setText } from '/i18n.js';

const statuses = {
  ready: 'PostgreSQL is accepting connections.',
  starting: 'PostgreSQL is starting…',
  stopped: 'PostgreSQL is stopped. Its data is still on disk.',
  incomplete: 'PostgreSQL setup or cleanup is incomplete.'
};

export function createDevelopmentPostgres({ $, request, post, state, renderPage, reloadDiscovery }) {
  const el = name => $('development-postgres-' + name);
  const panel = $('project-development-postgres');
  let view, confirmation, timer, shownStatus;

  function renderConfirmation() {
    el('apply').disabled = !view || view.working || view.locked || el('confirm').value !== el('confirm-target').textContent;
  }

  function renderControls() {
    if (!view) return;
    const { info, working, problem, message, locked, offline } = view;
    const disabled = working || locked;
    const status = problem ?? message ?? statuses[info?.status] ?? (working ? 'Checking project PostgreSQL…' : '');
    if (status !== shownStatus) {
      shownStatus = status;
      setText(el('status'), status);
    }
    el('status').classList.toggle('project-operation-error', Boolean(problem));
    el('create').hidden = info?.status !== 'absent' || offline;
    el('controls').hidden = !info || info.status === 'absent';
    el('target').hidden = el('controls').hidden;
    if (!el('target').hidden) el('target').textContent = info.host + ':' + info.port + '/' + info.name;
    el('start').hidden = !info?.canStart || offline || ['ready', 'starting'].includes(info.status);
    el('stop').hidden = !info?.canStop;
    el('delete').hidden = !info?.canDelete;
    el('connect').hidden = !info?.connections?.length || offline;
    for (const name of ['name', 'port', 'preview', 'start', 'stop', 'delete', 'save', 'requirement']) el(name).disabled = disabled;
    el('refresh').disabled = working;
    if (el('dialog').open) renderConfirmation();
  }

  function show(info) {
    const previous = view.info;
    view.info = info;
    if (info.status === 'absent' && previous?.status !== 'absent') el('port').value = info.port;
    const requirements = el('requirement');
    const selected = requirements.value || view.preferred;
    requirements.replaceChildren(...(info.connections ?? []).map(item => new Option(item.variable + ' · ' + item.source, item.id)));
    if (info.connections?.some(item => item.id === selected)) requirements.value = selected;
  }

  async function load() {
    const current = view;
    if (!current || current.working || !panel.open) return;
    clearTimeout(timer);
    Object.assign(current, { working: true, problem: undefined });
    renderControls();
    try {
      const info = await request('/api/projects/' + current.id + '/database-development', { signal: AbortSignal.timeout(45000) });
      if (view === current) show(info);
    } catch (error) {
      current.problem = error.message;
      current.info = undefined;
    } finally {
      current.working = false;
      if (view === current) {
        renderControls();
        if (current.info?.status === 'starting' && panel.open && !document.hidden) timer = setTimeout(load, 1800);
      }
    }
  }

  function openConfirmation(mode, target) {
    confirmation = { mode, target };
    const deleting = mode === 'delete';
    const value = deleting ? target.volume : target.name;
    const endpoint = target.host + ':' + target.port + '/' + target.name;
    setText(el('dialog-title'), deleting ? 'Delete PostgreSQL volume' : 'Create project PostgreSQL');
    setText(el('confirm-hint'), deleting ? 'Stop PostgreSQL and type the exact volume name to delete its data.' : 'Type the target database name to confirm.');
    el('confirm-target').textContent = value;
    el('dialog-target').textContent = deleting ? endpoint : endpoint + ' · ' + target.image;
    el('confirm').value = '';
    el('apply').className = deleting ? 'secondary danger' : 'primary';
    el('apply').disabled = true;
    setText(el('apply'), deleting ? 'Delete PostgreSQL volume' : 'Create project PostgreSQL');
    el('dialog').showModal();
  }

  async function send(mode, payload = {}) {
    const current = view;
    if (!current || current.working || current.locked || state.pending) return;
    clearTimeout(timer);
    Object.assign(current, { working: true, problem: undefined, message: 'Working on project PostgreSQL…' });
    state.pending = { id: current.id, action: 'database-development' };
    renderPage();
    try {
      const { token } = await request('/api/state');
      const result = await post('/api/projects/' + current.id + '/database-development', token, { mode, ...payload }, 210000);
      if (view !== current) return;
      if (mode === 'preview') openConfirmation('create', result);
      if (mode === 'save') {
        current.message = 'Database URL saved. Continue with the project’s database setup.';
        void reloadDiscovery();
      } else if (mode === 'delete') current.message = 'PostgreSQL volume deleted. Update the project’s database URL if it used this instance.';
      else current.message = undefined;
    } catch (error) {
      current.problem = error.message;
      current.message = undefined;
    } finally {
      const problem = current.problem;
      current.working = false;
      state.pending = undefined;
      if (view === current && mode !== 'preview') {
        await load();
        if (problem) current.problem = problem;
      }
      renderPage();
    }
  }

  panel.addEventListener('toggle', () => {
    if (panel.open) void load();
    else clearTimeout(timer);
  });
  el('refresh').addEventListener('click', () => {
    if (view) view.message = undefined;
    void load();
  });
  el('create').addEventListener('submit', event => {
    event.preventDefault();
    void send('preview', { name: el('name').value, port: el('port').valueAsNumber });
  });
  for (const mode of ['start', 'stop']) el(mode).addEventListener('click', () => void send(mode));
  el('delete').addEventListener('click', () => openConfirmation('delete', view.info));
  el('connect').addEventListener('submit', event => {
    event.preventDefault();
    const choice = view.info.connections.find(item => item.id === el('requirement').value);
    if (choice) void send('save', { requirementId: choice.id, revision: choice.revision });
  });
  el('cancel').addEventListener('click', () => el('dialog').close());
  el('confirm').addEventListener('input', renderConfirmation);
  el('confirm-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!confirmation || el('apply').disabled || state.pending) return;
    const { mode, target } = confirmation;
    const confirm = el('confirm').value;
    el('dialog').close();
    void send(mode, mode === 'create' ? { plan: target.plan, name: target.name, port: target.port, confirm } : { confirm });
  });

  return {
    render(project, locked) {
      panel.hidden = !project?.canDevelopPostgres;
      if (panel.hidden) {
        clearTimeout(timer);
        panel.open = false;
        view = undefined;
        return;
      }
      if (view?.id !== project.id) {
        if (el('dialog').open) el('dialog').close();
        clearTimeout(timer);
        view = { id: project.id };
        el('name').value = ('app_' + project.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_')).slice(0, 63);
        if (panel.open) void load();
      }
      Object.assign(view, { locked, offline: project.offline });
      renderControls();
    },
    open(preferred) {
      if (!view || panel.hidden) return;
      view.preferred = preferred;
      if (panel.open) void load();
      panel.open = true;
      panel.scrollIntoView({ block: 'start' });
      panel.querySelector('summary').focus({ preventScroll: true });
    }
  };
}
