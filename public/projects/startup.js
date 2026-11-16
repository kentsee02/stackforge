import { setText, translate } from '/i18n.js';

export function createStartupPanel({ $, request, showMessage, state, selectedId, selectedProject, renderPage: render, act }) {
  let startupMessage;
  let startupDetection;
  let displayedStartupSuggestions;

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
      if (selectedId() !== id) return;
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
    const project = selectedProject();
    if (!project?.unmanaged) return;
    const view = { id: project.id, loading: true };
    startupDetection = view;
    render();
    try {
      view.data = await request(`/api/projects/${project.id}/startup-suggestions`, { signal: AbortSignal.timeout(12000) });
    } catch (error) { view.error = error.message; }
    finally {
      view.loading = false;
      if (startupDetection === view && selectedId() === view.id) render();
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
    const saving = state.pending?.id === project.id && state.pending.action === 'startup';
    const feedback = $('project-startup-message');
    feedback.classList.toggle('project-operation-error', Boolean(message?.error) && !saving);
    showMessage(feedback, saving ? 'Saving startup configuration…' : message?.message || (dirty ? 'Save configuration changes before running commands.' : ''));
    return dirty;
  }

  $('detect-startup').addEventListener('click', detectStartup);
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
    act(selectedId(), 'startup', { services: startupDraft() });
  });

  return { render: renderStartup, setMessage(message) { startupMessage = message; } };
}
