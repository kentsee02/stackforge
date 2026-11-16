import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { databaseRedactor } from './security/secrets.mjs';
import { databaseOperationLog } from './security/operation-log.mjs';
import { databaseResources } from './resources.mjs';
import { databaseVault } from './security/vault.mjs';
import { DatabaseRegistry } from './registry.mjs';
import { localInstallation, validateLocalTarget } from './adapters/local.mjs';
import { executeInitialization, initializationPlan, publicInitializationPlan } from './initialization.mjs';
import { saveDatabaseEnvironment } from './environment.mjs';
import { postgresSetup } from './prisma-setup.mjs';
import { defaultPorts, projectPathKey } from '../projects/project-config.mjs';
import { locationExists } from '../platform/paths.mjs';
import { commandDiagnostic } from '../projects/project-diagnostics.mjs';
import { discoverDatabases } from './discovery.mjs';

export function createDatabaseWorkflows({ stateDir, operations, databaseAdapters, projectConfig, managedProjects,
  runtime, removals, configWrites, localDatabase, isClosing }) {
  const redactDatabase = databaseRedactor(process.env);
  const databaseLog = databaseOperationLog(stateDir ? join(dirname(stateDir), 'database-operations.jsonl') : false);
  const databaseRegistry = new DatabaseRegistry(stateDir ? join(dirname(stateDir), 'databases.json') : undefined);
  const stagingRoot = stateDir ? join(dirname(stateDir), 'stackforge-backup-work') : tmpdir();
  const resources = databaseResources({ registry: databaseRegistry, operations,
    directory: stagingRoot,
    vault: databaseVault(stateDir ? join(dirname(stateDir), 'credentials') : undefined), ...databaseAdapters });
  const databaseWrites = new Map();
  let transfer;

  async function scanDatabases(project, discovery, activeIds) {
    const { requirements, limited } = discovery ?? await discoverDatabases(project);
    const recorded = requirements.map(({ environmentEdit, ...item }) => item);
    await databaseRegistry.sync(project, recorded, projectConfig.ports(project).database ?? defaultPorts(project).database, () => {
      if (!managedProjects().some(item => item.id === project.id && projectPathKey(item.path) === projectPathKey(project.path))) {
        throw new Error('The project registration has changed. Refresh Projects and try again.');
      }
    });
    return { ...databaseRegistry.view(project, activeIds), requirements, limited };
  }

  async function refreshDatabaseBindings(except, strict = false) {
    const activeIds = new Set([except]);
    for (const other of managedProjects().filter(item => item.id !== except)) {
      if (!await locationExists(other.path)) continue;
      activeIds.add(other.id);
      try {
        const scan = await scanDatabases(other);
        if (strict && scan.limited) throw new Error();
      } catch {
        if (strict) throw new Error('StackForge could not verify whether another project uses this database.');
      }
    }
    return activeIds;
  }

  async function localDatabaseTarget(project, bindingId, activeIds) {
    const { bindings } = await scanDatabases(project, undefined, activeIds);
    const binding = bindings.find(item => item.id === bindingId);
    const target = validateLocalTarget(binding?.server, binding?.instance);
    return { binding, target };
  }

  async function resourceBinding(project, id, provider, activeIds) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Choose an available database binding.');
    const { bindings, requirements } = await scanDatabases(project, undefined, activeIds);
    const binding = bindings.find(item => item.id === id && (!provider || item.instance.provider === provider));
    if (!binding) throw new Error('Choose an available database binding.');
    if (binding.instance.provider === 'docker' && project.unmanaged) {
      const selection = requirements.find(item => item.id === binding.requirementId);
      if (composeSelection(selection)) return { ...binding, selection };
    }
    return binding;
  }

  const composeSelection = item => item?.kind === 'compose' && item.directory === '.' && ['postgres', 'mysql'].includes(item.engine);

  async function selectedCompose(project, id) {
    const binding = await resourceBinding(project, id, 'docker');
    if (!binding.selection) throw new Error('Choose an available database binding.');
    return binding.selection;
  }

  async function verifyDatabaseDeletion(project, volumeTarget) {
    await scanDatabases(project);
    if (volumeTarget.endpoints?.length) {
      const activeIds = await refreshDatabaseBindings(project.id, true);
      if (volumeTarget.endpoints.some(endpoint => databaseRegistry.usesEndpoint(project.id, endpoint, activeIds))) {
        throw new Error('Another project uses this database. Shared databases cannot be deleted from StackForge.');
      }
    }
  }

  async function verifyRestoreTarget(project, target, binding) {
    if (!binding && !target.endpoints?.length) return;
    const activeIds = await refreshDatabaseBindings(project.id, true);
    const current = binding && await resourceBinding(project, binding.id, undefined, activeIds);
    if (current?.shared || target.endpoints?.some(endpoint => databaseRegistry.usesEndpoint(project.id, endpoint, activeIds))) {
      throw new Error('Another project uses this database. Shared databases cannot be restored from StackForge.');
    }
  }

  async function inspect(project, view, { includeCapabilities, logs, requested }) {
    if (view === 'database-discovery') {
      const activeIds = await refreshDatabaseBindings(project.id);
      const discovery = await scanDatabases(project, undefined, activeIds);
      return { ...discovery, bindings: discovery.bindings.map(item => ({
        ...item, ...(item.instance.provider === 'remote' && {
          profileSaved: Boolean(databaseRegistry.profile(project.id, item.instanceId))
        })
      })) };
    }
    if (view === 'database-delete') {
      if (['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
        throw new Error('Stop the project before deleting its database.');
      }
      const target = await operations.databaseDeletionTarget(project, projectConfig.ports(project));
      const { volume } = target;
      await verifyDatabaseDeletion(project, target);
      return { volume };
    }
    let selection, services, binding;
    if (project.unmanaged) {
      const { requirements, bindings } = await scanDatabases(project);
      const options = requirements.filter(composeSelection).map(item => ({
        id: bindings.find(binding => binding.requirementId === item.id)?.id, name: item.key, engine: item.engine, selection: item
      })).filter(item => item.id);
      services = options.map(({ id, name, engine }) => ({ id, name, engine }));
      const target = requested ? options.find(item => item.id === requested) : options[0];
      if (requested && !target) throw new Error('Choose an available database binding.');
      selection = target?.selection;
      binding = target?.id;
    }
    let result;
    try { result = await operations.database(project, projectConfig.ports(project), logs, includeCapabilities, selection); }
    catch (error) {
      if ((services?.length ?? 0) < 2) throw error;
      const message = redactDatabase.text(error.message);
      return { services, binding, error: message.split('\n')[0].trim(), diagnostic: commandDiagnostic(message) };
    }
    if (services?.length) Object.assign(result, { services, binding });
    if (includeCapabilities && result.capabilities.restore) {
      try { await verifyRestoreTarget(project, result); }
      catch (error) {
        result.capabilities.restore = false;
        result.restoreHint = redactDatabase.text(error.message).split('\n')[0];
      }
    }
    if (includeCapabilities && result.capabilities.delete) {
      try { await verifyDatabaseDeletion(project, result); }
      catch (error) {
        result.capabilities.delete = false;
        result.deleteHint = redactDatabase.text(error.message).split('\n')[0];
      }
    }
    delete result.endpoints;
    return result;
  }

  function transferBlocked(project) {
    return isClosing() || transfer || databaseWrites.size || removals.has(project.path) || configWrites.has(project.path) || operations.active(project);
  }

  function trackTransfer(project, controller, done) {
    const active = { path: project.path, done, controller };
    transfer = active;
    return { done, release() { if (transfer === active) transfer = undefined; } };
  }

  function startArchive(project, action, controller, { bindingId, temporaryFile, receiveBackup, approval, confirmedTarget }) {
    const { signal } = controller;
    const done = (async () => {
      const binding = bindingId ? await resourceBinding(project, bindingId) : undefined;
      const ports = projectConfig.ports(project);
      const record = action === 'preview' ? undefined : databaseLog.begin(project, 'database-' + action, binding?.instanceId);
      try {
        let result;
        if (action === 'backup') {
          result = await resources.backup(project, binding, ports, signal, await temporaryFile());
        } else {
          const verify = target => verifyRestoreTarget(project, target, binding);
          const prepared = action === 'preview' && await resources.preparePreview(project, binding, ports, signal, verify);
          const file = await receiveBackup();
          if (action === 'preview') result = await resources.preview(project, binding, ports, file, signal, verify, prepared);
          else result = await resources.restore(project, binding, ports, file, approval, confirmedTarget, signal, verify);
        }
        await record?.('succeeded');
        return result;
      } catch (error) {
        await record?.(signal.aborted ? 'cancelled' : 'failed');
        throw error;
      }
    })();
    return trackTransfer(project, controller, done);
  }

  function startLegacyBackup(project, controller) {
    const record = databaseLog.begin(project, 'database-backup');
    const done = operations.databaseBackup(project, projectConfig.ports(project), undefined, controller.signal).then(async result => {
      await record('succeeded');
      return result;
    }, async error => {
      await record(error.name === 'AbortError' || controller.signal.aborted ? 'cancelled' : 'failed');
      throw error;
    });
    return trackTransfer(project, controller, done);
  }

  async function trackWrite(project, controller, done) {
    databaseWrites.set(project.path, { done, controller });
    try { return await done; }
    finally { databaseWrites.delete(project.path); }
  }

  async function resourceAction(project, action, payload, controller) {
    if (databaseWrites.size || transfer || removals.has(project.path) || configWrites.has(project.path) || operations.active(project)) {
      throw new Error('Wait for the current project operation to finish.');
    }
    if (action === 'database-sqlite-create' && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      throw new Error('Stop the project before initializing its database.');
    }
    const setupWrites = action === 'database-postgres-setup' && ['create', 'save', 'migrate'].includes(payload.mode);
    if ((action === 'database-connection-config' || setupWrites) && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      throw new Error('Stop the project before saving its database connection.');
    }
    const done = (async () => {
      if (action === 'database-connection-config') return saveDatabaseEnvironment(project, payload, controller.signal);
      if (action === 'database-postgres-setup') {
        const verifyTarget = async target => {
          const activeIds = await refreshDatabaseBindings(project.id, true);
          if (databaseRegistry.usesEndpoint(project.id, target, activeIds)) {
            throw new Error('Another project uses this PostgreSQL database. Choose a separate database for guided setup.');
          }
        };
        const record = setupWrites ? databaseLog.begin(project, payload.mode === 'migrate' ? 'database-migrate' : 'database-initialize') : undefined;
        try {
          const result = await postgresSetup({ project, payload, command: localDatabase.command, prismaCommand: databaseAdapters.prismaCommand,
            installation: { ...localDatabase, directory: stagingRoot },
            signal: controller.signal, verifyTarget });
          await record?.(['check', 'configure', 'ready'].includes(result.status) ? 'succeeded' : 'failed');
          return result;
        } catch (error) {
          await record?.(controller.signal.aborted ? 'cancelled' : 'failed');
          throw error;
        }
      }
      if (action === 'database-local-status') return resources.testLocalConnection(project, await resourceBinding(project, payload.bindingId, 'local'), controller.signal);
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
    return trackWrite(project, controller, done);
  }

  async function localAction(project, action, payload, controller) {
    if (action === 'database-initialize' && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      throw new Error('Stop the project before initializing its database.');
    }
    const work = (async () => {
      const activeIds = await refreshDatabaseBindings(project.id);
      const { binding, target } = await localDatabaseTarget(project, payload.bindingId, activeIds);
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
            const activeIds = await refreshDatabaseBindings(project.id, true);
            const current = await localDatabaseTarget(project, binding.id, activeIds);
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
        throw new Error('Wait for the current project operation to finish.');
      }
      return trackWrite(project, controller, work());
    }
    return work();
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

  async function cleanupReplacedClone(id) {
    const project = { id };
    const record = databaseLog.begin(project, 'database-profile-cleanup');
    try {
      await resources.removeProfiles(project);
      await databaseRegistry.remove(id);
      await record('succeeded');
    } catch (error) {
      await record('failed');
      throw error;
    }
  }

  return { inspect, resourceAction, localAction, startArchive, startLegacyBackup, transferBlocked, stagingRoot,
    redact: redactDatabase.text, shutdown, scan: scanDatabases, verifyDeletion: verifyDatabaseDeletion, selectedCompose,
    operation, blocksProjectAction, cleanupReplacedClone, removeProfiles: resources.removeProfiles,
    removeRegistration: id => databaseRegistry.remove(id), record: databaseLog.begin };
}
