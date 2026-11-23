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
  form.append(scope, files, reverse, note, recovery, controls);
  section.append(actions, status, cancel, form);

  let plan, active;
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
    return post('/api/projects/' + projectId + '/database-native-migration', token, {
      sourceId: source.id, adapter: source.adapter, operation, mode, ...targetSelection,
      ...(mode === 'execute' && { planId: plan.planId, confirmName: confirm.value })
    }, mode === 'preview' ? 220000 : 240000, active.signal);
  }

  async function work(callback) {
    if (active) return;
    const operation = new AbortController();
    active = operation;
    cancel.hidden = false;
    lock(true);
    controls.disabled = true;
    for (const button of actions.children) button.disabled = true;
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
      for (const button of actions.children) button.disabled = false;
    }
  }

  for (const operation of source.adapter === 'liquibase' ? ['apply', 'rollback'] : ['apply']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    setText(button, operation === 'apply' ? 'Preview migration plan' : 'Preview rollback plan');
    actions.append(button);
    button.addEventListener('click', () => void work(async () => {
      reset(true);
      setText(status, 'Preparing the migration tool and checking database history…');
      const targetSelection = selection();
      const result = await send('preview', operation, targetSelection);
      plan = { operation, targetSelection, ...result };
      const { host, port, name } = result.target;
      scope.textContent = [result.tool + ' ' + result.version, result.directory, host + ':' + port + '/' + name,
        result.history.schema + '.' + result.history.table].join(' · ');
      files.replaceChildren(...result.migrations.map(item => {
        const line = document.createElement('li');
        line.textContent = item.revision + ' · ' + item.file;
        return line;
      }));
      reverse.hidden = !result.undo;
      reverse.textContent = result.undo?.join('\n') ?? '';
      setText(note, operation === 'apply' ? 'Review the listed files. Applying the plan runs their SQL against the selected database.' :
        'Review the rollback SQL. It can remove schema objects or data.');
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
  return { element: section, reset };
}
