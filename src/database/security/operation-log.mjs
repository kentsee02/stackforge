import { operationJournal } from '../../platform/operation-journal.mjs';

const actions = new Set(['database-start', 'database-stop', 'database-delete', 'database-backup', 'database-restore', 'database-initialize', 'database-migrate', 'database-rollback', 'database-profile-cleanup']);
for (const action of ['create', 'start', 'stop', 'save', 'delete']) actions.add('database-development-' + action);
for (const action of ['database-connection-config', 'database-remote-profile-save', 'database-remote-profile-remove']) actions.add(action);

export function databaseOperationLog(file) {
  return operationJournal(file, actions, 'Could not save a StackForge database operation record.');
}
