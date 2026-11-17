import { setText } from '/i18n.js';
import { createPostgresSetup } from '/projects/postgres-setup.js';

export function createDatabasePanel({ $, request, post, showMessage, renderOutput, stackNames, diagnosticMessages, state,
  selectedId, selectedProject, renderPage, refresh, act, openDevelopment }) {
  let databaseView;
  let databaseDiscovery;
  let configuringDatabase;
  let restoring;
  let deletingDatabase;
  let transferMessage;
  const openPostgresSetup = createPostgresSetup({ $, request, post, state, renderPage, reload: loadDatabaseDiscovery, edit: openDatabaseConnection,
    canDevelop: () => selectedProject()?.canDevelopPostgres, openDevelopment });

  function showParts(element, parts) {
    delete element.dataset.message;
    setText(element, parts);
  }

  const databaseLabels = { absent: 'Database not created', stopped: '已停止', running: '运行中', starting: '正在启动…', stopping: '正在停止…', restarting: 'Restarting…', unhealthy: 'Health check failed', paused: 'Paused' };

  function renderDatabase(project, busy, unavailable) {
    const details = $('project-database');
    details.hidden = project.database === 'none' && !project.hasComposeDatabase;
    if (databaseView?.id !== project.id) databaseView = { id: project.id, next: 0 };
    const view = databaseView;
    $('database-compose-target').hidden = (view.services?.length ?? 0) < 2;
    $('database-compose-service').disabled = unavailable || view.loading || Boolean(state.pending) || project.operation === 'databaseTask';
    const task = project.databaseTask;
    if (view.taskStatus !== task?.status) view.next = 0;
    view.taskStatus = task?.status;
    const changing = project.operation === 'databaseTask';
    const status = changing && task?.phase !== 'database-delete' ? (task?.phase === 'database-stop' ? 'stopping' : 'starting') : view.status;
    $('database-engine').textContent = stackNames[view.engine ?? project.database] ?? '';
    showMessage($('database-status'), databaseLabels[status] ?? (view.error ? 'Database status unavailable' : 'Checking database…'));
    const transitioning = project.unmanaged ? ['starting', 'stopping'].includes(project.status) : busy && !project.initialized;
    const disabled = unavailable || transitioning || !view.status || Boolean(view.error);
    const can = view.capabilities ?? {};
    $('database-start').disabled = disabled || !can.start;
    $('database-stop').disabled = disabled || !can.stop;
    $('database-logs').disabled = view.loading || Boolean(view.error) || !can.logs;
    $('database-backup').disabled = unavailable || Boolean(view.error) || !can.backup;
    $('database-restore').disabled = unavailable || busy || Boolean(view.error) || !can.restore;
    const deleteVolume = $('database-delete');
    deleteVolume.hidden = project.unmanaged || project.database === 'none';
    deleteVolume.disabled = disabled || busy || !can.delete;
    const transfer = transferMessage?.id === project.id ? transferMessage.message :
      task?.phase === 'database-delete' && task.status === 'succeeded' ? 'Database data volume deleted.' : '';
    showMessage($('database-transfer-message'), transfer);
    $('database-transfer-message').hidden = !transfer;
    const issue = task?.diagnostic ?? view.diagnostic;
    const hint = issue === 'docker' ? 'Start Docker Desktop or the Docker Engine to manage the database.' : diagnosticMessages[issue];
    const error = state.actionError?.id === project.id && state.actionError.action?.startsWith('database-') ? state.actionError.message :
      hint ?? task?.error ?? view.error ?? view.startHint ?? view.restoreHint ?? view.deleteHint;
    showMessage($('database-error'), error);
    $('database-error').hidden = !error;
    $('database-transition').hidden = !transitioning || Boolean(error);
    $('database-output').hidden = !task?.log || task.status === 'succeeded';
    renderOutput($('database-output'), project.id, task?.log);
    $('database-log-empty').hidden = view.log !== '';
    $('database-container-log').hidden = !view.log;
    renderOutput($('database-container-log'), project.id, view.log);
  }

  async function archiveRequest(project, action, binding, file, approval) {
    const { token } = await request('/api/state');
    const path = action === 'backup' ? '' : '/' + action;
    const response = await fetch(`/api/projects/${project.id}/database-archive${path}`, {
      method: 'POST', signal: AbortSignal.timeout(660_000),
      headers: { 'X-StackForge-Token': token, 'Content-Type': file ? 'application/octet-stream' : 'application/json',
        ...(binding && { 'X-StackForge-Binding': binding.id }),
        ...(approval && { 'X-StackForge-Preview': approval.id,
          'X-StackForge-Target': btoa(String.fromCharCode(...new TextEncoder().encode(approval.name))) }) },
      body: file ?? '{}'
    });
    if (!response.ok) throw new Error((await response.json()).error);
    return response;
  }

  async function backupAction(project, binding) {
    if (!project || state.pending) return;
    state.pending = { id: project.id, action: 'database-backup' };
    const message = value => {
      if (binding && !binding.compose && selectedId() === project.id) showMessage($('database-resource-message'), value);
      else transferMessage = { id: project.id, message: value };
    };
    message('Preparing backup…');
    renderPage();
    try {
      const response = await archiveRequest(project, 'backup', binding);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition'))?.[1] ?? 'database-backup.sfdb';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      message('Backup download started.');
    } catch (error) { message(error.message); }
    finally {
      state.pending = undefined;
      renderPage();
      refresh();
    }
  }

  async function loadDatabase(logs = false) {
    const view = databaseView;
    if (!view || view.loading || (!logs && Date.now() < view.next) || !$('project-database').open || $('project-database').hidden) return;
    view.loading = true;
    $('database-logs').disabled = true;
    $('database-compose-service').disabled = true;
    try {
      // Allow time for the Compose list, inspection, and optional log commands.
      const params = new URLSearchParams({ capabilities: 1 });
      if (logs) params.set('logs', '1');
      if (view.binding) params.set('binding', view.binding);
      const result = await request(`/api/projects/${view.id}/database?${params}`, { signal: AbortSignal.timeout(50_000) });
      Object.assign(view, { startHint: undefined, restoreHint: undefined, deleteHint: undefined, error: undefined, diagnostic: undefined }, result);
      if (view === databaseView && result.services?.length > 1) {
        const select = $('database-compose-service');
        select.replaceChildren(...result.services.map(service => new Option(`${service.name} · ${stackNames[service.engine]}`, service.id)));
        select.value = view.binding;
      }
      if (logs && result.log === undefined) view.log = '';
      if (!logs && result.status === 'absent') view.log = undefined;
    } catch (error) { Object.assign(view, { error: error.message, diagnostic: error.diagnostic }); }
    finally {
      view.loading = false;
      view.next = Date.now() + 3500;
      if (view === databaseView) renderPage();
    }
  }

  const discoveredEngines = { ...stackNames, sqlite: 'SQLite', sqlserver: 'SQL Server', mongodb: 'MongoDB', redis: 'Redis' };
  const resourceBinding = () => databaseDiscovery?.bindings?.find(item => item.id === $('database-resource').value);
  const discoveryStates = { configured: 'Configured target', unverified: 'Unverified target', missing: 'Missing configuration or file',
    placeholder: 'Template or placeholder', ambiguous: 'Ambiguous configuration', declared: 'Declared dependency' };

  function resetInitialization() {
    $('database-initialize-form').reset();
    $('database-initialization-plan').hidden = true;
    $('database-initialize-submit').disabled = true;
    if (databaseDiscovery) databaseDiscovery.plan = undefined;
  }

  function openDatabaseConnection(projectId, requirement) {
    if (state.pending || databaseDiscovery?.id !== projectId || databaseDiscovery.working) return;
    configuringDatabase = { projectId, requirement };
    const name = requirement.environmentEdit?.file ?? '.env';
    const file = requirement.directory === '.' ? name : `${requirement.directory}/${name}`;
    setText($('database-connection-title'), requirement.environmentEdit ? 'Edit database connection' : 'Configure database connection');
    setText($('database-connection-target'), `Save ${requirement.environmentVariable} in ${file}`);
    $('database-connection-form').reset();
    showMessage($('database-connection-message'), '');
    $('database-connection-dialog').showModal();
  }

  function renderDatabaseDiscovery(project, busy) {
    if (databaseDiscovery?.id !== project.id) {
      databaseDiscovery = { id: project.id };
      $('database-local-form').reset();
      $('database-local-form').hidden = true;
      $('database-local-help').hidden = true;
      setText($('database-local-status'), '');
      $('database-requirements').replaceChildren();
      showMessage($('database-discovery-message'), '');
      showMessage($('database-initialization-message'), '');
      $('database-resources').hidden = true;
      $('database-resource').replaceChildren();
      resetResource();
      resetInitialization();
      if ($('project-database-discovery').open) void loadDatabaseDiscovery();
    }
    const locked = busy || Boolean(databaseDiscovery.working);
    for (const button of $('database-requirements').querySelectorAll('button')) button.disabled = locked || ['starting', 'running', 'stopping'].includes(project.status);
    for (const control of ['database-local-check', 'database-local-preview', 'database-discovery-refresh']) $(control).disabled = locked;
    $('database-initialize-submit').disabled = locked || $('database-initialize-name').value !== databaseDiscovery.plan?.name;
    const binding = resourceBinding();
    const sqlite = binding?.instance.provider === 'sqlite';
    const remote = binding?.instance.provider === 'remote';
    const local = binding?.instance.provider === 'local';
    const status = databaseDiscovery.resourceStatus;
    const can = status?.capabilities ?? {};
    $('database-remote-form').hidden = !remote;
    $('database-remote-form').querySelector('button[type=submit]').disabled = locked;
    $('database-remote-test').disabled = locked || !binding?.profileSaved;
    $('database-remote-remove').disabled = locked || !binding?.profileSaved;
    $('database-sqlite-inspect').hidden = !sqlite;
    $('database-sqlite-inspect').disabled = locked;
    $('database-local-transfer').hidden = !local;
    $('database-local-transfer').disabled = locked;
    $('database-sqlite-create').hidden = !sqlite || !can.create;
    $('database-sqlite-create').disabled = locked;
    $('database-resource-backup').disabled = locked || !can.backup;
    $('database-resource-restore').disabled = locked || binding?.shared || !can.restore;
    $('database-sqlite-confirm-submit').disabled = locked || $('database-sqlite-path').value !== binding?.instance.path;
  }

  async function loadDatabaseDiscovery(savedRequirementId) {
    const view = databaseDiscovery;
    if (!view || view.working) return;
    view.working = true;
    resetInitialization();
    showMessage($('database-discovery-message'), 'Scanning database configuration…');
    try {
      const data = await request(`/api/projects/${view.id}/database-discovery`, { signal: AbortSignal.timeout(25_000) });
      if (view !== databaseDiscovery) return;
      view.bindings = data.bindings;
      const sources = new Map(data.bindings.map(item => [item.requirementId, item]));
      const requirements = data.requirements.map(item => {
        const row = document.createElement('li');
        const binding = sources.get(item.id);
        const target = [item.host && `${item.host}:${item.port}`, item.name, item.path].filter(Boolean).join(' / ');
        const verification = binding?.instance.verification?.status;
        const missingVariable = item.environmentFile ? `Environment variable ${item.environmentVariable} is missing from ${item.environmentFile}` :
          `Environment variable ${item.environmentVariable} is missing`;
        const status = verification === 'connected' ? 'Connection previously verified' : verification === 'missing' ? 'Database is missing' :
          item.status === 'missing' && item.environmentVariable ? missingVariable :
            discoveryStates[item.status] ?? 'Declared dependency';
        row.append([discoveredEngines[item.engine], item.source, target].filter(Boolean).join(' · '), ' · ');
        const label = document.createElement('span');
        setText(label, status);
        row.append(label);
        if (item.guidedSetup && ['missing', 'configured', 'placeholder'].includes(item.status)) {
          const setup = document.createElement('button');
          setup.type = 'button';
          setup.className = 'text-button database-connection-action';
          setText(setup, 'Set up PostgreSQL');
          setup.addEventListener('click', () => openPostgresSetup(view.id, selectedProject()?.name || 'project', item));
          row.append(setup);
        }
        if (binding?.shared) {
          const shared = document.createElement('span');
          setText(shared, 'Shared database');
          row.append(' · ', shared);
        }
        if (item.environmentEdit || (item.status === 'missing' && item.environmentVariable && ['postgres', 'mysql'].includes(item.engine))) {
          const action = document.createElement('button');
          action.type = 'button';
          action.className = 'text-button database-connection-action';
          setText(action, item.environmentEdit ? 'Edit database connection' : 'Configure database connection');
          action.addEventListener('click', () => openDatabaseConnection(view.id, item));
          row.append(action);
        }
        return row;
      });
      $('database-requirements').replaceChildren(...requirements);
      const local = [...new Map(data.bindings.filter(item => item.instance.provider === 'local' &&
        ['postgres', 'mysql'].includes(item.instance.engine)).map(item => [item.instanceId, item])).values()];
      const select = $('database-binding');
      select.replaceChildren(...local.map(({ id, server, instance, shared }) => {
        const label = `${discoveredEngines[instance.engine]} · ${server.host}:${server.port}/${instance.name}`;
        const option = new Option(label, id);
        if (shared) setText(option, `${label} · Shared database`);
        return option;
      }));
      const saved = sources.get(savedRequirementId);
      const matchingTarget = entries => entries.find(item => item.instanceId === saved?.instanceId)?.id;
      const localTarget = matchingTarget(local);
      if (localTarget) select.value = localTarget;
      $('database-local-form').hidden = !local.length;
      const managed = [...new Map(data.bindings.filter(item => ['sqlite', 'local'].includes(item.instance.provider) ||
        item.instance.provider === 'remote' && ['postgres', 'mysql'].includes(item.instance.engine))
        .map(item => [item.instanceId, item])).values()];
      const targets = $('database-resource');
      const previous = targets.value;
      targets.replaceChildren(...managed.map(item => new Option(item.instance.path ??
        `${discoveredEngines[item.instance.engine]} · ${item.server.host}:${item.server.port}/${item.instance.name}`, item.id)));
      const remoteTarget = matchingTarget(managed);
      if (remoteTarget) targets.value = remoteTarget;
      else if (managed.some(item => item.id === previous)) targets.value = previous;
      $('database-resources').hidden = !managed.length;
      if (targets.value !== previous) resetResource();
      showMessage($('database-discovery-message'), localTarget ? 'Database connection saved. Check the target or preview initialization below.' :
        remoteTarget ? 'Database connection saved. Configure the remote connection below.' :
        savedRequirementId ? 'Database connection saved.' : data.limited ? 'The scan reached its file limit.' :
        requirements.length ? '' : 'No database configuration was detected.');
      return data.requirements.find(item => item.id === savedRequirementId);
    } catch (error) {
      if (view === databaseDiscovery) showMessage($('database-discovery-message'), error.message);
    } finally {
      view.working = false;
      if (view === databaseDiscovery) renderPage();
    }
  }

  function resetResource() {
    if (databaseDiscovery) databaseDiscovery.resourceStatus = undefined;
    $('database-remote-form').reset();
    $('database-sqlite-confirm').reset();
    $('database-sqlite-confirm').hidden = true;
    $('database-resource-objects').replaceChildren();
    showMessage($('database-resource-message'), '');
  }

  async function resourceAction(action, mode) {
    const view = databaseDiscovery;
    const binding = resourceBinding();
    if (!binding || state.pending || view.working) return;
    view.working = true;
    renderPage();
    const payload = { bindingId: binding.id };
    if (mode) payload.mode = mode;
    if (mode === 'save') Object.assign(payload, { user: $('database-remote-user').value,
      password: $('database-remote-password').value, ca: $('database-remote-ca').value.trim() });
    if (action === 'database-sqlite-create') payload.confirmPath = $('database-sqlite-path').value;
    const current = () => view === databaseDiscovery && binding.id === resourceBinding()?.id;
    try {
      const { token } = await request('/api/state');
      let result = await post(`/api/projects/${view.id}/${action}`, token, payload, action === 'database-remote-profile' ? 70000 : 45000);
      if (action === 'database-sqlite-create') result = await post(`/api/projects/${view.id}/database-sqlite-inspect`, token, { bindingId: binding.id }, 45000);
      if (!current()) return;
      view.resourceStatus = result;
      if (typeof result.saved === 'boolean') binding.profileSaved = result.saved;
      $('database-sqlite-confirm').hidden = true;
      $('database-resource-objects').replaceChildren(...(result.details?.objects ?? []).map(item => {
        const row = document.createElement('li');
        row.textContent = `${item.type} · ${item.name}`;
        return row;
      }));
      if (action === 'database-local-status' || action === 'database-remote-profile' && mode !== 'remove') {
        showParts($('database-resource-message'), [
          action === 'database-local-status' ? 'Local connection verified' : 'Remote connection verified', result.version,
          result.capabilities.backup ? 'Backup allowed' : 'Backup unavailable',
          result.capabilities.restore ? 'Restore allowed' : 'Restore unavailable',
          action === 'database-remote-profile' && 'Provider management unavailable'
        ]);
      } else showMessage($('database-resource-message'), mode === 'remove' ? 'Remote connection profile removed.' :
        result.exists ? 'SQLite schema inspected.' : 'The SQLite file is missing.');
    } catch (error) {
      if (current()) { view.resourceStatus = undefined; showMessage($('database-resource-message'), error.message); }
    } finally {
      if (current()) $('database-remote-password').value = '';
      view.working = false;
      if (view === databaseDiscovery) renderPage();
    }
  }

  async function localDatabaseAction(action) {
    const view = databaseDiscovery;
    if (!view || view.working || state.pending) return;
    const binding = view.bindings?.find(item => item.id === $('database-binding').value);
    if (!binding) return;
    view.working = true;
    renderPage();
    try {
      const { token } = await request('/api/state');
      const data = { bindingId: binding.id };
      if (action !== 'database-local-check') Object.assign(data, {
        user: $('database-local-user').value, password: $('database-local-password').value, schema: $('database-local-schema').checked
      });
      if (action === 'database-initialize') {
        if (!view.plan || $('database-initialize-name').value !== view.plan.name) return;
        Object.assign(data, { planId: view.plan.id, confirmName: view.plan.name });
      }
      const result = await post(`/api/projects/${view.id}/${action}`, token, data, 120000);
      if (view !== databaseDiscovery) return;
      if (result.installation) {
        const { kind, clientVersion, serverVersion, serviceStatus, portOpen, help } = result.installation;
        const docker = kind === 'project-docker';
        showParts($('database-local-status'), [
          clientVersion ? docker ? `Container client version ${clientVersion}` : `Client version ${clientVersion}` :
            docker ? '' : 'Database client unavailable',
          serverVersion ? `Server version ${serverVersion}` : '',
          docker ? serviceStatus === 'running' ? 'Project PostgreSQL container running' : 'Project PostgreSQL container stopped' :
            { running: 'Local service running', stopped: 'Local service stopped', unknown: 'Local service status unknown' }[serviceStatus],
          portOpen ? 'Port reachable' : 'Port unavailable'
        ]);
        if (help) $('database-local-help').href = help;
        $('database-local-help').hidden = !help || Boolean(clientVersion && portOpen);
      } else if (action === 'database-initialization-plan') {
        resetInitialization();
        view.plan = { id: result.id, name: binding.instance.name };
        $('database-initialize-expected').textContent = binding.instance.name;
        showParts($('database-initialization-summary'), [
          result.verified ? `${discoveredEngines[binding.instance.engine]} ${result.version}` : 'Database server identity is unverified',
          result.exists ? result.empty ? 'Existing empty database' : 'Existing database with objects' : 'Database is missing',
          ...result.steps.map(step => step === 'create' ? 'Create database' : 'Initialize empty schema')
        ]);
        $('database-migration-preview').replaceChildren(...result.migrations.map(item => {
          const row = document.createElement('li');
          row.textContent = `${item.file} · ${item.table} (${item.columns.join(', ')})`;
          return row;
        }));
        $('database-initialization-plan').hidden = false;
        $('database-initialize-form').hidden = !result.steps.length || binding.shared;
      } else {
        resetInitialization();
        $('database-local-password').value = '';
        showMessage($('database-initialization-message'), result.schema === 'verified' ? 'Database schema verified.' : 'Database connection verified.');
      }
    } catch (error) {
      if (view === databaseDiscovery) showMessage($('database-initialization-message'), error.message);
    } finally {
      view.working = false;
      if (view === databaseDiscovery) renderPage();
    }
  }

  $('project-database').addEventListener('toggle', () => loadDatabase());
  $('project-database-discovery').addEventListener('toggle', event => {
    if (event.currentTarget.open) void loadDatabaseDiscovery();
    else { $('database-local-password').value = ''; $('database-remote-password').value = ''; resetInitialization(); }
  });
  $('database-discovery-refresh').addEventListener('click', () => loadDatabaseDiscovery());
  $('runtime-database-config').addEventListener('click', () => {
    const discovery = $('project-database-discovery');
    discovery.open = true;
    discovery.scrollIntoView({ block: 'start' });
    discovery.querySelector('summary').focus({ preventScroll: true });
  });
  $('database-connection-cancel').addEventListener('click', () => $('database-connection-dialog').close());
  $('database-connection-dialog').addEventListener('cancel', event => {
    if (state.pending?.action === 'database-connection-config') event.preventDefault();
  });
  $('database-connection-dialog').addEventListener('close', () => {
    $('database-connection-form').reset();
    configuringDatabase = undefined;
  });
  $('database-connection-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!configuringDatabase || state.pending) return;
    const { projectId, requirement } = configuringDatabase;
    const url = $('database-connection-url');
    state.pending = { id: projectId, action: 'database-connection-config' };
    for (const id of ['database-connection-save', 'database-connection-cancel', 'database-connection-url']) $(id).disabled = true;
    showMessage($('database-connection-message'), 'Saving database connection…');
    renderPage();
    try {
      const { token } = await request('/api/state');
      await post(`/api/projects/${projectId}/database-connection-config`, token, {
        requirementId: requirement.id, value: url.value, revision: requirement.environmentEdit?.revision
      }, 30_000);
      $('database-connection-dialog').close();
      if (databaseDiscovery?.id === projectId) await loadDatabaseDiscovery(requirement.id);
    } catch (error) { showMessage($('database-connection-message'), error.message); }
    finally {
      url.value = '';
      for (const id of ['database-connection-save', 'database-connection-cancel', 'database-connection-url']) $(id).disabled = false;
      if ($('database-connection-dialog').open) url.focus();
      state.pending = undefined;
      renderPage();
    }
  });
  $('database-local-check').addEventListener('click', () => localDatabaseAction('database-local-check'));
  $('database-local-form').addEventListener('input', resetInitialization);
  $('database-local-form').addEventListener('submit', event => {
    event.preventDefault();
    showMessage($('database-initialization-message'), '');
    void localDatabaseAction('database-initialization-plan');
  });
  $('database-initialize-name').addEventListener('input', renderPage);
  $('database-initialize-form').addEventListener('submit', event => {
    event.preventDefault();
    void localDatabaseAction('database-initialize');
  });
  $('database-resource').addEventListener('change', () => { resetResource(); renderPage(); });
  $('database-remote-form').addEventListener('submit', event => { event.preventDefault(); void resourceAction('database-remote-profile', 'save'); });
  $('database-remote-test').addEventListener('click', () => resourceAction('database-remote-profile', 'test'));
  $('database-remote-remove').addEventListener('click', () => resourceAction('database-remote-profile', 'remove'));
  $('database-sqlite-inspect').addEventListener('click', () => resourceAction('database-sqlite-inspect'));
  $('database-local-transfer').addEventListener('click', () => resourceAction('database-local-status'));
  $('database-sqlite-create').addEventListener('click', () => {
    const binding = resourceBinding();
    if (!binding || state.pending) return;
    $('database-sqlite-expected').textContent = binding.instance.path;
    $('database-sqlite-confirm').hidden = false;
    $('database-sqlite-path').focus();
  });
  $('database-sqlite-path').addEventListener('input', renderPage);
  $('database-sqlite-confirm').addEventListener('submit', event => { event.preventDefault(); void resourceAction('database-sqlite-create'); });
  $('database-resource-backup').addEventListener('click', () => backupAction(selectedProject(), resourceBinding()));
  $('database-resource-restore').addEventListener('click', () => openRestore(resourceBinding()));
  function composeBinding() {
    return databaseView?.id === selectedId() && databaseView?.services?.length > 1 ? { id: databaseView.binding, compose: true } : undefined;
  }
  $('database-compose-service').addEventListener('change', event => {
    Object.assign(databaseView, { binding: event.target.value, next: 0, status: undefined, log: undefined });
    transferMessage = undefined;
    renderPage();
    void loadDatabase();
  });
  $('database-start').addEventListener('click', () => act(selectedId(), 'database-start', { bindingId: composeBinding()?.id }));
  $('database-stop').addEventListener('click', () => act(selectedId(), 'database-stop', { bindingId: composeBinding()?.id }));
  $('database-logs').addEventListener('click', () => loadDatabase(true));
  $('database-backup').addEventListener('click', () => backupAction(selectedProject(), composeBinding()));
  function openRestore(binding) {
    const project = selectedProject();
    if (!project || state.pending) return;
    restoring = { project, binding };
    $('database-restore-form').reset();
    $('database-restore-name').required = false;
    $('database-restore-confirm-field').hidden = true;
    showMessage($('database-restore-preview'), '');
    setText($('database-restore-submit'), 'Preview restore');
    $('database-restore-submit').disabled = true;
    $('database-restore-dialog').showModal();
  }
  $('database-restore').addEventListener('click', () => openRestore(composeBinding()));
  $('database-restore-dialog').addEventListener('cancel', event => {
    if (state.pending?.action === 'database-restore') event.preventDefault();
  });
  function validRestore() {
    const file = $('database-restore-file').files[0];
    return file?.size > 0 && file.size <= 512 * 1024 * 1024 + 4096 && !state.pending &&
      (!restoring?.approval || $('database-restore-name').value === restoring.approval.name);
  }
  $('database-restore-file').addEventListener('change', () => {
    if (!restoring) return;
    restoring.approval = undefined;
    $('database-restore-name').required = false;
    $('database-restore-confirm-field').hidden = true;
    showMessage($('database-restore-preview'), '');
    setText($('database-restore-submit'), 'Preview restore');
    $('database-restore-submit').disabled = !validRestore();
  });
  $('database-restore-form').addEventListener('input', () => { $('database-restore-submit').disabled = !validRestore(); });
  $('database-restore-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!restoring || !validRestore()) return;
    const { project, binding, approval } = restoring;
    const file = $('database-restore-file').files[0];
    state.pending = { id: project.id, action: 'database-restore' };
    $('database-restore-submit').disabled = true;
    $('database-restore-file').disabled = true;
    $('database-restore-cancel').disabled = true;
    showMessage($('database-restore-preview'), approval ? 'Restoring database…' : 'Verifying backup in isolation…');
    renderPage();
    try {
      const response = await archiveRequest(project, approval ? 'restore' : 'preview', binding, file, approval);
      const result = await response.json();
      if (approval) {
        $('database-restore-dialog').close();
        if (binding && !binding.compose) showMessage($('database-resource-message'), 'Database restored and verified.');
        else transferMessage = { id: project.id, message: 'Database restored and verified.' };
        if (binding && databaseDiscovery) databaseDiscovery.resourceStatus = undefined;
      } else {
        restoring.approval = result;
        showParts($('database-restore-preview'), [
          result.name, `${discoveredEngines[result.metadata.engine]} ${result.metadata.version}`,
          `${result.objects}${result.limited ? '+' : ''} objects verified in isolation`,
          result.metadata.legacy ? 'Checksum calculated for this older backup' : '',
          `SHA-256 ${result.metadata.checksum}`
        ]);
        $('database-restore-expected').textContent = result.name;
        $('database-restore-name').value = '';
        $('database-restore-name').required = true;
        $('database-restore-confirm-field').hidden = false;
        setText($('database-restore-submit'), 'Restore backup');
        $('database-restore-name').focus();
      }
    } catch (error) { showMessage($('database-restore-preview'), error.message); }
    finally {
      state.pending = undefined;
      $('database-restore-file').disabled = false;
      $('database-restore-cancel').disabled = false;
      $('database-restore-submit').disabled = !validRestore();
      renderPage();
      refresh();
    }
  });
  $('database-restore-cancel').addEventListener('click', () => $('database-restore-dialog').close());
  $('database-delete').addEventListener('click', async () => {
    const id = selectedId();
    if (!id || state.pending) return;
    state.pending = { id, action: 'database-delete' };
    state.actionError = undefined;
    transferMessage = undefined;
    renderPage();
    try {
      const { volume } = await request(`/api/projects/${id}/database-delete`, { signal: AbortSignal.timeout(90_000) });
      if (id !== selectedId()) return;
      deletingDatabase = { id, volume };
      $('database-delete-form').reset();
      $('database-delete-expected').textContent = volume;
      $('database-delete-submit').disabled = true;
      $('database-delete-dialog').showModal();
    } catch (error) {
      state.actionError = { id, action: 'database-delete', message: error.message };
    } finally {
      state.pending = undefined;
      renderPage();
    }
  });
  $('database-delete-name').addEventListener('input', event => {
    $('database-delete-submit').disabled = event.target.value !== deletingDatabase?.volume;
  });
  $('database-delete-cancel').addEventListener('click', () => $('database-delete-dialog').close());
  $('database-delete-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!deletingDatabase || state.pending || $('database-delete-name').value !== deletingDatabase.volume) return;
    $('database-delete-dialog').close();
    act(deletingDatabase.id, 'database-delete', { confirmVolume: deletingDatabase.volume });
  });

  return {
    render(project, busy, unavailable) {
      if (project.offline) return;
      renderDatabase(project, busy, unavailable);
      renderDatabaseDiscovery(project, busy || unavailable);
    },
    refresh: loadDatabase,
    reloadDiscovery() { if ($('project-database-discovery').open) return loadDatabaseDiscovery(); },
    async openDetectedSetup(requirementId) {
      const project = selectedProject();
      if (!project) return;
      const { requirements } = await request('/api/projects/' + encodeURIComponent(project.id) + '/database-discovery',
        { signal: AbortSignal.timeout(25000) });
      if (selectedId() !== project.id) return;
      const requirement = requirements.find(item => item.id === requirementId && item.guidedSetup &&
        ['missing', 'configured', 'placeholder'].includes(item.status));
      if (!requirement) throw new Error('Database configuration changed. Run preflight again.');
      openPostgresSetup(project.id, project.name, requirement);
    },
    clearTransferMessage() { transferMessage = undefined; }
  };
}
