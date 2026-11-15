import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { databaseRedactor } from '../database/security/secrets.mjs';
import { databaseOperationLog } from '../database/security/operation-log.mjs';
import { archiveLimit } from '../database/backup/archive.mjs';
import { databaseResources } from '../database/resources.mjs';
import { databaseVault } from '../database/security/vault.mjs';
import { DatabaseRegistry } from '../database/registry.mjs';
import { localInstallation, validateLocalTarget } from '../database/adapters/local.mjs';
import { executeInitialization, initializationPlan, publicInitializationPlan } from '../database/initialization.mjs';
import { saveDatabaseEnvironment } from '../database/environment.mjs';
import { defaultPorts } from '../projects/project-config.mjs';
import { locationExists } from '../platform/paths.mjs';
import { startupDiagnostic } from '../projects/project-runtime.mjs';
import { hasImportedCompose } from '../database/docker/imported-database.mjs';
import { discoverDatabases } from '../database/discovery.mjs';
import { send } from './response.mjs';

export function createDatabaseRoutes({ stateDir, operations, databaseAdapters, projectConfig, managedProjects,
  runtime, removals, configWrites, localDatabase, isClosing }) {
  const redactDatabase = databaseRedactor(process.env);
  const databaseLog = databaseOperationLog(stateDir ? join(dirname(stateDir), 'database-operations.jsonl') : false);
  const databaseRegistry = new DatabaseRegistry(stateDir ? join(dirname(stateDir), 'databases.json') : undefined);
  const resources = databaseResources({ registry: databaseRegistry, operations,
    directory: stateDir ? join(dirname(stateDir), 'stackforge-backup-work') : tmpdir(),
    vault: databaseVault(stateDir ? join(dirname(stateDir), 'credentials') : undefined), ...databaseAdapters });
  const databaseWrites = new Map();
  let transfer;

  async function scanDatabases(project, discovery) {
    const { requirements, limited } = discovery ?? await discoverDatabases(project);
    await databaseRegistry.sync(project, requirements, projectConfig.ports(project).database ?? defaultPorts(project).database);
    return { ...databaseRegistry.view(project), limited };
  }

  async function refreshDatabaseBindings(except, strict = false) {
    for (const other of managedProjects().filter(item => item.id !== except)) {
      if (!await locationExists(other.path)) continue;
      try {
        const scan = await scanDatabases(other);
        if (strict && scan.limited) throw new Error();
      } catch {
        if (strict) throw new Error('StackForge could not verify whether another project uses this database.');
      }
    }
  }

  async function localDatabaseTarget(project, bindingId) {
    const { bindings } = await scanDatabases(project);
    const binding = bindings.find(item => item.id === bindingId);
    const target = validateLocalTarget(binding?.server, binding?.instance);
    return { binding, target };
  }

  async function resourceBinding(project, id, provider) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Choose an available database binding.');
    const { bindings } = await scanDatabases(project);
    const binding = bindings.find(item => item.id === id && (!provider || item.instance.provider === provider));
    if (!binding) throw new Error('Choose an available database binding.');
    return binding;
  }

  async function verifyDatabaseDeletion(project, volumeTarget) {
    await scanDatabases(project);
    if (volumeTarget.endpoints?.length) {
      await refreshDatabaseBindings(project.id, true);
      if (volumeTarget.endpoints.some(endpoint => databaseRegistry.usesEndpoint(project.id, endpoint))) {
        throw new Error('Another project uses this database. Shared databases cannot be deleted from StackForge.');
      }
    }
  }

  async function view(res, project, view, searchParams) {
    try {
      if (view === 'database-discovery') {
        await refreshDatabaseBindings(project.id);
        const discovery = await scanDatabases(project);
        return send(res, 200, { ...discovery, bindings: discovery.bindings.map(item => ({
          ...item, ...(item.instance.provider === 'remote' && {
            profileSaved: Boolean(databaseRegistry.profile(project.id, item.instanceId))
          })
        })) });
      }
      if (view === 'database-delete') {
        if (['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
          return send(res, 409, { error: 'Stop the project before deleting its database.' });
        }
        const target = await operations.databaseDeletionTarget(project, projectConfig.ports(project));
        const { volume } = target;
        await verifyDatabaseDeletion(project, target);
        return send(res, 200, { volume });
      }
      const includeCapabilities = searchParams.has('capabilities');
      const result = await operations.database(project, projectConfig.ports(project), searchParams.has('logs'), includeCapabilities);
      if (includeCapabilities && result.capabilities.delete) {
        try { await verifyDatabaseDeletion(project, result); }
        catch (error) {
          result.capabilities.delete = false;
          result.deleteHint = redactDatabase.text(error.message).split('\n')[0];
        }
      }
      delete result.endpoints;
      return send(res, 200, result);
    } catch (error) {
      const message = redactDatabase.text(error.message);
      return send(res, 409, { error: message.split('\n')[0].trim(), diagnostic: view === 'database' ? startupDiagnostic(project, message) : undefined });
    }
  }

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
    if (isClosing() || transfer || databaseWrites.size || removals.has(project.path) || configWrites.has(project.path) || operations.active(project)) {
      return send(res, 409, { error: 'Wait for the current project operation to finish.' });
    }
    if (action !== 'backup' && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      return send(res, 409, { error: 'Stop the project before restoring its database.' });
    }
    const size = Number(req.headers['content-length']);
    if (action !== 'backup' && (!Number.isSafeInteger(size) || size < 1 || size > archiveLimit)) {
      return send(res, 413, { error: 'Choose a StackForge backup up to 64 MiB.' });
    }
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    const done = (async () => {
      const bindingId = req.headers['x-stackforge-binding'];
      if (bindingId && action !== 'backup') await refreshDatabaseBindings(project.id, true);
      const binding = bindingId ? await resourceBinding(project, bindingId) : undefined;
      const ports = projectConfig.ports(project);
      const signal = controller.signal;
      const operation = action === 'preview' ? undefined : databaseLog.begin(project, 'database-' + action, binding?.instanceId);
      try {
        let result;
        if (action === 'backup') {
          req.resume();
          result = await resources.backup(project, binding, ports, signal);
        } else {
          const chunks = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > size) throw new Error('Choose a StackForge backup up to 64 MiB.');
            chunks.push(chunk);
          }
          if (bytes !== size) throw new Error('The backup upload was incomplete.');
          const file = Buffer.concat(chunks, bytes);
          if (action === 'preview') result = await resources.preview(project, binding, ports, file, signal);
          else result = await resources.restore(project, binding, ports, file, req.headers['x-stackforge-preview'],
            Buffer.from(req.headers['x-stackforge-target'] ?? '', 'base64').toString(), signal);
        }
        await operation?.('succeeded');
        return result;
      } catch (error) {
        await operation?.(controller.signal.aborted ? 'cancelled' : 'failed');
        throw error;
      }
    })();
    transfer = { path: project.path, done, controller };
    try {
      const result = await done;
      if (action !== 'backup') return send(res, 200, result);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${result.filename}"`, 'Content-Length': result.data.length });
      return res.end(result.data);
    } catch (error) {
      if (!res.destroyed) return send(res, 409, { error: redactDatabase.text(error.message).split('\n')[0] });
    } finally { transfer = undefined; }
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
    if (isClosing() || transfer || databaseWrites.size || removals.has(project.path) || configWrites.has(project.path) || operations.active(project)) {
      return send(res, 409, { error: 'Wait for the current project operation to finish.' });
    }
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    const record = databaseLog.begin(project, `database-${action}`);
    req.resume();
    const done = operations.databaseBackup(project, projectConfig.ports(project), undefined, controller.signal).then(async result => {
      await record('succeeded');
      return result;
    }, async error => {
      await record(error.name === 'AbortError' || controller.signal.aborted ? 'cancelled' : 'failed');
      throw error;
    });
    transfer = { path: project.path, done, controller };
    try {
      const result = await done;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${result.filename}"`, 'Content-Length': result.data.length });
      return res.end(result.data);
    } catch (error) {
      if (!res.destroyed) return send(res, 409, { error: redactDatabase.text(error.message).split('\n')[0].trim() });
    } finally { transfer = undefined; }
  }

  async function action(req, res, project, action, payload) {
    if (['database-connection-config', 'database-remote-profile', 'database-sqlite-inspect', 'database-sqlite-create'].includes(action)) {
      await resourceAction(req, res, project, action, payload);
      return true;
    }
    if (['database-local-check', 'database-initialization-plan', 'database-initialize'].includes(action)) {
      await localAction(req, res, project, action, payload);
      return true;
    }
    return false;
  }

  async function resourceAction(req, res, project, action, payload) {
    if (databaseWrites.size || transfer || removals.has(project.path) || configWrites.has(project.path) || operations.active(project)) {
      return send(res, 409, { error: 'Wait for the current project operation to finish.' });
    }
    if (action === 'database-sqlite-create' && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      return send(res, 409, { error: 'Stop the project before initializing its database.' });
    }
    if (action === 'database-connection-config' && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      return send(res, 409, { error: 'Stop the project before saving its database connection.' });
    }
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    const done = (async () => {
      if (action === 'database-connection-config') return saveDatabaseEnvironment(project, payload, controller.signal);
      const binding = await resourceBinding(project, payload.bindingId, action === 'database-remote-profile' ? 'remote' : 'sqlite');
      if (action === 'database-remote-profile') return resources.profile(project, binding, payload, controller.signal);
      if (action === 'database-sqlite-inspect') return resources.inspectSqlite(project, binding, controller.signal);
      if (payload.confirmPath !== binding.instance.path) throw new Error('Type the exact SQLite file path to confirm creation.');
      const record = databaseLog.begin(project, 'database-initialize', binding.instanceId);
      try {
        const result = await resources.createSqlite(project, binding, undefined, controller.signal);
        await record('succeeded');
        return result;
      } catch (error) {
        await record(controller.signal.aborted ? 'cancelled' : 'failed');
        throw error;
      }
    })();
    databaseWrites.set(project.path, { done, controller });
    try { return send(res, 200, await done); }
    catch (error) { if (!res.destroyed) return send(res, 409, { error: redactDatabase.text(error.message).split('\n')[0] }); }
    finally { databaseWrites.delete(project.path); }
  }

  async function localAction(req, res, project, action, payload) {
    if (action === 'database-initialize' && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      return send(res, 409, { error: 'Stop the project before initializing its database.' });
    }
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    const work = (async () => {
      const { binding, target } = await localDatabaseTarget(project, payload.bindingId);
      if (action === 'database-local-check') return { installation: await localInstallation(target, localDatabase) };
      const credentials = { user: payload.user, password: payload.password };
      const options = { project, binding, target, credentials, schema: payload.schema === true,
        command: localDatabase.command, signal: controller.signal };
      if (action === 'database-initialization-plan') {
        const inspected = await initializationPlan(options);
        if (inspected.state.fingerprint) await databaseRegistry.verify(binding.instanceId, inspected.state);
        const plan = publicInitializationPlan(inspected);
        if (binding.shared) plan.steps = [];
        return plan;
      }
      const record = databaseLog.begin(project, action, binding.instanceId);
      try {
        const result = await executeInitialization({ ...options, id: payload.planId, confirmName: payload.confirmName,
          revalidate: async () => {
            await refreshDatabaseBindings(project.id, true);
            const current = await localDatabaseTarget(project, binding.id);
            if (current.binding.shared || JSON.stringify(current.target) !== JSON.stringify(target)) {
              throw new Error('A shared or changed database cannot be initialized.');
            }
          },
          recordMigration: (digest, outcome) => databaseRegistry.migration(project.id, binding.instanceId, digest, outcome),
          recordVerification: state => databaseRegistry.verify(binding.instanceId, state)
        });
        await record('succeeded');
        return result;
      } catch (error) {
        await record(error.name === 'AbortError' ? 'cancelled' : 'failed');
        throw error;
      }
    });
    if (action === 'database-initialize') {
      if (databaseWrites.size || transfer || removals.size || operations.active(project) || configWrites.has(project.path)) {
        return send(res, 409, { error: 'Wait for the current project operation to finish.' });
      }
      const done = work();
      databaseWrites.set(project.path, { done, controller });
      try { return send(res, 200, await done); }
      catch (error) { if (!res.destroyed) return send(res, 409, { error: redactDatabase.text(error.message).split('\n')[0] }); }
      finally { databaseWrites.delete(project.path); }
      return;
    }
    try { return send(res, 200, await work()); }
    catch (error) { if (!res.destroyed) return send(res, 409, { error: redactDatabase.text(error.message).split('\n')[0] }); }
  }

  async function shutdown() {
    transfer?.controller.abort();
    for (const { controller } of databaseWrites.values()) controller.abort();
    await Promise.allSettled([transfer?.done, ...[...databaseWrites.values()].map(item => item.done)]);
    await databaseLog.pending;
    await databaseRegistry.pending.catch(() => {});
  }

  function operation(project) {
    if (databaseWrites.has(project.path)) return 'databaseInitialization';
    if (transfer?.path === project.path) return 'databaseTransfer';
  }

  function blocksProjectAction(project, action) {
    return Boolean(operation(project)) || (action === 'database-delete' && databaseWrites.size > 0);
  }

  return { view, archive, action, shutdown, scan: scanDatabases, verifyDeletion: verifyDatabaseDeletion,
    operation, blocksProjectAction, removeProfiles: resources.removeProfiles,
    removeRegistration: id => databaseRegistry.remove(id), record: databaseLog.begin };
}
