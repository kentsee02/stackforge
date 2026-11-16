import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { archiveLimit, postgresArchiveLimit } from '../database/backup/archive.mjs';
import { streamBackupFile } from '../database/backup/payload.mjs';
import { hasImportedCompose } from '../database/docker/imported-database.mjs';
import { send } from './response.mjs';

export function createDatabaseArchiveRoutes({ database, managedProjects, runtime }) {
  async function archive(req, res, pathname, authorized) {
    const archiveRoute = /^\/api\/projects\/([^/]+)\/database-archive(?:\/(preview|restore))?$/.exec(pathname);
    if (archiveRoute) {
      await verifiedArchive(req, res, archiveRoute, authorized);
      return true;
    }
    const databaseTransfer = /^\/api\/projects\/([^/]+)\/database-(backup|restore)$/.exec(pathname);
    if (!databaseTransfer) return false;
    await legacyArchive(req, res, databaseTransfer, authorized);
    return true;
  }

  async function verifiedArchive(req, res, archiveRoute, authorized) {
    const [, id, action = 'backup'] = archiveRoute;
    if (!authorized(req, action === 'backup' ? 'application/json' : 'application/octet-stream')) {
      return send(res, 403, { error: '请求来源无效，请刷新本机页面后重试。' });
    }
    const project = managedProjects().find(item => item.id === id);
    if (!project) return send(res, 404, { error: 'This project was not found in StackForge.' });
    if (database.transferBlocked(project)) {
      return send(res, 409, { error: 'Wait for the current project operation to finish.' });
    }
    if (action !== 'backup' && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      return send(res, 409, { error: 'Stop the project before restoring its database.' });
    }
    const size = Number(req.headers['content-length']);
    if (action !== 'backup' && (!Number.isSafeInteger(size) || size < 1 || size > postgresArchiveLimit)) {
      return send(res, 413, { error: 'Choose a PostgreSQL backup up to 512 MiB or another supported backup up to 64 MiB.' });
    }
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    let staging;
    async function temporaryFile() {
      await mkdir(database.stagingRoot, { recursive: true, mode: 0o700 });
      staging = await mkdtemp(join(database.stagingRoot, 'transfer-'));
      return join(staging, 'archive');
    }
    async function removeStaging() {
      if (!staging) return;
      const directory = staging;
      staging = undefined;
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    async function receiveBackup() {
      let bytes = 0;
      async function* checked(source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > size) throw new Error('The backup upload was incomplete.');
          yield chunk;
        }
        if (bytes !== size) throw new Error('The backup upload was incomplete.');
      }
      if (size <= archiveLimit) {
        const chunks = [];
        for await (const chunk of checked(req)) chunks.push(chunk);
        return Buffer.concat(chunks, bytes);
      }
      const path = await temporaryFile();
      await pipeline(Readable.from(checked(req)), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
      if ((await stat(path)).size !== size) throw new Error('The backup upload was incomplete.');
      return { path, offset: 0, bytes };
    }
    if (action === 'backup') req.resume();
    const transfer = database.startArchive(project, action, controller, {
      bindingId: req.headers['x-stackforge-binding'], temporaryFile, receiveBackup,
      approval: req.headers['x-stackforge-preview'],
      confirmedTarget: Buffer.from(req.headers['x-stackforge-target'] ?? '', 'base64').toString()
    });
    try {
      const result = await transfer.done;
      if (!result.header) {
        await removeStaging();
        transfer.release();
      }
      if (action !== 'backup') return send(res, 200, result);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Content-Length': result.header ? result.header.length + result.data.bytes : result.data.length });
      if (result.header) {
        async function* download() {
          yield result.header;
          let finalChunk;
          for await (const chunk of streamBackupFile(result.data, controller.signal)) {
            if (finalChunk) yield finalChunk;
            finalChunk = chunk;
          }
          await removeStaging();
          transfer.release();
          if (finalChunk) yield finalChunk;
        }
        await pipeline(Readable.from(download()), res, { signal: controller.signal });
        return;
      }
      return res.end(result.data);
    } catch (error) {
      await removeStaging();
      transfer.release();
      if (!res.destroyed && !res.headersSent) return send(res, 409, { error: database.redact(error.message).split('\n')[0] });
      res.destroy();
    } finally {
      await removeStaging();
      transfer.release();
    }
  }

  async function legacyArchive(req, res, databaseTransfer, authorized) {
    const [, id, action] = databaseTransfer;
    const restore = action === 'restore';
    if (!authorized(req, restore ? 'application/octet-stream' : 'application/json')) return send(res, 403, { error: '请求来源无效，请刷新本机页面后重试。' });
    if (restore) {
      req.resume();
      return send(res, 409, { error: 'Preview a verified StackForge backup before restoring.' });
    }
    const project = managedProjects().find(item => item.id === id);
    if (!project || (project.database === 'none' && !await hasImportedCompose(project))) return send(res, 404, { error: 'This project has no database.' });
    if (database.transferBlocked(project)) {
      return send(res, 409, { error: 'Wait for the current project operation to finish.' });
    }
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    req.resume();
    const transfer = database.startLegacyBackup(project, controller);
    try {
      const result = await transfer.done;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${result.filename}"`, 'Content-Length': result.data.length });
      return res.end(result.data);
    } catch (error) {
      if (!res.destroyed) return send(res, 409, { error: database.redact(error.message).split('\n')[0].trim() });
    } finally { transfer.release(); }
  }

  return archive;
}
