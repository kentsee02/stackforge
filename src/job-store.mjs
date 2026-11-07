import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateOptions } from './catalog.mjs';

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class JobStore {
  constructor(directory) { this.directory = directory; this.pending = new Map(); }

  async load() {
    if (!this.directory) return [];
    let files;
    try { files = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const file of files.filter(file => file.endsWith('.json') && idPattern.test(file.slice(0, -5)))) {
      try {
        const record = JSON.parse(await readFile(join(this.directory, file), 'utf8'));
        if (record.version !== 1 || record.job?.id !== file.slice(0, -5) || !record.checkpoint || typeof record.checkpoint !== 'object') continue;
        record.options = validateOptions(record.options);
        if (!Array.isArray(record.job.logs)) record.job.logs = [];
        if (['running', 'cancelling'].includes(record.job.status)) {
          record.job.status = 'cancelled';
          record.job.step = '服务已重启，可继续未完成的步骤';
        }
        records.push(record);
      } catch { /* ignore a corrupt record without changing project files */ }
    }
    return records.sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt));
  }

  save(job, options, checkpoint) {
    if (!this.directory) return Promise.resolve();
    if (!idPattern.test(job.id)) return Promise.reject(new Error('无效的创建任务标识。'));
    const contents = JSON.stringify({ version: 1, job: { ...job, logs: job.logs.slice(-100) }, options, checkpoint });
    const previous = this.pending.get(job.id) ?? Promise.resolve();
    const writing = previous.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temp = join(this.directory, `${job.id}.${randomUUID()}.tmp`);
      await writeFile(temp, contents, { mode: 0o600 });
      await rename(temp, join(this.directory, `${job.id}.json`));
    });
    this.pending.set(job.id, writing);
    return writing;
  }
}
