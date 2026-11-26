import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { databaseKey, engineNames, databaseName } from './discovery.mjs';

function localTarget(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}

export function databaseResource(project, requirement, port) {
  const { engine, host, name, path, kind } = requirement;
  if (!Object.hasOwn(engineNames, engine)) return;
  if (requirement.status === 'placeholder' || requirement.status === 'ambiguous') return;
  const provider = kind === 'compose' ? 'docker' : path ? 'sqlite' : host && name ? localTarget(host) ? 'local' : 'remote' : undefined;
  if (!provider) return;
  const serverId = provider === 'sqlite' ? undefined : provider === 'docker' ? databaseKey(provider, project.id, requirement.id) :
    databaseKey(engine, host === 'localhost' ? '127.0.0.1' : host, requirement.port);
  const instanceId = databaseKey(provider, serverId, provider === 'docker' ? undefined : name, path && project.id, path);
  return {
    ...(serverId && { server: { id: serverId, engine, provider, ...(host && { host }), ...(port || requirement.port ? { port: port ?? requirement.port } : {}) } }),
    instance: { id: instanceId, ...(serverId && { serverId }), engine, provider,
      ...(name && databaseName.test(name) && { name }), ...(path && { path }), ownership: provider === 'local' || provider === 'remote' ? 'external' : 'unverified' },
    binding: { id: databaseKey(project.id, requirement.id, instanceId), projectId: project.id, requirementId: requirement.id, instanceId }
  };
}

export class DatabaseRegistry {
  constructor(file) {
    this.file = file;
    this.value = { requirements: {}, servers: {}, instances: {}, bindings: {}, migrations: [], profiles: {}, backups: [], development: {} };
    this.pending = Promise.resolve();
    this.ready = file ? readFile(file, 'utf8').then(text => {
      const data = JSON.parse(text);
      if (data.version === 1 && ['requirements', 'servers', 'instances', 'bindings'].every(key =>
        data[key] && typeof data[key] === 'object' && !Array.isArray(data[key])) && Array.isArray(data.migrations)) {
        this.value = { ...this.value, ...data };
      }
    }).catch(error => { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }) : Promise.resolve();
  }

  update(change) {
    this.pending = this.pending.catch(() => {}).then(async () => {
      await this.ready;
      const next = change(this.value);
      if (JSON.stringify(next) === JSON.stringify(this.value)) return;
      if (this.file) {
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        await mkdir(dirname(this.file), { recursive: true });
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, ...next }), { mode: 0o600 });
          await rename(temporary, this.file);
        } catch (error) {
          await unlink(temporary).catch(() => {});
          throw error;
        }
      }
      this.value = next;
    });
    return this.pending;
  }

  saveDevelopment(projectId, record) {
    return this.update(value => {
      const development = { ...value.development };
      if (record) development[projectId] = record;
      else delete development[projectId];
      return { ...value, development };
    });
  }

  sync(project, requirements, port, verifyRegistration) {
    return this.update(value => {
      verifyRegistration?.();
      const next = { ...value, requirements: { ...value.requirements, [project.id]: requirements },
        servers: { ...value.servers }, instances: { ...value.instances }, bindings: { ...value.bindings } };
      for (const binding of Object.values(next.bindings)) if (binding.projectId === project.id) delete next.bindings[binding.id];
      for (const requirement of requirements) {
        const resource = databaseResource(project, requirement, requirement.kind === 'compose' ? port : undefined);
        if (!resource) continue;
        const { server, instance, binding } = resource;
        if (server) next.servers[server.id] = server;
        const prior = next.instances[instance.id];
        next.instances[instance.id] = { ...instance, ...(prior?.verification && { verification: prior.verification }) };
        next.bindings[binding.id] = binding;
      }
      const instances = new Set(Object.values(next.bindings).map(binding => binding.instanceId));
      for (const id of Object.keys(next.instances)) if (!instances.has(id)) delete next.instances[id];
      const servers = new Set(Object.values(next.instances).map(instance => instance.serverId));
      for (const id of Object.keys(next.servers)) if (!servers.has(id)) delete next.servers[id];
      return next;
    });
  }

  view(project, activeIds) {
    const { requirements, servers, instances, bindings, migrations } = this.value;
    const all = Object.values(bindings).filter(item => !activeIds || activeIds.has(item.projectId));
    return {
      requirements: requirements[project.id] ?? [],
      bindings: all.filter(binding => binding.projectId === project.id && instances[binding.instanceId]).map(binding => {
        const instance = instances[binding.instanceId];
        const server = servers[instance.serverId];
        const projects = [...new Set(all.filter(item => {
          if (item.instanceId === binding.instanceId) return true;
          const other = instances[item.instanceId];
          const otherServer = servers[other?.serverId];
          return instance.provider === 'local' && other?.provider === 'local' && other.engine === instance.engine &&
            other.name === instance.name && otherServer?.port === server?.port && localTarget(otherServer?.host) && localTarget(server?.host);
        }).map(item => item.projectId))];
        return { ...binding, instance, server: servers[instance.serverId], shared: projects.length > 1, projects };
      }),
      migrations: migrations.filter(item => item.projectId === project.id)
    };
  }

  async overview(projects) {
    await this.ready;
    const { requirements, development, instances, bindings } = this.value;
    const projectIds = new Set(projects.map(project => project.id));
    const verification = new Map();
    for (const binding of Object.values(bindings)) {
      const status = instances[binding?.instanceId]?.verification?.status;
      if (projectIds.has(binding?.projectId) && ['connected', 'missing'].includes(status)) verification.set(binding.requirementId, status);
    }
    const precedence = { attention: 0, connected: 1, development: 2, configured: 3, declared: 4 };
    return projects.flatMap(project => {
      const rows = new Map();
      const add = (engine, status, target, variant) => {
        if (!Object.hasOwn(engineNames, engine)) return;
        const key = variant ?? engine;
        const previous = rows.get(key);
        if (!previous || precedence[status] < precedence[previous.status]) {
          rows.set(key, { projectId: project.id, engine: variant === 'turso' ? 'Turso' : variant === 'mariadb' ? 'MariaDB' : engineNames[engine], status, target });
        }
      };
      const detected = Array.isArray(requirements[project.id]) ? requirements[project.id] : [];
      for (const entry of detected) {
        if (!entry) continue;
        const verified = verification.get(entry.id);
        const example = typeof entry.source === 'string' && /(?:^|\/)\.env\.example$/.test(entry.source);
        const issue = verified === 'missing' || (!example && ['missing', 'placeholder', 'ambiguous'].includes(entry.status));
        const status = issue ? 'attention' : verified === 'connected' ? 'connected' : entry.status === 'configured' ? 'configured' : 'declared';
        add(entry.engine, status, entry.kind === 'compose' && entry.directory === '.' && ['postgres', 'mysql'].includes(entry.engine) ? 'controls' : 'discovery',
          ['mariadb', 'turso'].includes(entry.variant) ? entry.variant : undefined);
      }
      add(project.database, 'declared', 'controls');
      const dedicated = development?.[project.id];
      if (dedicated) add(dedicated.engine ?? 'postgres', dedicated.created && !dedicated.deleting ? 'development' : 'attention', 'development');
      return [...rows.values()];
    }).sort((a, b) => precedence[a.status] - precedence[b.status]);
  }

  profile(projectId, instanceId) {
    return this.value.profiles[databaseKey(projectId, instanceId)];
  }

  saveProfile(projectId, instanceId, profile) {
    return this.update(value => {
      const profiles = { ...value.profiles };
      const key = databaseKey(projectId, instanceId);
      if (profile) profiles[key] = { ...profile, projectId, instanceId };
      else delete profiles[key];
      return { ...value, profiles };
    });
  }

  recordBackup(projectId, instanceId, metadata) {
    return this.update(value => ({ ...value, backups: [...value.backups, { projectId, instanceId, ...metadata }].slice(-500) }));
  }

  usesEndpoint(projectId, { engine, host, port, name }, activeIds) {
    const addresses = new Set(['localhost', '127.0.0.1', '::1', hostname().toLowerCase(),
      ...Object.values(networkInterfaces()).flatMap(interfaces => (interfaces ?? []).map(item => item.address.toLowerCase()))]);
    const wildcard = ['0.0.0.0', '::'].includes(host);
    return Object.values(this.value.bindings).some(binding => {
      const instance = this.value.instances[binding.instanceId];
      const server = this.value.servers[instance?.serverId];
      return binding.projectId !== projectId && (!activeIds || activeIds.has(binding.projectId)) && server?.engine === engine && server.port === port &&
        (!name || !instance.name || instance.name === name) &&
        (server.host === host || localTarget(host) && localTarget(server.host) || wildcard && addresses.has(server.host));
    });
  }

  migration(projectId, instanceId, digest, status) {
    return this.update(value => ({ ...value, migrations: [...value.migrations,
      { projectId, instanceId, digest, status, at: new Date().toISOString() }].slice(-500) }));
  }

  verify(instanceId, state) {
    return this.update(value => {
      const instance = value.instances[instanceId];
      if (!instance) return value;
      const verification = {
        status: state.exists ? 'connected' : 'missing',
        version: state.version,
        ...(typeof state.empty === 'boolean' && { empty: state.empty })
      };
      return { ...value, instances: { ...value.instances, [instanceId]: { ...instance, verification } } };
    });
  }

  remove(projectId) {
    return this.update(value => {
      const requirements = { ...value.requirements };
      delete requirements[projectId];
      const bindings = Object.fromEntries(Object.entries(value.bindings).filter(([, item]) => item.projectId !== projectId));
      const ids = new Set(Object.values(bindings).map(item => item.instanceId));
      const instances = Object.fromEntries(Object.entries(value.instances).filter(([id]) => ids.has(id)));
      const serverIds = new Set(Object.values(instances).map(item => item.serverId));
      const servers = Object.fromEntries(Object.entries(value.servers).filter(([id]) => serverIds.has(id)));
      return { ...value, requirements, bindings, instances, servers };
    });
  }
}
