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
import { developmentDatabase } from './docker/development-database.mjs';
import { previewDrizzle } from './migrations/drizzle-preview.mjs';
import { previewAlembic } from './migrations/alembic-preview.mjs';
import { compareAlembicHistory } from './migrations/alembic-history.mjs';
import { scanEfCore } from './migrations/ef-core-preview.mjs';
import { compareEfCoreHistory, efCoreHistoryTable } from './migrations/ef-core-history.mjs';
import { postgresHistoryTargets } from './migrations/postgres-history.mjs';
import { previewFlyway } from './migrations/flyway-preview.mjs';
import { previewLiquibase } from './migrations/liquibase-preview.mjs';
import { postgresHistoryTable } from './migrations/postgres-history-table.mjs';
import { compareSqlMigrationHistory } from './migrations/sql-migration-history.mjs';
import { sqlServerHistoryTable, sqlServerHistoryTargets } from './migrations/sql-server-history.mjs';
import { mysqlHistoryTable, mysqlHistoryTargets } from './migrations/mysql-history.mjs';
import { nativeSqlMigration } from './migrations/native-sql-migrations.mjs';

export function createDatabaseWorkflows({ stateDir, operations, databaseAdapters, projectConfig, managedProjects,
  runtime, removals, configWrites, localDatabase, isClosing }) {
  const redactDatabase = databaseRedactor(process.env);
  const databaseLog = databaseOperationLog(stateDir ? join(dirname(stateDir), 'database-operations.jsonl') : false);
  const databaseRegistry = new DatabaseRegistry(stateDir ? join(dirname(stateDir), 'databases.json') : undefined);
  const stagingRoot = stateDir ? join(dirname(stateDir), 'stackforge-backup-work') : tmpdir();
  const databaseWrites = new Map();
  const development = developmentDatabase({ registry: databaseRegistry, ...databaseAdapters.developmentPostgres,
    async verifyShared(project, endpoint) {
      const activeIds = await refreshDatabaseBindings(project.id, true);
      if (databaseRegistry.usesEndpoint(project.id, endpoint, activeIds)) {
        throw new Error('Another project uses this database. Shared databases cannot be deleted from StackForge.');
      }
    }
  });
  const resources = databaseResources({ registry: databaseRegistry, operations, directory: stagingRoot,
    vault: databaseVault(stateDir ? join(dirname(stateDir), 'credentials') : undefined), ...databaseAdapters,
    resolveLocalClient: development.client, resolveDedicated: development.archiveTarget });
  let transfer;

  async function scanDatabases(project, discovery, activeIds) {
    const { requirements, migrationSources, limited } = discovery ?? await discoverDatabases(project);
    const recorded = requirements.map(({ environmentEdit, ...item }) => item);
    await databaseRegistry.sync(project, recorded, projectConfig.ports(project).database ?? defaultPorts(project).database, () => {
      if (!managedProjects().some(item => item.id === project.id && projectPathKey(item.path) === projectPathKey(project.path))) {
        throw new Error('The project registration has changed. Refresh Projects and try again.');
      }
    });
    return { ...databaseRegistry.view(project, activeIds), requirements, limited, ...(migrationSources && { migrationSources }) };
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
    if (!provider) {
      const dedicated = await development.archiveBinding(project, id);
      if (dedicated) return dedicated;
    }
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
    if (view === 'database-development') return development.inspect(project);
    if (view === 'database-discovery') {
      const activeIds = await refreshDatabaseBindings(project.id);
      const [scanned, ef] = await Promise.all([
        discoverDatabases(project, { includeMigrations: true, includeConnections: true }),
        scanEfCore(project)
      ]);
      const discovery = await scanDatabases(project, scanned, activeIds);
      const alembicTargets = [], efCoreTargets = [], sqlMigrationTargets = [];
      const hasAlembic = scanned.migrationSources.some(source => source.adapter === 'alembic');
      const hasSqlMigrations = scanned.migrationSources.some(source => ['flyway', 'liquibase'].includes(source.adapter));
      if (hasAlembic || ef.sources.length || hasSqlMigrations) {
        const container = await development.historyTarget(project).catch(() => undefined);
        if (hasAlembic || hasSqlMigrations) {
          const targets = postgresHistoryTargets(scanned).map(item => item.public);
          if (container) targets.unshift(container);
          if (hasAlembic) alembicTargets.push(...targets);
          if (hasSqlMigrations) {
            const mysql = await development.historyTarget(project, 'mysql').catch(() => undefined);
            sqlMigrationTargets.push(...targets, ...(mysql ? [mysql] : []), ...mysqlHistoryTargets(scanned).map(item => item.public));
          }
        }
        if (ef.sources.length) {
          if (container) efCoreTargets.push(container);
          efCoreTargets.push(...postgresHistoryTargets(scanned, { efCore: true }).map(item => item.public));
          efCoreTargets.push(...sqlServerHistoryTargets(scanned).map(item => item.public));
        }
      }
      return { ...discovery, alembicTargets, efCoreTargets, sqlMigrationTargets, migrationSources: [...scanned.migrationSources, ...ef.sources], migrationScanLimited: ef.limited,
        bindings: discovery.bindings.map(item => ({
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
    if (action === 'database-native-migration') {
      const execute = payload.mode === 'execute';
      if (execute && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
        throw new Error('Stop the project before applying database migrations.');
      }
      const { signal } = controller;
      const run = async () => {
        const record = execute ? databaseLog.begin(project, payload.operation === 'rollback' ? 'database-rollback' : 'database-migrate') : undefined;
        try {
          const selection = await development.historyTarget(project);
          if (!selection || selection.id !== payload.targetId) throw new Error('Choose the project-owned PostgreSQL database for native migrations.');
          const { engine, host, name, port } = selection;
          const target = { engine, host, name, port };
          const client = await development.client(project, target, signal, selection.id);
          const result = await nativeSqlMigration({ project, payload, target, client, signal, directory: stagingRoot,
            async verifyShared(endpoint) {
              const activeIds = await refreshDatabaseBindings(project.id, true);
              if (databaseRegistry.usesEndpoint(project.id, endpoint, activeIds)) throw new Error('A shared database cannot be migrated from StackForge.');
            } });
          await record?.(['applied', 'rolled-back'].includes(result.status) ? 'succeeded' : 'failed');
          return result;
        } catch (error) {
          await record?.(signal.aborted ? 'cancelled' : 'failed');
          throw error;
        }
      };
      return execute ? trackWrite(project, controller, run()) : run();
    }
    if (action === 'database-flyway-preview' || action === 'database-liquibase-preview') {
      const flyway = action === 'database-flyway-preview';
      const { sourceId, targetId, schema, table } = payload;
      const { signal } = controller;
      if (targetId === undefined) return (flyway ? previewFlyway : previewLiquibase)(project, sourceId, signal);
      const scanned = await discoverDatabases(project, { includeMigrations: true, includeConnections: true });
      const source = scanned.migrationSources.find(item => item.id === sourceId && item.adapter === (flyway ? 'flyway' : 'liquibase'));
      if (!source) throw new Error('Choose a detected migration configuration.');
      const scan = await (flyway ? previewFlyway : previewLiquibase)(project, sourceId, signal, { history: flyway, scanned });
      const preview = scan.result ?? scan;
      if (preview.status !== 'ready') return preview;
      const invalid = 'Choose an available migration database and rescan if it changed.';
      const options = await historySelection(project, targetId, signal, scanned, invalid, { mysql: true });
      const defaultTable = flyway ? 'flyway_schema_history' :
        options.selection.engine === 'mysql' ? 'DATABASECHANGELOG' : 'databasechangelog';
      const history = options.selection.engine === 'mysql' ?
        mysqlHistoryTable(options.selection.name, table === undefined ? defaultTable : table) :
        postgresHistoryTable(schema, table, defaultTable);
      const resourcePrefix = [source.directory === '.' ? '' : source.directory, source.resourceRoot].filter(Boolean).join('/');
      const database = await compareSqlMigrationHistory({ adapter: source.adapter, preview, history, checksums: scan.checksums,
        resourcePrefix: resourcePrefix ? resourcePrefix + '/' : '', ...options });
      return { ...preview, database };
    }
    if (action === 'database-ef-core-preview') {
      const { signal } = controller;
      const { targetId, groupId, schema, table } = payload;
      const preview = await scanEfCore(project, { sourceId: payload.sourceId ?? null, signal });
      if (targetId === undefined || preview.status !== 'ready') return preview;
      const group = preview.groups.find(item => item.id === groupId);
      if (!group) throw new Error('Choose a verified EF Core DbContext and rescan if it changed.');
      const invalid = 'Choose an available EF Core database target and rescan if it changed.';
      const scanned = await discoverDatabases(project, { includeConnections: true });
      const options = await historySelection(project, targetId, signal, scanned, invalid, { efCore: true });
      const history = (options.selection.engine === 'sqlserver' ? sqlServerHistoryTable : efCoreHistoryTable)(schema, table);
      const database = await compareEfCoreHistory({ group, history, ...options });
      return { ...preview, database };
    }
    if (action === 'database-alembic-preview') {
      const { signal } = controller;
      const { sourceId, targetId, schema, table } = payload;
      if (targetId === undefined) return previewAlembic(project, sourceId, signal);
      const invalid = 'Choose an available Alembic PostgreSQL target and rescan if it changed.';
      if (typeof targetId !== 'string' || !/^[a-f0-9]{64}$/.test(targetId)) throw new Error(invalid);
      const scanned = await discoverDatabases(project, { includeMigrations: true, includeConnections: true });
      const preview = await previewAlembic(project, sourceId, signal, scanned);
      if (preview.status !== 'ready') return preview;
      const options = await historySelection(project, targetId, signal, scanned, invalid);
      const history = postgresHistoryTable(schema, table, 'alembic_version');
      const database = await compareAlembicHistory({ revisions: preview.revisions, history, ...options });
      return { ...preview, database };
    }
    if (action === 'database-drizzle-preview' || action === 'database-drizzle-apply') {
      const { signal } = controller;
      const options = { project, requirementId: payload.requirementId, command: localDatabase.command,
        resolveClient: target => development.client(project, target, signal), probe: localDatabase.probe, signal };
      if (action === 'database-drizzle-preview') return previewDrizzle(options);
      if (['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
        throw new Error('Stop the project before applying database migrations.');
      }
      const record = databaseLog.begin(project, 'database-migrate');
      const done = previewDrizzle({ ...options, approval: payload, async verifyTarget(target) {
        const activeIds = await refreshDatabaseBindings(project.id, true);
        if (databaseRegistry.usesEndpoint(project.id, target, activeIds)) {
          throw new Error('Another project uses this PostgreSQL database. Choose a separate database for guided setup.');
        }
      } }).then(async result => {
        await record(result.status === 'applied' ? 'succeeded' : 'failed');
        return result;
      }, async error => {
        await record(signal.aborted ? 'cancelled' : 'failed');
        throw error;
      });
      return trackWrite(project, controller, done);
    }
    if (action === 'database-sqlite-create' && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      throw new Error('Stop the project before initializing its database.');
    }
    const setupWrites = action === 'database-postgres-setup' && ['create', 'save', 'migrate'].includes(payload.mode);
    const developmentWrite = action === 'database-development' && payload.mode !== 'preview';
    if (action === 'database-development' && !developmentWrite) return development.action(project, payload, controller.signal);
    if ((action === 'database-connection-config' || setupWrites || developmentWrite) &&
        ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      throw new Error(developmentWrite ? 'Stop the project before changing its dedicated PostgreSQL instance.' :
        'Stop the project before saving its database connection.');
    }
    const done = (async () => {
      if (action === 'database-development') {
        const record = developmentWrite ? databaseLog.begin(project, 'database-development-' + payload.mode) : undefined;
        try {
          const result = await development.action(project, payload, controller.signal);
          await record?.('succeeded');
          return result;
        } catch (error) {
          await record?.(controller.signal.aborted ? 'cancelled' : 'failed');
          throw error;
        }
      }
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
            resolveClient: target => development.client(project, target, controller.signal),
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

  async function historySelection(project, targetId, signal, scanned, invalid, options) {
    if (typeof targetId !== 'string' || !/^[a-f0-9]{64}$/.test(targetId)) throw new Error(invalid);
    const local = [...postgresHistoryTargets(scanned, options),
      ...(options?.efCore ? sqlServerHistoryTargets(scanned) : []),
      ...(options?.mysql ? mysqlHistoryTargets(scanned) : [])].find(item => item.public.id === targetId);
    let selection = local?.public;
    if (!selection) {
      for (const engine of options?.mysql ? ['postgres', 'mysql'] : ['postgres']) {
        const container = await development.historyTarget(project, engine).catch(() => undefined);
        if (container?.id === targetId) { selection = container; break; }
      }
    }
    if (!selection) throw new Error(invalid);
    return { selection, credentials: local?.credentials, sslmode: local?.sslmode,
      command: localDatabase.command, probe: localDatabase.probe, signal,
      async resolveClient(target) {
        try { return await development.client(project, target, signal, selection.projectPostgres || selection.projectMysql ? selection.id : undefined); }
        catch (error) {
          if (error.name === 'AbortError') throw error;
          throw Object.assign(new Error(invalid), { code: 'target-changed' });
        }
      }
    };
  }

  async function localAction(project, action, payload, controller) {
    if (action === 'database-initialize' && ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) {
      throw new Error('Stop the project before initializing its database.');
    }
    const work = (async () => {
      const activeIds = await refreshDatabaseBindings(project.id);
      const { binding, target } = await localDatabaseTarget(project, payload.bindingId, activeIds);
      const client = await development.client(project, target, controller.signal);
      if (action === 'database-local-check') return { installation: client ? await client.installation(localDatabase.probe) :
        await localInstallation(target, localDatabase) };
      const credentials = { user: payload.user, password: payload.password };
      const options = { project, binding, target, credentials, schema: payload.schema === true,
        command: client?.command ?? localDatabase.command, signal: controller.signal };
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
    removeRegistration: id => databaseRegistry.remove(id), record: databaseLog.begin,
    guardDevelopmentRemoval: development.guardRemoval };
}
