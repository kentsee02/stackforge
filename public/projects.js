import { setText, setupI18n, translate } from './i18n.js';

setupI18n();

const $ = id => document.getElementById(id);
const stateLabels = { stopped: '已停止', starting: '正在启动…', running: '运行中', stopping: '正在停止…', failed: '启动失败或异常退出' };
const stackNames = { vue: 'Vue', react: 'React', express: 'Express', nestjs: 'NestJS', spring: 'Spring Boot', mysql: 'MySQL', postgres: 'PostgreSQL' };
const removesFiles = project => !project.removeOnly;
const diagnosticMessages = {
  port: 'Free the occupied port, or choose a different one under Development ports if this project supports it.',
  java: 'Java is missing or incompatible. Set JAVA_HOME and PATH to the JDK version required by this project, then restart StackForge.',
  databaseUrl: 'DATABASE_URL is missing. Set it in the project’s environment file or shell, then retry.',
  databaseConnection: 'Prisma could not reach the database. Start the database and check the host and port in DATABASE_URL.',
  dotnetSdk: 'The .NET SDK is missing or incompatible. Check the project’s target framework and any global.json version pin.',
  lockfile: 'The dependency lockfile does not match the project. Update it with the project’s package manager, then retry.',
  pythonDependencies: 'Python could not import a module. Check the service’s virtual environment and install its dependencies.',
  toolMissing: 'A required command was not found. Check the tool named in the log and make sure it is on PATH.',
  docker: 'Start Docker Desktop or the Docker Engine, wait until it is ready, then start the project again.',
  database: 'Check the database startup output for Docker, port, or configuration errors, then try again.',
  dependencies: 'Use Install dependencies, then start the project again.',
  waiting: 'The process is still running. Check the log for progress, especially on a first build or database download.',
  waitingLink: 'The configured access URL has not responded successfully. Check its HTTP port and access path in Startup configuration.'
};
const rows = new Map();
let projects = [];
let selected;
let pending;
let confirming;
let restoring;
let deletingDatabase;
let transferMessage;
let importing = false;
let cloneRequest;
let actionError;
let portMessage;
let startupMessage;
let startupDetection;
let displayedStartupSuggestions;
let dependencyPlanView;
let databaseView;
let toolsView;
let timer;
let revision = 0;

async function request(url, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { diagnostic: data.diagnostic });
  return data;
}

function post(url, token, data, timeout = 5000) {
  return request(url, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(data) });
}

function showState(element, status) {
  if (element.dataset.state === status) return;
  element.dataset.state = status;
  setText(element, status === 'ready' ? '已就绪' : stateLabels[status]);
}

function showMessage(element, message = '') {
  if (element.dataset.message === message) return;
  element.dataset.message = message;
  setText(element, message);
}

function renderServices(project) {
  const custom = Object.values(project.services ?? {}).filter(service => service.name && service.ready);
  const readyCustom = custom.filter(service => service.kind !== 'api' || service.openUrl);
  const links = $('runtime-custom-links');
  const saved = JSON.stringify(readyCustom);
  if (links.dataset.saved !== saved) {
    links.dataset.saved = saved;
    links.replaceChildren(...readyCustom.map(service => {
      const link = document.createElement('a');
      Object.assign(link, { className: 'secondary', href: service.openUrl ?? service.url, target: '_blank', rel: 'noopener noreferrer', title: service.name });
      const label = service.kind === 'web' ? 'Open app' : service.kind === 'api' ? 'Open API' : undefined;
      if (label) setText(link, readyCustom.filter(item => item.kind === service.kind).length > 1 ? `${label} · ${service.name}` : label);
      else link.textContent = service.name;
      return link;
    }));
  }
  links.hidden = !readyCustom.length;
  $('runtime-api-path-hint').hidden = !custom.some(service => service.kind === 'api' && !service.openUrl);
  $('runtime-services').hidden = !Object.keys(project.services ?? {}).length;
  $('runtime-readiness').hidden = project.ready;
  for (const key of ['frontend', 'backend']) {
    const link = $('runtime-' + key);
    const service = project.services?.[key];
    link.hidden = !service?.ready;
    if (service?.ready) link.href = service.url;
    else link.removeAttribute('href');
  }
}

function startupDraft() {
  return [...$('project-startup-services').children].map(row => {
    const { name, directory, command, port, installCommand, kind, openPath } = Object.fromEntries([...row.querySelectorAll('input, select')].map(input => [input.name, input.value.trim()]));
    return { name, directory: directory.replaceAll('\\', '/') || '.', ...(command && { command }), ...(port && { port: Number(port) }), ...(installCommand && { installCommand }), ...(kind && { kind }), ...(openPath && { openPath }) };
  });
}

function addStartupService(service = {}) {
  const row = $('project-startup-service').content.firstElementChild.cloneNode(true);
  for (const element of row.querySelectorAll('[data-i18n]')) setText(element, element.dataset.i18n);
  for (const input of row.querySelectorAll('input, select')) {
    input.value = service[input.name] ?? '';
    if (input.dataset.i18nPlaceholder) input.placeholder = translate(input.dataset.i18nPlaceholder);
  }
  $('project-startup-services').append(row);
  return row;
}

function startupDirectoryKey(directory) {
  return (directory || '.').split('/').filter(part => part && part !== '.').join('/') || '.';
}

function matchingStartup(group, choice, draft) {
  const folder = startupDirectoryKey(group.directory);
  return draft.findIndex(service => startupDirectoryKey(service.directory) === folder && service.command === choice.command);
}

function missingLinkFields(service, choice, draft) {
  const port = !service.port && choice.port && !draft.some(item => item.port === choice.port) ? choice.port : undefined;
  const openPath = !service.openPath && choice.openPath;
  return { ...(port && { port }), ...(openPath && { openPath }) };
}

function startupSuggestionConflict(group, choice, draft) {
  const folder = startupDirectoryKey(group.directory);
  const existing = matchingStartup(group, choice, draft);
  if (existing !== -1) return Object.keys(missingLinkFields(draft[existing], choice, draft)).length ? undefined : 'Already in the configuration.';
  if (choice.orchestrates && draft.some(service => {
    const path = startupDirectoryKey(service.directory);
    return service.command && (folder === '.' || path === folder || path.startsWith(folder + '/'));
  })) return 'This workspace command overlaps an existing startup service.';
  if (draft.some(service => service.command && startupDirectoryKey(service.directory) === folder &&
      (!service.kind || !choice.kind || service.kind === choice.kind))) return 'A startup command is already configured for this folder. Edit it below to use another command.';
  if (draft.length >= 6) return 'Configure up to six startup services.';
}

function suggestionRow(group, id) {
  const row = $('startup-suggestion-row').content.firstElementChild.cloneNode(true);
  const title = row.querySelector('.startup-suggestion-title');
  title.querySelector('strong').textContent = group.name;
  const folder = title.querySelector('.small');
  if (group.directory === '.') setText(folder, 'Project root');
  else folder.textContent = group.directory;
  for (const element of row.querySelectorAll('[data-i18n]')) setText(element, element.dataset.i18n);
  const select = row.querySelector('select');
  select.parentElement.hidden = group.choices.length < 2;
  select.append(...group.choices.map((choice, index) => new Option(choice.script, String(index))));
  select.addEventListener('change', render);
  row.querySelector('button').addEventListener('click', () => {
    if (selected !== id) return;
    const draft = startupDraft();
    const choice = group.choices[Number(select.value)];
    if (startupSuggestionConflict(group, choice, draft)) return;
    const existing = matchingStartup(group, choice, draft);
    if (existing !== -1) {
      const service = draft[existing];
      const fields = missingLinkFields(service, choice, draft);
      if (!service.kind && choice.kind) fields.kind = choice.kind;
      const target = $('project-startup-services').children[existing];
      for (const [name, value] of Object.entries(fields)) target.querySelector(`[name="${name}"]`).value = value;
      startupMessage = { id, message: 'Missing link settings were added to the draft. Save to use them.' };
      render();
      target.querySelector('[name="port"]').focus();
      return;
    }
    const names = new Set(draft.map(service => service.name.toLowerCase()));
    let name = group.name;
    for (let count = 2; names.has(name.toLowerCase()); count++) name = group.name.slice(0, 35) + ' (' + count + ')';
    const portInUse = choice.port && draft.some(service => service.port === choice.port);
    const added = addStartupService({ name, directory: group.directory, command: choice.command, port: portInUse ? undefined : choice.port, kind: choice.kind, openPath: choice.openPath });
    startupMessage = { id, message: portInUse ? 'Suggestion added. Its port is already configured, so the port field was left blank.' : 'Suggestion added to the draft. Save to use it.' };
    render();
    added.querySelector('input').focus();
  });
  return row;
}

function renderStartupSuggestions(project, locked, draft) {
  const view = startupDetection?.id === project.id ? startupDetection : undefined;
  $('detect-startup').disabled = locked || Boolean(view?.loading);
  const status = $('startup-detection-status');
  const list = $('startup-suggestions');
  const data = view?.data;
  status.hidden = !view;
  status.classList.toggle('project-operation-error', Boolean(view?.error));
  if (view) showMessage(status, view.error ?? (view.loading ? 'Looking for startup commands…' : data.limited
    ? 'The scan limit was reached. Review these suggestions and add any remaining services manually.'
    : data.groups.length ? 'Choose a command and add it to the draft. Review and save before starting.'
    : 'No reliable startup commands were detected. Add a service manually.'));
  if (displayedStartupSuggestions !== data) {
    displayedStartupSuggestions = data;
    list.replaceChildren(...(data?.groups ?? []).map(group => suggestionRow(group, project.id)));
  }
  list.hidden = !data?.groups.length;
  for (const [index, row] of [...list.children].entries()) {
    const group = data.groups[index];
    const select = row.querySelector('select');
    const choice = group.choices[Number(select.value)];
    const conflict = startupSuggestionConflict(group, choice, draft);
    select.disabled = locked;
    const command = row.querySelector('.startup-suggestion-command');
    if (command.textContent !== choice.command) command.textContent = choice.command;
    const evidence = choice.source ?? `package.json · scripts.${choice.script}`;
    const kind = choice.kind === 'web' ? 'Web app' : choice.kind === 'api' ? 'API service' : '';
    const notes = [evidence, translate(kind), choice.orchestrates && translate('Workspace launcher'), choice.port && translate(`Port ${choice.port}`), choice.openPath && translate(`Path ${choice.openPath}`)].filter(Boolean);
    const source = row.querySelector('.startup-suggestion-source');
    if (source.textContent !== notes.join(' · ')) source.textContent = notes.join(' · ');
    const button = row.querySelector('button');
    setText(button, matchingStartup(group, choice, draft) !== -1 && !conflict ? 'Fill missing link settings' : 'Add to draft');
    button.disabled = locked || Boolean(conflict);
    const hint = row.querySelector('.startup-suggestion-conflict');
    hint.hidden = !conflict;
    showMessage(hint, conflict);
  }
}

async function detectStartup() {
  const project = projects.find(item => item.id === selected);
  if (!project?.unmanaged) return;
  const view = { id: project.id, loading: true };
  startupDetection = view;
  render();
  try {
    view.data = await request(`/api/projects/${project.id}/startup-suggestions`, { signal: AbortSignal.timeout(12000) });
  } catch (error) { view.error = error.message; }
  finally {
    view.loading = false;
    if (startupDetection === view && selected === view.id) render();
  }
}

function renderStartup(project, locked) {
  const panel = $('project-startup');
  const form = $('project-startup-form');
  const rows = $('project-startup-services');
  panel.hidden = !project.unmanaged;
  if (panel.hidden) return false;
  if (form.dataset.project !== project.id) {
    panel.open = !project.hasStartup;
    form.dataset.project = project.id;
    delete form.dataset.saved;
    rows.replaceChildren();
  }
  if (project.startupServices) {
    const saved = JSON.stringify(project.startupServices);
    if (form.dataset.saved !== saved) {
      form.dataset.saved = saved;
      rows.replaceChildren();
      project.startupServices.forEach(addStartupService);
    }
  }
  form.hidden = form.dataset.saved === undefined;
  const draft = startupDraft();
  const dirty = !form.hidden && JSON.stringify(draft) !== form.dataset.saved;
  renderStartupSuggestions(project, locked, draft);
  for (const [index, row] of [...rows.children].entries()) {
    setText(row.querySelector('legend'), `Service ${index + 1}`);
    row.disabled = locked;
  }
  $('project-startup-empty').hidden = Boolean(rows.childElementCount);
  $('project-startup-hint').hidden = !rows.childElementCount;
  $('project-startup-link-hint').hidden = !rows.childElementCount;
  $('project-startup-add').disabled = locked || rows.childElementCount >= 6;
  $('project-startup-save').disabled = locked || !dirty;
  const message = startupMessage?.id === project.id ? startupMessage : undefined;
  const saving = pending?.id === project.id && pending.action === 'startup';
  const feedback = $('project-startup-message');
  feedback.classList.toggle('project-operation-error', Boolean(message?.error) && !saving);
  showMessage(feedback, saving ? 'Saving startup configuration…' : message?.message || (dirty ? 'Save configuration changes before running commands.' : ''));
  return dirty;
}

function renderPorts(project, busy) {
  const details = $('project-ports');
  const form = $('project-port-form');
  details.hidden = project.unmanaged || !project.portDefaults;
  if (details.hidden) return;
  $('project-ports-legacy').hidden = project.canConfigurePorts;
  form.hidden = !project.canConfigurePorts;
  const saved = JSON.stringify(project.ports);
  const changed = form.dataset.project !== project.id || form.dataset.saved !== saved;
  for (const field of form.querySelectorAll('input')) {
    field.parentElement.hidden = !Object.hasOwn(project.portDefaults, field.name);
    field.placeholder = project.portDefaults[field.name] ?? '';
    field.disabled = busy;
    if (changed) field.value = project.ports[field.name] ?? '';
  }
  form.dataset.project = project.id;
  form.dataset.saved = saved;
  form.querySelector('button').disabled = busy;
  const hint = $('project-ports-hint');
  if (hint.dataset.busy !== String(busy)) {
    hint.dataset.busy = String(busy);
    setText(hint, busy ? 'Stop the project before changing its ports.' : 'Leave fields blank to use project defaults. Changes apply on the next start.');
  }
  showMessage($('project-port-message'), portMessage?.id === project.id ? portMessage.message : '');
}

function renderOutput(output, id, log = '') {
  const follow = output.dataset.project !== id || output.scrollHeight - output.scrollTop - output.clientHeight < 32;
  output.dataset.project = id;
  if (output.textContent !== log) {
    output.textContent = log;
    if (follow) output.scrollTop = output.scrollHeight;
  }
}

function renderDependencies(project, busy, unavailable, startupDirty) {
  const task = project.dependencies;
  const installing = project.operation === 'dependencies' || (pending?.id === project.id && pending.action === 'install');
  const view = dependencyPlanView?.id === project.id ? dependencyPlanView : undefined;
  const automatic = Boolean(view?.data?.steps.length);
  const canInstall = !project.unmanaged || automatic || project.hasInstallCommands;
  renderDependencyPlan(project, view);
  const hint = $('dependency-config-hint');
  hint.hidden = !project.unmanaged || (automatic && !startupDirty && !project.hasInstallCommands);
  if (project.unmanaged) showMessage(hint, startupDirty ? 'Save configuration changes before installing dependencies.' : project.hasInstallCommands
    ? 'Saved install commands run in order. Services without an install command are skipped.'
    : 'Add an install command under Startup configuration if this project needs one.');
  const phases = { npm: 'Installing npm dependencies…', maven: 'Downloading Maven dependencies…', custom: 'Running install commands…', detected: 'Installing detected dependencies…' };
  const results = { succeeded: 'Dependencies installed.', failed: 'Installation failed.', cancelled: 'Installation cancelled.' };
  let status = results[task?.status] ?? (busy ? 'Stop the project before installing dependencies.' : '');
  if (installing) status = task?.status === 'cancelling' ? 'Cancelling installation…' : phases[task?.phase] ?? 'Preparing installation…';
  showMessage($('dependency-status'), status);
  const install = $('install-dependencies');
  showMessage(install, automatic ? 'Install detected dependencies' : project.unmanaged ? 'Run custom install' : 'Install dependencies');
  install.hidden = installing || !canInstall;
  install.disabled = busy || unavailable || startupDirty;
  const custom = $('install-custom-dependencies');
  custom.hidden = !project.unmanaged || !automatic || !project.hasInstallCommands || installing;
  custom.disabled = install.disabled;
  $('refresh-dependencies').hidden = !project.unmanaged || installing;
  $('refresh-dependencies').disabled = Boolean(view?.loading);
  $('cancel-install').hidden = !installing;
  $('cancel-install').disabled = Boolean(pending) || task?.status === 'cancelling';
  const installError = actionError?.id === project.id && actionError.action?.startsWith('install') ? actionError : undefined;
  const issue = installError ? installError.diagnostic : task?.diagnostic;
  const hintText = issue === 'dependencies' ? 'An installation script could not find a dependency. Check the failing script and package in the installation log.' : diagnosticMessages[issue];
  const error = hintText ?? installError?.message ?? task?.error;
  showMessage($('dependency-error'), error);
  $('dependency-error').hidden = !error;
  const details = $('dependency-log');
  if (details.dataset.project !== project.id) details.open = false;
  details.dataset.project = project.id;
  details.hidden = !task?.log;
  renderOutput($('dependency-output'), project.id, task?.log);
}

function renderDependencyPlan(project, view) {
  $('dependency-plan').hidden = !project.unmanaged;
  if (!project.unmanaged) return;
  const steps = $('dependency-steps');
  const issues = $('dependency-issues');
  const plan = view?.data;
  const key = plan?.id ?? '';
  if (steps.dataset.plan !== key) {
    steps.dataset.plan = key;
    steps.replaceChildren(...(plan?.steps ?? []).map(step => {
      const row = document.createElement('li');
      const command = document.createElement('code');
      const source = document.createElement('small');
      const folder = document.createElement('span');
      command.textContent = step.command;
      if (step.directory === '.') setText(folder, 'Project root');
      else folder.textContent = step.directory;
      source.append(folder, ' · ', step.evidence);
      row.append(command, source);
      return row;
    }));
    issues.replaceChildren(...(plan?.issues ?? []).map(issue => {
      const row = document.createElement('li');
      const folder = document.createElement('span');
      const message = document.createElement('span');
      if (issue.directory === '.') setText(folder, 'Project root');
      else folder.textContent = issue.directory;
      setText(message, issue.message);
      row.append(folder, ' · ', message);
      return row;
    }));
  }
  steps.hidden = !plan?.steps.length;
  issues.hidden = !plan?.issues.length;
  showMessage($('dependency-detection'), view?.error ?? (view?.loading || !view
    ? 'Detecting dependency files…'
    : plan.steps.length ? 'Review these commands and folders before installing. Install commands can run project scripts.'
    : 'No reliable install commands were detected.'));
}

async function loadDependencyPlan(force = false) {
  const project = projects.find(item => item.id === selected);
  if (!project?.unmanaged || !project.startupServices) return;
  const key = JSON.stringify(project.startupServices);
  if (dependencyPlanView?.id === project.id && dependencyPlanView.key === key && (!force || dependencyPlanView.loading)) return;
  const view = { id: project.id, key, loading: true };
  dependencyPlanView = view;
  render();
  try {
    view.data = await request(`/api/projects/${project.id}/dependencies`, { signal: AbortSignal.timeout(12000) });
  } catch (error) {
    view.error = error.message;
  } finally {
    view.loading = false;
    if (dependencyPlanView === view && selected === view.id) render();
  }
}

const databaseLabels = { absent: 'Database not created', stopped: '已停止', running: '运行中', starting: '正在启动…', stopping: '正在停止…', restarting: 'Restarting…', unhealthy: 'Health check failed', paused: 'Paused' };

function renderDatabase(project, busy, unavailable) {
  const details = $('project-database');
  details.hidden = project.database === 'none' && !project.hasComposeDatabase;
  if (databaseView?.id !== project.id) databaseView = { id: project.id, next: 0 };
  const view = databaseView;
  const task = project.databaseTask;
  if (view.taskStatus !== task?.status) view.next = 0;
  view.taskStatus = task?.status;
  const changing = project.operation === 'databaseTask';
  const state = changing && task?.phase !== 'database-delete' ? (task?.phase === 'database-stop' ? 'stopping' : 'starting') : view.status;
  $('database-engine').textContent = stackNames[view.engine ?? project.database] ?? '';
  showMessage($('database-status'), databaseLabels[state] ?? (view.error ? 'Database status unavailable' : 'Checking database…'));
  const transitioning = project.unmanaged ? ['starting', 'stopping'].includes(project.status) : busy && !project.initialized;
  const disabled = unavailable || transitioning || !view.status || Boolean(view.error);
  $('database-start').disabled = disabled || ['running', 'starting', 'restarting', 'paused'].includes(state);
  $('database-stop').disabled = disabled || ['absent', 'stopped'].includes(state);
  $('database-logs').disabled = view.loading || !view.status || state === 'absent' || Boolean(view.error);
  $('database-backup').disabled = unavailable || Boolean(view.error) || state !== 'running';
  $('database-restore').disabled = unavailable || busy || Boolean(view.error) || state !== 'running';
  const deleteVolume = $('database-delete');
  deleteVolume.hidden = project.unmanaged || project.database === 'none';
  deleteVolume.disabled = disabled || busy || !['absent', 'stopped'].includes(state);
  const transfer = transferMessage?.id === project.id ? transferMessage.message :
    task?.phase === 'database-delete' && task.status === 'succeeded' ? 'Database data volume deleted.' : '';
  showMessage($('database-transfer-message'), transfer);
  $('database-transfer-message').hidden = !transfer;
  const issue = task?.diagnostic ?? view.diagnostic;
  const hint = issue === 'docker' ? 'Start Docker Desktop or the Docker Engine to manage the database.' : diagnosticMessages[issue];
  const error = actionError?.id === project.id && actionError.action?.startsWith('database-') ? actionError.message : hint ?? task?.error ?? view.error;
  showMessage($('database-error'), error);
  $('database-error').hidden = !error;
  $('database-transition').hidden = !transitioning || Boolean(error);
  $('database-output').hidden = !task?.log || task.status === 'succeeded';
  renderOutput($('database-output'), project.id, task?.log);
  $('database-log-empty').hidden = view.log !== '';
  $('database-container-log').hidden = !view.log;
  renderOutput($('database-container-log'), project.id, view.log);
}

async function backupAction(project, file) {
  if (!project || pending) return;
  pending = { id: project.id, action: file ? 'database-restore' : 'database-backup' };
  transferMessage = { id: project.id, message: file ? 'Restoring database…' : 'Preparing backup…' };
  render();
  try {
    const { token } = await request('/api/state');
    const response = await fetch(`/api/projects/${project.id}/${pending.action}`, {
      method: 'POST', signal: AbortSignal.timeout(660_000),
      headers: { 'X-StackForge-Token': token, 'Content-Type': file ? 'application/octet-stream' : 'application/json',
        ...(file && { 'X-StackForge-Confirm-Name': project.name }) },
      body: file ?? '{}'
    });
    if (!response.ok) throw new Error((await response.json()).error);
    if (!file) {
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition'))?.[1] ?? 'database-backup';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    transferMessage.message = file ? 'Database restored.' : 'Backup download started.';
  } catch (error) { transferMessage.message = error.message; }
  finally {
    pending = undefined;
    render();
    refresh();
  }
}

async function loadDatabase(logs = false) {
  const view = databaseView;
  if (!view || view.loading || (!logs && Date.now() < view.next) || !$('project-database').open || $('project-database').hidden) return;
  view.loading = true;
  $('database-logs').disabled = true;
  try {
    // Allow time for the Compose list, inspection, and optional log commands.
    const state = await request(`/api/projects/${view.id}/database${logs ? '?logs=1' : ''}`, { signal: AbortSignal.timeout(50_000) });
    Object.assign(view, state, { error: undefined, diagnostic: undefined });
    if (logs && state.log === undefined) view.log = '';
    if (!logs && state.status === 'absent') view.log = undefined;
  } catch (error) { Object.assign(view, { error: error.message, diagnostic: error.diagnostic }); }
  finally {
    view.loading = false;
    view.next = Date.now() + 3500;
    if (view === databaseView) render();
  }
}

const checkStates = { running: 'Check running…', cancelling: 'Cancelling check…', succeeded: 'Check passed', failed: 'Check failed', cancelled: 'Check cancelled' };
const checkScopes = { root: 'Project · {command}', frontend: 'Frontend · {command}', backend: 'Backend · {command}', maven: 'Backend · {command}' };
const checkTypes = { build: 'Build', test: 'Test', lint: 'Lint' };
let checkConfigMessage;

function checkLabel(id, check) {
  const parts = id.split(':');
  const scope = parts[0], name = parts.at(-1);
  const command = check?.command ?? (scope === 'maven' ? `Maven Wrapper ${name}` : `npm run ${name}`);
  if (scope === 'custom') return check ? `${check.directory} · Custom ${checkTypes[check.name]} · ${command}` : checkTypes[name];
  if (scope === 'service' || scope === 'tool') return check ? `${check.directory} · ${command}` : checkTypes[name];
  return checkScopes[scope].replace('{command}', command);
}

function checkDraft() {
  return [...$('check-config-rows').children].map(row => ({
    name: row.querySelector('[name="name"]').value,
    directory: row.querySelector('[name="directory"]').value.trim().replaceAll('\\', '/') || '.',
    command: row.querySelector('[name="command"]').value.trim()
  }));
}

function addCheckRow(check = { name: 'build', directory: '.', command: '' }) {
  const row = $('check-config-row').content.firstElementChild.cloneNode(true);
  for (const element of row.querySelectorAll('[data-i18n]')) setText(element, element.dataset.i18n);
  for (const field of row.querySelectorAll('input, select')) field.value = check[field.name];
  $('check-config-rows').append(row);
  return row;
}

function renderCheckConfig(project, locked, data) {
  const rows = $('check-config-rows');
  if (rows.dataset.project !== project.id) {
    rows.dataset.project = project.id;
    delete rows.dataset.saved;
    rows.replaceChildren();
    $('check-config-editor').open = false;
  }
  if (data && rows.dataset.saved === undefined) {
    rows.dataset.saved = JSON.stringify(data.customChecks);
    data.customChecks.forEach(addCheckRow);
  }
  const ready = rows.dataset.saved !== undefined;
  $('check-config-editor').hidden = !ready;
  for (const row of rows.children) row.disabled = locked;
  $('check-config-add').disabled = locked || rows.childElementCount >= 12;
  $('check-config-save').disabled = locked || !ready || JSON.stringify(checkDraft()) === rows.dataset.saved;
  const feedback = checkConfigMessage?.id === project.id ? checkConfigMessage : undefined;
  const message = $('check-config-message');
  message.classList.toggle('project-operation-error', Boolean(feedback?.error));
  showMessage(message, feedback?.message ?? '');
}

function renderChecks(project, busy, unavailable) {
  const view = toolsView.checks;
  const task = project.checkTask;
  const launching = pending?.id === project.id && pending.action === 'run-check';
  const status = launching ? 'running' : task?.status;
  const active = project.operation === 'checkTask' || launching;
  const loaded = Boolean(view.data?.checks.length);
  const statusLabel = $('check-status');
  statusLabel.dataset.status = status ?? '';
  showMessage(statusLabel, active ? checkStates[status] ?? checkStates.running : checkStates[status]);
  $('check-form').hidden = !loaded && !active;
  $('check-command').disabled = unavailable || view.loading || !loaded;
  $('run-check').disabled = busy || unavailable || view.loading || !loaded;
  $('run-check').hidden = active;
  $('check-cancel').hidden = !active;
  $('check-cancel').disabled = Boolean(pending) || status === 'cancelling';
  showMessage($('check-message'), view.loading ? 'Reading available checks…' : view.data && !loaded ? 'No build, test, or lint commands were found.' : loaded && busy ? 'Stop the project before running checks.' : '');
  const error = actionError?.id === project.id && ['run-check', 'check-cancel'].includes(actionError.action) ? actionError.message : view.error ?? task?.error;
  showMessage($('check-error'), error);
  $('check-error').hidden = !error;
  $('check-last').hidden = !task?.phase;
  const lastCheck = view.data?.checks.find(check => check.id === task?.phase);
  showMessage($('check-last-command'), task?.phase ? checkLabel(task.phase, lastCheck) : '');
  $('check-output').hidden = !task?.log;
  renderOutput($('check-output'), project.id, task?.log);
  renderCheckConfig(project, unavailable || view.loading, view.data);
}

function renderGit() {
  const { data, loading, error } = toolsView.git;
  const available = data?.status === 'available' && !error;
  $('git-summary').hidden = !available;
  $('git-initial').hidden = !available || !data.initial;
  $('git-refresh').disabled = Boolean(loading);
  showMessage($('git-message'), loading ? 'Reading Git status…' : error ?? (data?.status === 'absent' ? 'This project has no local Git repository.' : ''));
  if (!available) return;
  $('git-branch').textContent = data.branch ?? '';
  $('git-branch').hidden = !data.branch;
  $('git-detached').hidden = Boolean(data.branch);
  showMessage($('git-changes'), data.changes === 0 ? 'Clean' : data.changes === 1 ? '1 change' : `${data.changes} changes`);
  $('git-upstream').textContent = data.upstream ?? '';
  $('git-upstream').hidden = !data.upstream;
  $('git-no-upstream').hidden = Boolean(data.upstream);
  $('git-comparison').hidden = !data.upstream;
  showMessage($('git-comparison'), data.ahead === null ? 'Local comparison unavailable' : `${data.ahead} ahead · ${data.behind} behind`);
}

async function loadProjectTool(tool, reload = false) {
  const current = toolsView;
  const view = current?.[tool];
  if (!view || current.id !== selected || !$('project-' + tool).open || view.loading || (!reload && (view.data || view.error))) return;
  view.loading = true;
  render();
  try {
    view.data = await request(`/api/projects/${current.id}/${tool}`, { signal: AbortSignal.timeout(12000) });
    view.error = undefined;
    if (tool === 'checks' && current === toolsView) {
      const field = $('check-command');
      const previous = field.value;
      field.replaceChildren(...view.data.checks.map(check => {
        const option = document.createElement('option');
        option.value = check.id;
        setText(option, checkLabel(check.id, check));
        return option;
      }));
      if (view.data.checks.some(check => check.id === previous)) field.value = previous;
    }
  } catch (error) {
    view.data = undefined;
    view.error = error.message;
  } finally {
    view.loading = false;
    if (current === toolsView) render();
  }
}

function renderRows() {
  const filter = $('project-search').value.trim().toLowerCase();
  const list = $('project-list');
  for (const [id, row] of rows) if (!projects.some(project => project.id === id)) { row.remove(); rows.delete(id); }
  let matches = 0;
  for (const [index, project] of projects.entries()) {
    let row = rows.get(project.id);
    if (!row) {
      row = $('project-row').content.firstElementChild.cloneNode(true);
      row.querySelector('strong').textContent = project.name;
      const frameworks = project.unmanaged ? project.frameworks : [project.frontend, project.backend, project.database].map(key => stackNames[key]).filter(Boolean);
      setText(row.querySelector('small'), frameworks.join(' / ') || 'External project');
      row.firstElementChild.addEventListener('click', () => {
        if (selected !== project.id) actionError = undefined;
        selected = project.id;
        render();
        refresh();
        if (matchMedia('(max-width: 800px)').matches) {
          $('selected-project-name').focus({ preventScroll: true });
          $('project-detail').scrollIntoView({ block: 'start' });
        }
      });
      rows.set(project.id, row);
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    row.hidden = !project.name.toLowerCase().includes(filter) && !project.path.toLowerCase().includes(filter);
    if (!row.hidden) matches++;
    row.firstElementChild.setAttribute('aria-pressed', String(project.id === selected));
    const status = row.querySelector('.runtime-state');
    status.hidden = Boolean(project.unmanaged && !project.hasStartup);
    showState(status, project.ready ? 'ready' : project.status);
  }
  $('project-no-match').hidden = matches > 0;
}

function render() {
  if ($('project-trash-dialog').open) {
    $('project-trash-confirm').disabled = Boolean(pending) || $('project-trash-name').value !== confirming?.name;
  }
  $('project-manager').hidden = !projects.length;
  $('project-empty').hidden = projects.length > 0;
  renderRows();
  const project = projects.find(item => item.id === selected);
  if (!project) return;
  for (const id of ['runtime-action', 'selected-project-state', 'project-runtime-log']) $(id).hidden = Boolean(project.unmanaged && !project.hasStartup);
  if ($('selected-project-name').textContent !== project.name) $('selected-project-name').textContent = project.name;
  if ($('selected-project-path').textContent !== project.path) $('selected-project-path').textContent = project.path;
  showState($('selected-project-state'), project.ready ? 'ready' : project.status);
  renderServices(project);
  const running = project.status === 'running' || project.status === 'starting';
  const busy = running || project.status === 'stopping';
  const deleting = project.deleting || (pending?.id === project.id && pending.action === 'trash');
  const unavailable = deleting || Boolean(pending) || Boolean(project.operation);
  const startupDirty = renderStartup(project, busy || unavailable);
  renderPorts(project, busy || unavailable);
  renderDependencies(project, busy, unavailable, startupDirty);
  renderDatabase(project, busy, unavailable);
  if (toolsView?.id !== project.id) {
    toolsView = { id: project.id, checks: {}, git: {} };
    $('check-command').replaceChildren();
  }
  renderChecks(project, busy, unavailable);
  renderGit();
  const action = $('runtime-action');
  action.dataset.action = running ? 'stop' : 'start';
  action.className = running || project.status === 'stopping' ? 'secondary' : 'primary';
  action.disabled = Boolean(pending) || deleting || project.status === 'stopping' || (!running && (Boolean(project.operation) || startupDirty));
  setText(action.firstElementChild, project.status === 'stopping' ? 'Stopping…' : running ? 'Stop project' : 'Start project');
  const devError = actionError?.id === project.id && ['start', 'stop'].includes(actionError.action) ? actionError : undefined;
  const error = devError?.message ?? project.error;
  $('runtime-error').hidden = !error;
  showMessage($('runtime-error'), error);
  const issue = devError ? devError.diagnostic : project.diagnostic;
  const diagnostic = issue === 'dependencies' && project.unmanaged && !project.hasInstallCommands
    ? 'Add an install command under Startup configuration if this project needs one.'
    : issue === 'dependencies' && project.dependencies?.status === 'succeeded' ? undefined : diagnosticMessages[issue];
  const diagnosticField = $('runtime-diagnostic');
  showMessage(diagnosticField, diagnostic);
  diagnosticField.hidden = !diagnostic;
  $('project-delete').disabled = busy || unavailable;
  $('project-remove').hidden = !project.imported || !removesFiles(project);
  $('project-remove').disabled = busy || unavailable;
  setText($('project-delete').querySelector('span'), removesFiles(project) ? 'Delete project' : 'Remove from Projects');
  $('project-delete-hint').hidden = !busy && !deleting && !project.operation;
  setText($('project-delete-hint'), deleting ? 'Moving to trash…' : project.operation ? 'Wait for the current project operation to finish.' : 'Stop the project first.');
  const output = $('runtime-output');
  const log = project.log ?? '';
  output.hidden = !log;
  $('runtime-log-empty').hidden = Boolean(log);
  $('runtime-log-truncated').hidden = !project.truncated;
  renderOutput(output, project.id, log);
}

async function refresh() {
  clearTimeout(timer);
  const version = ++revision;
  const requested = selected;
  try {
    const data = await request('/api/projects' + (requested ? `?logs=${encodeURIComponent(requested)}` : ''));
    if (version !== revision) return;
    projects = data.projects;
    if (!projects.some(item => item.id === selected)) selected = projects[0]?.id;
    $('project-connection').hidden = true;
    render();
    if (selected && selected !== requested) { refresh(); return; }
    loadDatabase();
    loadDependencyPlan();
    loadProjectTool('checks');
    loadProjectTool('git');
  } catch {
    if (version !== revision) return;
    $('project-connection').hidden = false;
    setText($('project-connection'), 'Cannot reach StackForge. Reconnecting…');
  } finally {
    if (version === revision && !document.hidden) timer = setTimeout(refresh, 1200);
  }
}

async function act(id, action, body = {}) {
  if (!id || pending) return;
  const removing = action === 'trash' || action === 'remove';
  pending = { id, action };
  actionError = undefined;
  $('project-feedback').dataset.status = 'ok';
  setText($('project-feedback'), '');
  render();
  try {
    const { token } = await request('/api/state');
    const runtime = await post(`/api/projects/${id}/${action}`, token, body, action === 'trash' ? 180_000 : 5000);
    if (removing) {
      projects = projects.filter(item => item.id !== id);
      if (selected === id) selected = projects[0]?.id;
      setText($('project-feedback'), runtime.removed ? 'Project removed from Projects.' : 'Project moved to the system trash.');
    } else if (action === 'ports') {
      const project = projects.find(item => item.id === id);
      if (project) project.ports = runtime.ports;
      portMessage = { id, message: 'Development ports saved.' };
    } else if (action === 'startup') {
      const project = projects.find(item => item.id === id);
      if (project) Object.assign(project, { startupServices: runtime.services,
        hasStartup: runtime.services.some(service => service.command),
        hasInstallCommands: runtime.services.some(service => service.installCommand) });
      if (toolsView?.id === id) toolsView = { ...toolsView, checks: {} };
      startupMessage = { id, message: 'Startup configuration saved.' };
    } else if (action === 'check-config') {
      if (toolsView?.id === id) {
        $('check-config-rows').dataset.saved = JSON.stringify(runtime.commands);
        toolsView = { ...toolsView, checks: {} };
      }
      checkConfigMessage = { id, message: 'Custom check commands saved.' };
    } else if (['install', 'install-cancel', 'database-start', 'database-stop', 'database-delete', 'run-check', 'check-cancel'].includes(action)) {
      const project = projects.find(item => item.id === id);
      if (project) Object.assign(project, runtime);
    } else {
      const project = projects.find(item => item.id === id);
      if (project) Object.assign(project, { status: runtime.status, error: runtime.error, services: runtime.services, ready: runtime.ready, initialized: runtime.initialized, diagnostic: runtime.diagnostic });
    }
  } catch (error) {
    if (removing) {
      $('project-feedback').dataset.status = 'error';
      setText($('project-feedback'), error.message);
    } else if (action === 'ports') portMessage = { id, message: error.message };
    else if (action === 'startup') startupMessage = { id, message: error.message, error: true };
    else if (action === 'check-config') checkConfigMessage = { id, message: error.message, error: true };
    else actionError = { id, action, message: error.message, diagnostic: error.diagnostic };
  }
  finally {
    pending = undefined;
    render();
    if (removing) $('project-feedback').focus();
    refresh();
  }
}

function showImport(open) {
  $('project-import').hidden = !open;
  $('project-import-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    $('project-import-path').focus();
    request('/api/state').then(({ defaultDir }) => { $('project-clone-parent').value ||= defaultDir; }).catch(() => {});
  }
}

async function importAction(browse, clone = false) {
  if (importing) return;
  importing = true;
  const path = $(clone ? 'project-clone-parent' : 'project-import-path');
  const controls = ['project-import-toggle', 'project-import-browse', 'project-import-submit', 'project-clone-browse', 'project-clone-submit'].map($);
  for (const control of controls) control.disabled = true;
  path.readOnly = true;
  const repository = $('project-clone-url');
  const cancel = $('project-clone-cancel');
  if (clone) repository.readOnly = true;
  const message = $(clone ? 'project-clone-message' : 'project-import-message');
  setText(message, browse ? 'Choose a folder in the system dialog.' : clone ? 'Cloning repository…' : 'Adding project…');
  try {
    const { token, defaultDir } = await request('/api/state');
    if (browse) {
      const result = await post('/api/desktop/pick-directory', token, { initialDir: path.value.trim() || defaultDir, language: document.documentElement.lang }, 610000);
      if (result.path) path.value = result.path;
      setText(message, result.path ? 'Folder selected.' : 'Folder selection cancelled.');
    } else {
      let project;
      if (clone) {
        const requestId = crypto.randomUUID();
        cloneRequest = { requestId, token };
        cancel.hidden = false;
        project = await post('/api/projects/clone', token, { repository: repository.value.trim(), parentDir: path.value.trim(), requestId }, 190000);
      } else {
        project = await post('/api/projects/import', token, { path: path.value.trim() });
      }
      selected = project.id;
      projects = [{ ...project, status: 'stopped' }, ...projects.filter(item => item.id !== project.id)];
      $('project-search').value = '';
      if (clone) repository.value = '';
      else path.value = '';
      showImport(false);
      setText(message, '');
      $('project-feedback').dataset.status = 'ok';
      setText($('project-feedback'), 'Project added to Projects.');
      render();
      $('project-feedback').focus();
      refresh();
    }
  } catch (error) { setText(message, error.message); }
  finally {
    importing = false;
    for (const control of controls) control.disabled = false;
    path.readOnly = false;
    if (clone) {
      cloneRequest = undefined;
      cancel.hidden = true;
      cancel.disabled = false;
      repository.readOnly = false;
    }
  }
}

$('project-search').addEventListener('input', renderRows);
$('project-import-toggle').addEventListener('click', () => showImport($('project-import').hidden));
$('project-import-browse').addEventListener('click', () => importAction(true));
$('project-import-form').addEventListener('submit', event => { event.preventDefault(); importAction(false); });
$('project-clone-browse').addEventListener('click', () => importAction(true, true));
$('project-clone-form').addEventListener('submit', event => { event.preventDefault(); importAction(false, true); });
$('project-clone-cancel').addEventListener('click', async event => {
  const cancel = event.currentTarget;
  const current = cloneRequest;
  if (!current || cancel.disabled) return;
  const message = $('project-clone-message');
  cancel.disabled = true;
  setText(message, 'Cancelling clone…');
  try {
    await post('/api/projects/clone-cancel', current.token, { requestId: current.requestId });
  } catch (error) {
    if (cloneRequest === current) {
      setText(message, error.message);
      cancel.disabled = false;
    }
  }
});
$('project-port-form').addEventListener('submit', event => {
  event.preventDefault();
  const ports = {};
  for (const field of event.currentTarget.querySelectorAll('input')) if (!field.parentElement.hidden && field.value) ports[field.name] = field.valueAsNumber;
  portMessage = undefined;
  act(selected, 'ports', { ports });
});
$('runtime-action').addEventListener('click', event => act(selected, event.currentTarget.dataset.action));
$('detect-startup').addEventListener('click', detectStartup);
$('language').addEventListener('change', render);
$('project-startup-add').addEventListener('click', () => {
  startupMessage = undefined;
  const row = addStartupService();
  render();
  row.querySelector('input').focus();
});
$('project-startup-services').addEventListener('click', event => {
  if (!event.target.closest('.startup-remove')) return;
  const row = event.target.closest('.startup-service');
  const next = row.nextElementSibling ?? row.previousElementSibling;
  row.remove();
  startupMessage = undefined;
  render();
  (next?.querySelector('input') ?? $('project-startup-add')).focus();
});
$('project-startup-form').addEventListener('input', () => {
  startupMessage = undefined;
  render();
});
$('project-startup-form').addEventListener('submit', event => {
  event.preventDefault();
  act(selected, 'startup', { services: startupDraft() });
});
function installDependencies(detected) {
  const plan = dependencyPlanView?.id === selected ? dependencyPlanView.data : undefined;
  $('dependency-log').open = true;
  act(selected, 'install', detected && plan?.steps.length ? { mode: 'detected', planId: plan.id } : {});
}
$('install-dependencies').addEventListener('click', () => installDependencies(true));
$('install-custom-dependencies').addEventListener('click', () => installDependencies(false));
$('refresh-dependencies').addEventListener('click', () => loadDependencyPlan(true));
$('cancel-install').addEventListener('click', () => act(selected, 'install-cancel'));
$('project-database').addEventListener('toggle', () => loadDatabase());
$('database-start').addEventListener('click', () => act(selected, 'database-start'));
$('database-stop').addEventListener('click', () => act(selected, 'database-stop'));
$('database-logs').addEventListener('click', () => loadDatabase(true));
$('database-backup').addEventListener('click', () => backupAction(projects.find(project => project.id === selected)));
$('database-restore').addEventListener('click', () => {
  restoring = projects.find(project => project.id === selected);
  if (!restoring || pending) return;
  $('database-restore-form').reset();
  $('database-restore-file').accept = (databaseView?.engine ?? restoring.database) === 'postgres' ? '.dump' : '.sql';
  $('database-restore-expected').textContent = restoring.name;
  $('database-restore-submit').disabled = true;
  $('database-restore-dialog').showModal();
});
function validRestore() {
  const file = $('database-restore-file').files[0];
  return file?.size > 0 && file.size <= 64 * 1024 * 1024 && $('database-restore-name').value === restoring?.name && !pending;
}
$('database-restore-form').addEventListener('input', () => { $('database-restore-submit').disabled = !validRestore(); });
$('database-restore-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!validRestore()) return;
  $('database-restore-dialog').close();
  backupAction(restoring, $('database-restore-file').files[0]);
});
$('database-restore-cancel').addEventListener('click', () => $('database-restore-dialog').close());
$('database-delete').addEventListener('click', async () => {
  const id = selected;
  if (!id || pending) return;
  pending = { id, action: 'database-delete' };
  actionError = undefined;
  transferMessage = undefined;
  render();
  try {
    const { volume } = await request(`/api/projects/${id}/database-delete`, { signal: AbortSignal.timeout(90_000) });
    if (id !== selected) return;
    deletingDatabase = { id, volume };
    $('database-delete-form').reset();
    $('database-delete-expected').textContent = volume;
    $('database-delete-submit').disabled = true;
    $('database-delete-dialog').showModal();
  } catch (error) {
    actionError = { id, action: 'database-delete', message: error.message };
  } finally {
    pending = undefined;
    render();
  }
});
$('database-delete-name').addEventListener('input', event => {
  $('database-delete-submit').disabled = event.target.value !== deletingDatabase?.volume;
});
$('database-delete-cancel').addEventListener('click', () => $('database-delete-dialog').close());
$('database-delete-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!deletingDatabase || pending || $('database-delete-name').value !== deletingDatabase.volume) return;
  $('database-delete-dialog').close();
  act(deletingDatabase.id, 'database-delete', { confirmVolume: deletingDatabase.volume });
});
for (const tool of ['checks', 'git']) $('project-' + tool).addEventListener('toggle', () => loadProjectTool(tool, true));
$('git-refresh').addEventListener('click', () => loadProjectTool('git', true));
$('check-form').addEventListener('submit', event => {
  event.preventDefault();
  act(selected, 'run-check', { check: $('check-command').value });
});
$('check-cancel').addEventListener('click', () => act(selected, 'check-cancel'));
$('check-config-add').addEventListener('click', () => {
  const row = addCheckRow();
  checkConfigMessage = undefined;
  render();
  row.querySelector('select').focus();
});
$('check-config-rows').addEventListener('click', event => {
  const remove = event.target.closest('.startup-remove');
  if (!remove) return;
  remove.closest('fieldset').remove();
  checkConfigMessage = undefined;
  render();
  $('check-config-add').focus();
});
$('check-config-form').addEventListener('input', () => { checkConfigMessage = undefined; render(); });
$('check-config-form').addEventListener('submit', event => {
  event.preventDefault();
  act(selected, 'check-config', { commands: checkDraft() });
});
function confirmProjectRemoval(action) {
  const project = projects.find(item => item.id === selected);
  if (!project || pending) return;
  confirming = { ...project, action };
  transferMessage = undefined;
  $('project-trash-path').textContent = project.path;
  $('project-trash-expected').textContent = project.name;
  $('project-trash-name').value = '';
  $('project-trash-confirm').disabled = true;
  const deleteFiles = action === 'trash' && removesFiles(project);
  setText($('project-trash-title'), deleteFiles ? 'Delete project?' : 'Remove project from Projects?');
  setText($('project-trash-instruction'), deleteFiles ? 'Type the project name below to confirm deletion.' : 'Type the project name below to confirm removal.');
  setText($('project-trash-confirm'), deleteFiles ? 'Delete project' : 'Remove from Projects');
  setText($('project-trash-description'), !deleteFiles ? 'This removes the entry from the Projects list. Your files stay in this folder.' : project.database !== 'none'
    ? 'The project folder will move to the system trash. Its database and data volume will be kept.'
    : 'The entire local project folder will move to the system trash. You can restore it from there.');
  $('project-trash-dialog').showModal();
  render();
}
$('project-delete').addEventListener('click', () => confirmProjectRemoval('trash'));
$('project-remove').addEventListener('click', () => confirmProjectRemoval('remove'));
$('project-trash-cancel').addEventListener('click', () => $('project-trash-dialog').close());
$('project-trash-name').addEventListener('input', event => {
  $('project-trash-confirm').disabled = Boolean(pending) || event.target.value !== confirming?.name;
});
$('project-trash-form').addEventListener('submit', event => {
  event.preventDefault();
  const confirmName = $('project-trash-name').value;
  if (!confirming || pending || confirmName !== confirming.name) return;
  $('project-trash-dialog').close();
  act(confirming.id, confirming.action, { confirmName });
});
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });
refresh();
