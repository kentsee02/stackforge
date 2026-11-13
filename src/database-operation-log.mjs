import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const actions = new Set(['database-start', 'database-stop', 'database-delete', 'database-backup', 'database-restore']);
const projectId = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;

export function databaseOperationLog(file) {
  let pending = Promise.resolve();
  return {
    get pending() { return pending; },
    begin(project, action) {
      if (!file || !actions.has(action) || !projectId.test(project.id)) return async () => {};
      const record = { id: randomUUID(), projectId: project.id, action, startedAt: new Date().toISOString() };
      return async outcome => {
        // Keep only the controlled outcome. Docker output and exception text can contain credentials.
        const status = outcome === 'succeeded' ? 'succeeded' : outcome === 'cancelled' ? 'cancelled' : 'failed';
        const line = JSON.stringify({ ...record, status, finishedAt: new Date().toISOString() }) + '\n';
        pending = pending.then(async () => {
          await mkdir(dirname(file), { recursive: true });
          await appendFile(file, line, { mode: 0o600 });
        }).catch(() => { console.error('Could not save a StackForge database operation record.'); });
        await pending;
      };
    }
  };
}
