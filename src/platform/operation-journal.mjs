import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export const recentOperationLimit = 50;
const readLimit = 4 * 1024 * 1024;
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const outcomes = new Set(['succeeded', 'failed', 'cancelled']);
const validTime = value => typeof value === 'string' && timestamp.test(value) && Number.isFinite(Date.parse(value));

export function operationJournal(file, actions, writeWarning) {
  let pending = Promise.resolve();

  function begin(project, action, instanceId) {
    if (!file || !actions.has(action) || !uuid.test(project.id)) return async () => {};
    const record = { id: randomUUID(), projectId: project.id, action, startedAt: new Date().toISOString(),
      ...(/^[a-f\d]{64}$/.test(instanceId ?? '') && { instanceId }) };
    return async outcome => {
      const status = outcomes.has(outcome) ? outcome : 'failed';
      const line = JSON.stringify({ ...record, status, finishedAt: new Date().toISOString() }) + '\n';
      pending = pending.then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const handle = await open(file, 'a+', 0o600);
        try {
          const { size } = await handle.stat();
          const lastByte = Buffer.alloc(1, 10);
          if (size) await handle.read(lastByte, 0, 1, size - 1);
          // Give an interrupted record its own line so the next complete entry stays readable.
          await handle.appendFile(lastByte[0] === 10 ? line : '\n' + line);
        } finally { await handle.close(); }
      }).catch(() => { console.error(writeWarning); });
      await pending;
    };
  }

  async function recent(project) {
    const entries = [];
    if (!file || !uuid.test(project.id)) return { entries, limited: false };
    await pending;
    const handle = await open(file, 'r').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!handle) return { entries, limited: false };
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - readLimit);
      const bytes = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      const lines = bytes.toString('utf8', 0, bytesRead).split('\n');
      // Skip a partial first line from the read window and any interrupted final write.
      for (let i = lines.length - 2; i >= Number(start > 0) && entries.length < recentOperationLimit; i--) {
        if (!lines[i].includes(project.id) || lines[i].length > 1024) continue;
        let item;
        try { item = JSON.parse(lines[i]); } catch { continue; }
        if (item?.projectId !== project.id || typeof item.id !== 'string' || !uuid.test(item.id) ||
            !actions.has(item.action) || !outcomes.has(item.status) || !validTime(item.startedAt) || !validTime(item.finishedAt)) continue;
        const { id, action, status, startedAt, finishedAt } = item;
        entries.push({ id, action, status, startedAt, finishedAt });
      }
      return { entries, limited: start > 0 && entries.length < recentOperationLimit };
    } finally { await handle.close(); }
  }

  return { begin, recent, get pending() { return pending; } };
}
