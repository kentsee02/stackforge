import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { JobStore } from './job-store.mjs';
import { absoluteDirectory } from '../platform/paths.mjs';
import { cancelled, throwIfCancelled } from '../platform/process.mjs';
import { assertDirectoryIdentity, recordedIdentity } from '../platform/project-identity.mjs';

const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path;

export class Jobs {
  constructor({ directory, generate, check, publish, relocatedPath = () => undefined }) {
    this.store = new JobStore(directory);
    this.generate = generate; this.check = check; this.publish = publish;
    this.relocatedPath = relocatedPath;
    this.records = new Map(); this.controllers = new Map(); this.executions = new Map();
    this.ready = this.store.load().then(records => { for (const record of records) this.records.set(record.job.id, record); });
  }

  get busy() { return this.controllers.size > 0; }

  view(id) {
    const record = this.records.get(id);
    if (!record) return;
    const { job, options, checkpoint } = record;
    const moved = this.relocatedPath(id);
    return { ...job, ...(moved && job.result && { result: { ...job.result, path: moved } }),
      options, canResume: ['failed', 'cancelled'].includes(job.status), completed: checkpoint.completed ?? [],
      retainedPath: checkpoint.promoted ? moved ?? resolve(options.parentDir, options.name) : checkpoint.staging };
  }

  async openProject(id, action, open) {
    const record = this.records.get(id);
    if (record?.job.status !== 'complete' || !record.job.result?.path) throw new Error('The local project is not ready to open.');
    const { path, verify } = await this.verifyProject(record);
    await open(path, action, verify);
  }

  async verifyProject({ job, options, checkpoint }) {
    const expected = resolve(options.parentDir, options.name);
    const actual = absoluteDirectory(job.result?.path);
    if (pathKey(actual) !== pathKey(expected)) throw new Error('The recorded project location does not match this task.');
    const identity = recordedIdentity(checkpoint.folderIdentity);
    if (!identity) throw new Error('This task has no recorded folder identity. Manage the folder in Projects or import its new location if it was moved.');
    const path = this.relocatedPath(job.id) ?? expected;
    const verify = () => assertDirectoryIdentity(path, identity,
      'The project folder is missing or has been replaced. Re-import the original folder if it was moved.');
    await verify();
    return { path, verify };
  }

  list() {
    return [...this.records.values()].reverse().slice(0, 30).map(({ job, options }) => ({ id: job.id, name: options.name, status: job.status, step: job.step, createdAt: job.createdAt }));
  }

  projects() {
    const projects = new Map();
    for (const { job, options, checkpoint } of [...this.records.values()].reverse()) {
      if (typeof job.result?.path !== 'string' || (job.status !== 'complete' && job.retryKind !== 'publish')) continue;
      const path = resolve(options.parentDir, options.name);
      const key = pathKey(path);
      const recorded = pathKey(job.result.path);
      if (key !== recorded || projects.has(key)) continue;
      const { name, frontend, backend, database } = options;
      projects.set(key, { id: job.id, name, path, frontend, backend, database, folderIdentity: recordedIdentity(checkpoint.folderIdentity) });
    }
    return [...projects.values()];
  }

  async persist(record) {
    record.job.updatedAt = new Date().toISOString();
    await this.store.save(record.job, record.options, record.checkpoint);
  }

  async create(options) {
    if (this.busy) throw new Error('已有任务正在执行，请先等待或取消。');
    const job = { id: randomUUID(), name: options.name, status: 'running', progress: 0, step: '创建前检查', logs: [], createdAt: new Date().toISOString() };
    const record = { job, options, checkpoint: {} };
    this.records.set(job.id, record);
    await this.start(record);
    return job.id;
  }

  async retry(id, publicationOnly = false) {
    const record = this.records.get(id);
    if (!record) throw new Error('找不到这个创建任务。');
    if (this.busy) throw new Error('已有任务正在执行，请先等待或取消。');
    if (publicationOnly ? record.job.result?.remote?.status !== 'failed' : !['failed', 'cancelled'].includes(record.job.status)) throw new Error('这个任务目前不能重试。');
    await this.start(record, publicationOnly || record.job.retryKind === 'publish');
    return id;
  }

  async cancel(id) {
    const record = this.records.get(id);
    const controller = this.controllers.get(id);
    if (!record || !controller) throw new Error('这个任务没有在执行。');
    if (record.job.status === 'cancelling') return;
    if (record.job.status !== 'running') throw new Error('这个任务没有在执行。');
    record.job.status = 'cancelling'; record.job.step = '正在停止下载与安装进程…';
    controller.abort();
    await this.persist(record);
  }

  async start(record, publicationOnly = false) {
    const { job } = record;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = 'running'; job.error = undefined; job.environment = undefined;
    job.retryKind = publicationOnly ? 'publish' : 'create';
    job.step = publicationOnly ? '重试 GitHub 发布' : record.checkpoint.staging ? '继续未完成的创建步骤' : '创建前检查';
    const saved = this.persist(record);
    const execution = saved.then(() => this.execute(record, controller, publicationOnly), error => {
      job.status = 'failed'; job.error = error.message;
      this.controllers.delete(job.id);
      this.executions.delete(job.id);
    });
    this.executions.set(job.id, execution);
    await saved;
  }

  async execute(record, controller, publicationOnly) {
    const { job, options, checkpoint } = record;
    const signal = controller.signal;
    const report = event => {
      if (event.type === 'step') { job.step = event.message; job.progress = event.progress; job.phase = event.phase; }
      job.logs.push(event.message.slice(-8000));
      if (job.logs.length > 300) job.logs.shift();
    };
    try {
      throwIfCancelled(signal);
      if (publicationOnly) {
        const { path, verify } = await this.verifyProject(record);
        throwIfCancelled(signal);
        job.result.remote = await this.publish(path, options, report, { signal, verifyProject: verify });
      } else {
        if (!checkpoint.staging && !checkpoint.promoted) {
          const environment = await this.check(options, { signal });
          throwIfCancelled(signal);
          job.environment = environment;
          if (!environment.canCreate) {
            throw new Error('创建前检查未通过，请处理环境问题后继续，或更换配置新建任务。');
          }
        }
        job.result = await this.generate(options, report, { checkpoint, signal, onCheckpoint: () => this.persist(record) });
      }
      throwIfCancelled(signal);
      job.status = 'complete'; job.progress = 100;
      job.step = job.result?.remote?.status === 'failed' ? '本地项目已创建，GitHub 发布未完成' : '项目已创建';
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') {
        job.status = 'cancelled'; job.error = cancelled().message; job.step = '已取消，可继续未完成的步骤';
      } else if (publicationOnly) {
        job.result.remote = { status: 'failed', error: error.message };
        job.status = 'complete'; job.step = '本地项目已保留，GitHub 发布未完成';
      } else {
        job.status = 'failed'; job.error = error.message; job.step = '创建未完成，可从失败步骤重试';
      }
      if (!publicationOnly && checkpoint.result) job.result = checkpoint.result;
    } finally {
      try { await this.persist(record); }
      catch (error) { job.logs.push('无法保存任务记录：' + error.message); }
      this.controllers.delete(job.id);
      this.executions.delete(job.id);
    }
  }

  async shutdown() {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.executions.values()]);
  }
}
