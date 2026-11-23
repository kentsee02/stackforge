import { setText } from '/i18n.js';

const statuses = {
  ready: 'The development database is accepting connections.',
  starting: 'The development database is starting…',
  stopped: 'The development database is stopped. Its data is still on disk.',
  incomplete: 'Development database setup or cleanup is incomplete.'
};

export function createDevelopmentPostgres({ $, request, post, state, renderPage, reloadDiscovery, openExisting, archive }) {
  const el = name => $('development-postgres-' + name);
  const panel = $('project-development-postgres');
  let view, confirmation, timer, shownStatus;
  const engines = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlserver: 'SQL Server' };
  const createLabels = { postgres: 'Create project PostgreSQL', mysql: 'Create project MySQL', sqlserver: 'Create project SQL Server' };
  const selectedOption = () => view?.info?.options?.find(item => item.id === el('choice').value);

  function renderConfirmation() {
    el('apply').disabled = !view || view.working || view.locked || el('confirm').value !== el('confirm-target').textContent ||
      !el('terms').hidden && !el('accept-terms').checked;
  }

  function renderControls() {
    if (!view) return;
    const { info, working, problem, message, locked, offline } = view;
    const disabled = working || locked;
    const selected = selectedOption();
    const choiceStatus = info?.status === 'absent' && (info.limited ? 'The scan reached its file limit.' :
      !info.options?.length ? 'No database engine was identified. Configure the service and refresh detection.' :
      selected?.status === 'conflict' ? 'Database settings disagree for this service. Review the listed files.' :
      selected?.status === 'review' ? 'Confirm the detected dependency matches this service before creating a database.' :
      selected && !selected.canCreate && !selected.actions.length ? 'Use the project database configuration to set up this engine.' : '');
    const status = problem ?? message ?? statuses[info?.status] ?? (working ? 'Checking development database…' : choiceStatus || '');
    if (status !== shownStatus) {
      shownStatus = status;
      setText(el('status'), status);
    }
    el('status').classList.toggle('project-operation-error', Boolean(problem));
    el('choice-field').hidden = info?.status !== 'absent' || !info.options?.length;
    el('evidence').hidden = !selected;
    el('evidence').textContent = selected?.evidence.join(' · ') ?? '';
    el('existing').hidden = !selected?.actions.length;
    if (view.actionOption !== selected) {
      view.actionOption = selected;
      el('existing').replaceChildren(...(selected?.actions ?? []).map(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'text-button';
        setText(button, [action.provider === 'docker' ? 'Open Compose database' : 'Open database connection', action.source]);
        button.addEventListener('click', () => openExisting(action));
        return button;
      }));
    }
    for (const button of el('existing').children) button.disabled = disabled || offline;
    el('create').hidden = !selected?.canCreate || offline;
    el('controls').hidden = !info || info.status === 'absent';
    el('target').hidden = el('controls').hidden;
    if (!el('target').hidden) el('target').textContent = `${engines[info.engine ?? 'postgres']} · ${info.host}:${info.port}/${info.name}`;
    el('start').hidden = !info?.canStart || offline || ['ready', 'starting'].includes(info.status);
    el('stop').hidden = !info?.canStop;
    el('delete').hidden = !info?.canDelete;
    el('backup').hidden = el('restore').hidden = !info?.archive;
    el('backup').disabled = disabled || !info?.archive?.backup;
    el('restore').disabled = disabled || !info?.archive?.restore;
    el('connect').hidden = !info?.connections?.length || offline;
    for (const name of ['choice', 'name', 'port', 'preview', 'start', 'stop', 'delete', 'save', 'requirement']) el(name).disabled = disabled;
    el('refresh').disabled = working;
    if (el('dialog').open) renderConfirmation();
  }

  function show(info) {
    view.info = info;
    const choice = el('choice');
    const priorChoice = choice.value;
    const placeholder = new Option('', '');
    setText(placeholder, 'Choose a database service');
    choice.replaceChildren(placeholder, ...(info.options ?? []).map(item => {
      const option = new Option('', item.id);
      setText(option, [item.variant === 'mariadb' ? 'MariaDB' : engines[item.engine], item.directory === '.' ? 'Project root' : item.directory]);
      return option;
    }));
    const preferred = info.options?.find(item => item.requirementIds.includes(view.preferred));
    if (preferred) choice.value = preferred.id;
    else if (info.options?.some(item => item.id === priorChoice)) choice.value = priorChoice;
    else if (info.options?.length === 1 && info.options[0].status === 'detected') choice.value = info.options[0].id;
    suggestPort();
    const requirements = el('requirement');
    const selected = requirements.value || view.preferred;
    requirements.replaceChildren(...(info.connections ?? []).map(item => new Option(item.variable + ' · ' + item.source, item.id)));
    if (info.connections?.some(item => item.id === selected)) requirements.value = selected;
  }

  function suggestPort() {
    const engine = selectedOption()?.engine;
    if (!engine || view.portEngine === engine) return;
    view.portEngine = engine;
    el('port').value = engine === 'mysql' ? view.info.mysqlPort : engine === 'sqlserver' ? view.info.sqlServerPort : view.info.port;
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
    const title = deleting ? 'Delete database volume' : createLabels[target.engine ?? 'postgres'];
    setText(el('dialog-title'), title);
    setText(el('confirm-hint'), deleting ? 'Stop the database and type the exact volume name to delete its data.' : 'Type the target database name to confirm.');
    el('confirm-target').textContent = value;
    setText(el('dialog-target'), deleting ? endpoint : [endpoint, target.image, target.directory === '.' ? 'Project root' : target.directory, target.volume]);
    el('dialog-connection').hidden = !target.connections?.length;
    el('dialog-connection').textContent = target.connections?.map(item => item.variable + ' · ' + (item.file ?? item.source)).join(' · ') ?? '';
    el('confirm').value = '';
    el('terms').hidden = deleting || target.engine !== 'sqlserver';
    el('accept-terms').checked = false;
    if (!el('terms').hidden) el('terms-link').href = target.terms;
    el('apply').className = deleting ? 'secondary danger' : 'primary';
    el('apply').disabled = true;
    setText(el('apply'), title);
    el('dialog').showModal();
  }

  async function send(mode, payload = {}) {
    const current = view;
    if (!current || current.working || current.locked || state.pending) return;
    clearTimeout(timer);
    Object.assign(current, { working: true, problem: undefined, message: 'Working on the development database…' });
    state.pending = { id: current.id, action: 'database-development' };
    renderPage();
    try {
      const { token } = await request('/api/state');
      const result = await post('/api/projects/' + current.id + '/database-development', token, { mode, ...payload }, payload.acceptTerms ? 470000 : 210000);
      if (view !== current) return;
      if (mode === 'preview') openConfirmation('create', result);
      if (mode === 'save') {
        current.message = 'Connection settings saved. Continue with the project’s database setup.';
        void reloadDiscovery();
      } else if (mode === 'delete') current.message = 'Database volume deleted. Update any connection settings that used this instance.';
      else current.message = undefined;
      if (['create', 'start', 'delete'].includes(mode)) void reloadDiscovery();
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
  el('choice').addEventListener('change', () => { suggestPort(); renderControls(); });
  el('create').addEventListener('submit', event => {
    event.preventDefault();
    void send('preview', { name: el('name').value, port: el('port').valueAsNumber, targetId: selectedOption()?.id });
  });
  for (const mode of ['start', 'stop']) el(mode).addEventListener('click', () => void send(mode));
  for (const mode of ['backup', 'restore']) el(mode).addEventListener('click', () => archive(mode, view.info.archive.id));
  el('delete').addEventListener('click', () => openConfirmation('delete', view.info));
  el('connect').addEventListener('submit', event => {
    event.preventDefault();
    const choice = view.info.connections.find(item => item.id === el('requirement').value);
    if (choice) void send('save', { requirementId: choice.id, revision: choice.revision });
  });
  el('cancel').addEventListener('click', () => el('dialog').close());
  el('confirm').addEventListener('input', renderConfirmation);
  el('accept-terms').addEventListener('input', renderConfirmation);
  el('confirm-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!confirmation || el('apply').disabled || state.pending) return;
    const { mode, target } = confirmation;
    const confirm = el('confirm').value;
    el('dialog').close();
    void send(mode, mode === 'create' ? { plan: target.plan, name: target.name, port: target.port, targetId: target.targetId, confirm,
      ...(target.engine === 'sqlserver' && { acceptTerms: el('accept-terms').checked }) } : { confirm });
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
        el('choice').replaceChildren();
        el('transfer-message').textContent = '';
        el('name').value = ('app_' + project.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_')).slice(0, 63);
        if (panel.open) void load();
      }
      Object.assign(view, { locked, offline: project.offline });
      renderControls();
    },
    refresh: load,
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
