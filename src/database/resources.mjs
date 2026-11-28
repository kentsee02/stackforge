import { randomUUID } from 'node:crypto';
import { archiveBackup, archiveDigest, archiveFile, fileDigest, inspectArchive, inspectArchiveFile, inspectLegacyBackup,
  isLegacyBackup, isLegacyFileBackup, legacyFileBackup } from './backup/archive.mjs';
import { isBackupFile } from './backup/payload.mjs';
import { databaseInventory, databaseTransferCapabilities, transferDatabase } from './backup/docker-transfer.mjs';
import { databaseKey } from './discovery.mjs';
import { remoteProfile, remoteSession } from './adapters/remote.mjs';
import { localTransferSession } from './adapters/local-transfer.mjs';
import { inspectLocalConnection } from './adapters/local-status.mjs';
import { sqliteAdapter, sqliteTarget } from './adapters/sqlite.mjs';
import { verifyBackupImage, verifySqlRestore } from './backup/restore-check.mjs';

const changed = 'The restore preview or confirmed database target has changed.';
const missing = 'Choose an available database binding.';

export function databaseResources({ registry, vault, directory, operations, command, resolveLocalClient, resolveDedicated, verifyRestore = verifySqlRestore,
  preflight = verifyRestore === verifySqlRestore ? verifyBackupImage : undefined }) {
  const sqlite = sqliteAdapter(directory);
  const previews = new Map();
  const profileFor = (project, binding) => registry.profile(project.id, binding.instanceId);

  async function configured(project, binding) {
    const profile = profileFor(project, binding);
    if (!profile) throw new Error('Save a remote database connection profile first.');
    const target = await remoteProfile(binding.server, binding.instance, profile);
    return { profile, target };
  }

  async function remote(project, binding, signal) {
    const { profile, target } = await configured(project, binding);
    const password = await vault.read(profile.credentialRef);
    return { session: remoteSession(target, password, { command, signal }), credentialRef: profile.credentialRef };
  }

  async function profile(project, binding, payload, signal) {
    const stored = profileFor(project, binding);
    if (payload.mode === 'remove') {
      if (stored) {
        await vault.remove(stored.credentialRef);
        await registry.saveProfile(project.id, binding.instanceId);
      }
      return { saved: false };
    }
    if (payload.mode === 'test') return (await remote(project, binding, signal)).session.test();
    if (payload.mode !== 'save') throw new Error('Choose a supported connection profile action.');
    const target = await remoteProfile(binding.server, binding.instance, payload);
    const status = await remoteSession(target, payload.password, { command, signal }).test();
    const credentialRef = await vault.save(payload.password);
    try {
      await registry.saveProfile(project.id, binding.instanceId, { user: target.user, ca: target.ca, credentialRef });
    } catch (error) {
      await vault.remove(credentialRef).catch(() => {});
      throw error;
    }
    if (stored) await vault.remove(stored.credentialRef).catch(() => {});
    return { saved: true, ...status };
  }

  async function removeProfiles(project) {
    await registry.ready;
    const saved = Object.values(registry.value.profiles).filter(item => item.projectId === project.id);
    for (const profile of saved) {
      await vault.remove(profile.credentialRef);
      await registry.saveProfile(project.id, profile.instanceId);
    }
  }

  async function adapter(project, binding, ports, signal) {
    const provider = binding?.instance.provider ?? 'docker';
    if (provider === 'sqlite') {
      const info = await sqlite.inspect(project, binding, signal);
      const version = info.details?.version ?? (await sqlite.verify(await sqlite.empty(signal), signal)).version;
      return { engine: 'sqlite', version, name: info.path, identity: (await sqliteTarget(project, binding)).key,
        canRestore: info.capabilities.restore, export: () => sqlite.backup(project, binding, signal),
        check: async data => {
          const details = await sqlite.verify(data, signal);
          return { objects: [details.digest], count: details.count, limited: details.limited };
        },
        restore: data => sqlite.install(project, binding, data, signal),
        inventory: async () => {
          const { details } = await sqlite.inspect(project, binding, signal);
          return { objects: [details.digest], count: details.count, limited: details.limited };
        }
      };
    }
    if (provider === 'remote' || provider === 'local') {
      const { session, credentialRef } = provider === 'local' ? await localTransferSession(project, binding, command, signal, resolveLocalClient) :
        await remote(project, binding, signal);
      const state = await session.test();
      const identity = state.identity && databaseKey(state.identity, credentialRef);
      return { engine: binding.instance.engine, name: binding.instance.name, version: state.version, identity,
        canRestore: state.capabilities.restore, export: session.backup, inventory: session.inventory,
        restore: data => session.restore(data, state.identity) };
    }
    if (provider !== 'development' && (provider !== 'docker' || binding && (!project.unmanaged || !binding.selection))) throw new Error(missing);
    const target = provider === 'development' ? await resolveDedicated(project, binding.id, signal) :
      await operations.databaseTarget(project, ports, signal, binding?.selection);
    if (provider === 'development' && target.engine === 'sqlserver') return target;
    if (target.container?.status !== 'running') throw new Error('Start the project database before backing it up or restoring it.');
    const options = { engine: target.engine, container: target.container.id, config: target.config, command: target.command ?? operations.command, signal, project: project.name };
    const inventory = () => databaseInventory(options);
    const [{ version }, capabilities] = await Promise.all([inventory(), databaseTransferCapabilities(options)]);
    return { engine: target.engine, name: target.name ?? (binding ? `${project.name}/${target.service}` : project.name), version, identity: target.container.id, inventory, endpoints: target.endpoints,
      canRestore: capabilities.restore, export: backupFile => transferDatabase({ ...options, backupFile }),
      restore: data => transferDatabase({ ...options, file: data }) };
  }

  async function testLocalConnection(project, binding, signal) {
    if (!['postgres', 'mysql'].includes(binding.instance.engine)) return inspectLocalConnection(project, binding, command, signal);
    const { session } = await localTransferSession(project, binding, command, signal, resolveLocalClient);
    const { version, capabilities, restoreHint } = await session.test();
    return { version, capabilities, restoreHint };
  }

  async function backup(project, binding, ports, signal, backupFile) {
    const target = await adapter(project, binding, ports, signal);
    const prepared = !target.check && await preflight?.({ engine: target.engine, version: target.version, signal });
    const dump = await target.export(backupFile);
    const payload = { data: dump.data, engine: target.engine, version: target.version, project: project.name, signal };
    const archive = isBackupFile(dump.data) ? await archiveFile(payload) : archiveBackup(payload);
    const restored = target.check ? await target.check(dump.data) :
      await verifyRestore({ engine: target.engine, version: target.version, data: dump.data, signal, prepared });
    if (target.engine !== 'sqlite') {
      const source = await target.inventory();
      if (databaseKey([...source.objects].sort()) !== databaseKey([...restored.objects].sort())) {
        throw new Error('The backup objects did not match the source database. Check privileges or retry after schema changes finish.');
      }
    }
    await registry.recordBackup(project.id, binding?.instanceId, archive.metadata);
    return archive;
  }

  async function preparePreview(project, binding, ports, signal, verify) {
    const target = await adapter(project, binding, ports, signal);
    if (!target.canRestore || !target.identity || (!verify && binding?.shared)) throw new Error(target.engine === 'sqlserver' ?
      'SQL Server restore requires a verified empty project database.' : 'Choose a verified empty database or a missing SQLite file.');
    await verify?.(target);
    const prepared = !target.check && await preflight?.({ engine: target.engine, version: target.version, signal });
    return { target, prepared };
  }

  async function preview(project, binding, ports, file, signal, verify, prechecked) {
    const { target, prepared } = prechecked ?? await preparePreview(project, binding, ports, signal, verify);
    const large = isBackupFile(file);
    const legacy = large ? await isLegacyFileBackup(file, target.engine) : isLegacyBackup(file, target.engine);
    const archive = legacy ? { data: file } : large ? await inspectArchiveFile(file, target.engine, target.version, signal) :
      inspectArchive(file, target.engine, target.version);
    const verified = target.check ? await target.check(archive.data) :
      await verifyRestore({ engine: target.engine, version: target.version, data: archive.data, legacy, signal, prepared });
    const metadata = archive.metadata ?? verified.legacyMetadata;
    const id = randomUUID();
    for (const [key, record] of previews) if (record.expires <= Date.now()) previews.delete(key);
    if (previews.size >= 32) previews.delete(previews.keys().next().value);
    previews.set(id, { project: project.id, instance: binding?.instanceId, identity: target.identity, name: target.name,
      digest: large ? await fileDigest(file, signal) : archiveDigest(file), expected: verified.objects, limited: verified.limited,
      legacyVersion: legacy ? metadata.version : undefined,
      expires: Date.now() + 300000 });
    return { id, name: target.name, metadata, objects: verified.count ?? verified.objects.length, limited: Boolean(verified.limited) };
  }

  async function restore(project, binding, ports, file, id, name, signal, verify) {
    const approved = previews.get(id);
    const large = isBackupFile(file);
    if (!approved || approved.expires <= Date.now() || approved.project !== project.id || approved.instance !== binding?.instanceId ||
        approved.name !== name || approved.digest !== (large ? await fileDigest(file, signal) : archiveDigest(file)) ||
        (!verify && binding?.shared)) throw new Error(changed);
    const target = await adapter(project, binding, ports, signal);
    if (target.identity !== approved.identity || target.name !== approved.name || !target.canRestore) throw new Error(changed);
    const archive = approved.legacyVersion ? (large ? await legacyFileBackup(file, target.engine, approved.legacyVersion, target.version, signal) :
      inspectLegacyBackup(file, target.engine, approved.legacyVersion, target.version)) :
      (large ? await inspectArchiveFile(file, target.engine, target.version, signal) : inspectArchive(file, target.engine, target.version));
    await verify?.(target);
    previews.delete(id);
    await target.restore(archive.data);
    const result = await target.inventory();
    if (databaseKey([...result.objects].sort(), Boolean(result.limited)) !== databaseKey([...approved.expected].sort(), Boolean(approved.limited))) {
      throw new Error('Restore finished, but the target database objects did not match the isolated verification.');
    }
    return { restored: true, objects: result.count ?? result.objects.length, limited: Boolean(result.limited) };
  }

  return { profile, removeProfiles, backup, preparePreview, preview, restore, testLocalConnection,
    inspectSqlite: sqlite.inspect, createSqlite: sqlite.install };
}
