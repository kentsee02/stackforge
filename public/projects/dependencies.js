import { setText } from '/i18n.js';

export function createDependenciesPanel({ $, request, showMessage, renderOutput, diagnosticMessages, state, selectedId, selectedProject, renderPage: render, act }) {
  let dependencyPlanView;

  function renderDependencies(project, busy, unavailable, startupDirty) {
    const task = project.dependencies;
    const installing = project.operation === 'dependencies' || (state.pending?.id === project.id && state.pending.action === 'install');
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
    $('cancel-install').disabled = Boolean(state.pending) || task?.status === 'cancelling';
    const installError = state.actionError?.id === project.id && state.actionError.action?.startsWith('install') ? state.actionError : undefined;
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
    const project = selectedProject();
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
      if (dependencyPlanView === view && selectedId() === view.id) render();
    }
  }

  function installDependencies(detected) {
    const plan = dependencyPlanView?.id === selectedId() ? dependencyPlanView.data : undefined;
    $('dependency-log').open = true;
    act(selectedId(), 'install', detected && plan?.steps.length ? { mode: 'detected', planId: plan.id } : {});
  }
  $('install-dependencies').addEventListener('click', () => installDependencies(true));
  $('install-custom-dependencies').addEventListener('click', () => installDependencies(false));
  $('refresh-dependencies').addEventListener('click', () => loadDependencyPlan(true));
  $('cancel-install').addEventListener('click', () => act(selectedId(), 'install-cancel'));

  return { render: renderDependencies, load: loadDependencyPlan };
}
