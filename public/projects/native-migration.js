import { setText } from '/i18n.js';
import { labelledMigrationControl } from '/projects/migration-history.js';

const outcomes = {
  applied: 'Migration finished and the database history was verified.',
  'rolled-back': 'Rollback finished and the database history was verified.',
  'execution-failed': 'The migration tool could not finish. Check the current history before retrying.',
  'execution-unverified': 'The tool finished, but the expected history could not be verified. Check the database before retrying.'
};

export function nativeMigrationControls(projectId, source, { request, post }, { selection, lock, refresh }) {
  const section = document.createElement('section');
  section.className = 'native-migration';
  const actions = document.createElement('div');
  actions.className = 'migration-history-controls';
  const status = document.createElement('p');
  status.className = 'hint';
  status.setAttribute('role', 'status');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.hidden = true;
  setText(cancel, 'Cancel migration operation');
  const form = document.createElement('form');
  const scope = document.createElement('p');
  scope.className = 'hint';
  const expectedHeads = document.createElement('p');
  expectedHeads.className = 'hint';
  expectedHeads.hidden = true;
  const files = document.createElement('ul');
  files.className = 'check-list';
  const reverse = document.createElement('pre');
  const note = document.createElement('p');
  note.className = 'hint';
  const recovery = document.createElement('p');
  recovery.className = 'hint';
  setText(recovery, 'Download a verified backup from the project database controls before running the plan.');
  const confirm = document.createElement('input');
  confirm.autocomplete = 'off';
  confirm.spellcheck = false;
  confirm.required = true;
  const submit = document.createElement('button');
  submit.className = 'primary';
  submit.type = 'submit';
  const controls = document.createElement('fieldset');
  controls.className = 'migration-history-controls';
  controls.append(labelledMigrationControl('Type the target database name to confirm.', confirm), submit);
  form.append(scope, expectedHeads, files, reverse, note, recovery, controls);
  section.append(actions, status, cancel, form);

  let plan, active;
  const revision = document.createElement('select');
  const revisionLabel = labelledMigrationControl('Target revision', revision);
  const efCore = source.adapter === 'ef-core';
  const script = document.createElement('input');
  script.maxLength = 380;
  script.spellcheck = false;
  script.autocomplete = 'off';
  if (efCore || ['alembic', 'flyway'].includes(source.adapter)) actions.append(revisionLabel);
  revisionLabel.hidden = source.adapter === 'flyway';
  if (efCore) actions.append(labelledMigrationControl('EF Core SQL file relative to the project', script));
  const projectRuntime = document.createElement('input');
  projectRuntime.type = 'checkbox';
  const runtimeFiles = document.createElement('input');
  runtimeFiles.disabled = true;
  runtimeFiles.maxLength = 4000;
  runtimeFiles.spellcheck = false;
  runtimeFiles.autocomplete = 'off';
  if (source.adapter === 'alembic') actions.append(labelledMigrationControl('Use the project Alembic environment', projectRuntime),
    labelledMigrationControl('Local Python files, comma separated', runtimeFiles));
  const rollbackCount = document.createElement('input');
  rollbackCount.type = 'number';
  rollbackCount.min = '1';
  rollbackCount.step = '1';
  rollbackCount.value = '1';
  const rollbackTag = document.createElement('input');
  rollbackTag.maxLength = 255;
  rollbackTag.autocomplete = 'off';
  rollbackTag.spellcheck = false;
  const availableTags = document.createElement('datalist');
  availableTags.id = 'rollback-tags-' + projectId + '-' + source.id;
  rollbackTag.setAttribute('list', availableTags.id);
  if (source.adapter === 'liquibase') actions.append(labelledMigrationControl('Changesets to roll back', rollbackCount),
    labelledMigrationControl('Rollback tag (optional)', rollbackTag), availableTags);
  function setRevisions(ids) {
    const previous = revision.value;
    const automatic = new Option('', '');
    setText(automatic, 'Automatic');
    revision.replaceChildren(automatic, ...(source.adapter === 'flyway' ? [] : [new Option('base', 'base')]),
      ...ids.map(id => new Option(id, id)));
    revisionLabel.hidden = source.adapter === 'flyway' && !ids.length;
    if (ids.includes(previous) || source.adapter !== 'flyway' && previous === 'base') revision.value = previous;
  }
  revision.addEventListener('change', () => reset(true));
  script.addEventListener('input', () => reset(true));
  projectRuntime.addEventListener('input', () => {
    runtimeFiles.disabled = !projectRuntime.checked;
    reset(true);
  });
  runtimeFiles.addEventListener('input', () => reset(true));
  rollbackCount.addEventListener('input', () => reset(true));
  rollbackTag.addEventListener('input', () => {
    rollbackCount.disabled = Boolean(rollbackTag.value.trim());
    reset(true);
  });
  cancel.addEventListener('click', () => active?.abort());
  function reset(visible = false) {
    plan = undefined;
    section.hidden = !visible;
    form.hidden = true;
    confirm.value = '';
    setText(status, '');
  }
  reset();

  async function send(mode, operation, targetSelection) {
    const { token } = await request('/api/state');
    const liquibaseRollback = source.adapter === 'liquibase' && operation === 'rollback';
    const timeout = liquibaseRollback ? 360000 : mode === 'preview' ? 220000 : 240000;
    return post('/api/projects/' + projectId + '/database-native-migration', token, {
      sourceId: source.id, adapter: source.adapter, operation, mode, ...targetSelection,
      ...(mode === 'execute' && { planId: plan.planId, confirmName: confirm.value })
    }, timeout, active.signal);
  }

  async function work(callback) {
    if (active) return;
    const operation = new AbortController();
    active = operation;
    cancel.hidden = false;
    lock(true);
    controls.disabled = true;
    for (const control of actions.querySelectorAll('button, select, input')) control.disabled = true;
    try { await callback(); }
    catch (error) {
      form.hidden = true;
      setText(status, operation.signal.aborted ? 'Cancellation requested. Check database history before starting again.' : error.message);
    }
    finally {
      cancel.hidden = true;
      active = undefined;
      lock(false);
      controls.disabled = false;
      for (const control of actions.querySelectorAll('button, select, input')) control.disabled = false;
      rollbackCount.disabled = Boolean(rollbackTag.value.trim());
      runtimeFiles.disabled = !projectRuntime.checked;
    }
  }

  for (const operation of ['liquibase', 'alembic', 'ef-core'].includes(source.adapter) ? ['apply', 'rollback'] : ['apply']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    setText(button, operation === 'apply' ? 'Preview migration plan' : 'Preview rollback plan');
    actions.append(button);
    button.addEventListener('click', () => void work(async () => {
      reset(true);
      setText(status, 'Preparing the migration tool and checking database history…');
      const tag = rollbackTag.value.trim();
      const targetSelection = { ...selection(), ...(revision.value && { revision: revision.value }), ...(efCore && { scriptFile: script.value.trim() }),
        ...(source.adapter === 'alembic' && projectRuntime.checked && {
          projectEnvironment: true, runtimeFiles: runtimeFiles.value.split(',').map(file => file.trim()).filter(Boolean)
        }),
        ...(source.adapter === 'liquibase' && operation === 'rollback' && (tag ? { rollbackTag: tag } : { rollbackCount: Number(rollbackCount.value) })) };
      const result = await send('preview', operation, targetSelection);
      plan = { operation, targetSelection, ...result };
      const { host, port, name } = result.target;
      scope.textContent = [[result.tool, result.version].filter(Boolean).join(' '), result.directory, host + ':' + port + '/' + name,
        result.history.schema + '.' + result.history.table,
        result.toRevision && result.fromRevision + ' → ' + result.toRevision, result.rollbackTag, result.scriptFile].filter(Boolean).join(' · ');
      expectedHeads.hidden = !Array.isArray(result.expectedHeads);
      if (!expectedHeads.hidden) setText(expectedHeads, ['Recorded revisions after migration', result.expectedHeads.join(', ') || 'base']);
      files.replaceChildren(...result.migrations.map(item => {
        const line = document.createElement('li');
        line.textContent = item.revision + ' · ' + item.file;
        return line;
      }), ...(result.resources ?? []).map(file => {
        const line = document.createElement('li');
        setText(line, ['Migration resource', file]);
        return line;
      }));
      reverse.hidden = !result.undo && !result.sql;
      reverse.textContent = result.sql ?? result.undo?.join('\n') ?? '';
      const message = source.adapter === 'alembic'
        ? 'Review the listed Python revisions. Their code runs against the selected database and can change schema or data.'
        : efCore ? 'Review the exported SQL and selected migration range before continuing.' :
          operation === 'apply' ? 'Review the listed files. Applying the plan runs their SQL against the selected database.' :
          'Review the rollback SQL. It can remove schema objects or data.';
      setText(note, message);
      setText(recovery, result.target.engine === 'mysql'
        ? 'Back up the MySQL database before running this plan. A failed or cancelled migration can leave schema changes committed.'
        : result.target.engine === 'sqlserver' ? 'Back up the project SQL Server database before running the plan.'
          : 'Download a verified backup from the project database controls before running the plan.');
      setText(submit, operation === 'apply' ? 'Apply reviewed migrations' : 'Run reviewed rollback');
      confirm.placeholder = name;
      submit.disabled = true;
      form.hidden = false;
      setText(status, '');
    }));
  }
  confirm.addEventListener('input', () => { submit.disabled = !plan || confirm.value !== plan.target.name; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!plan || confirm.value !== plan.target.name) return;
    void work(async () => {
      setText(status, 'Running the migration tool and verifying database history…');
      const result = await send('execute', plan.operation, plan.targetSelection);
      form.hidden = true;
      plan = undefined;
      await refresh();
      setText(status, outcomes[result.status]);
    });
  });
  return { element: section, reset, setRevisions, setTags(tags = []) {
    availableTags.replaceChildren(...tags.map(tag => new Option(tag, tag)));
  } };
}
