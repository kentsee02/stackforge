import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { databaseKey, engineNames, sqlName } from './database-discovery.mjs';

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
      ...(name && sqlName.test(name) && { name }), ...(path && { path }), ownership: provider === 'local' || provider === 'remote' ? 'external' : 'unverified' },
    binding: { id: databaseKey(project.id, requirement.id, instanceId), projectId: project.id, requirementId: requirement.id, instanceId }
  };
}

export class DatabaseRegistry {
  constructor(file) {
    this.file = file;
    this.value = { requirements: {}, servers: {}, instances: {}, bindings: {}, migrations: [] };
    this.pending = Promise.resolve();
    this.ready = file ? readFile(file, 'utf8').then(text => {
      const data = JSON.parse(text);
      if (data.version === 1 && ['requirements', 'servers', 'instances', 'bindings'].every(key =>
        data[key] && typeof data[key] === 'object' && !Array.isArray(data[key])) && Array.isArray(data.migrations)) this.value = data;
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
        await writeFile(temporary, JSON.stringify({ version: 1, ...next }), { mode: 0o600 });
        await rename(temporary, this.file);
      }
      this.value = next;
    });
    return this.pending;
  }

  sync(project, requirements, port) {
    return this.update(value => {
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

  view(project) {
    const { requirements, servers, instances, bindings, migrations } = this.value;
    const all = Object.values(bindings);
    return {
      requirements: requirements[project.id] ?? [],
      bindings: all.filter(binding => binding.projectId === project.id && instances[binding.instanceId]).map(binding => {
        const instance = instances[binding.instanceId];
        const projects = [...new Set(all.filter(item => item.instanceId === binding.instanceId).map(item => item.projectId))];
        return { ...binding, instance, server: servers[instance.serverId], shared: projects.length > 1, projects };
      }),
      migrations: migrations.filter(item => item.projectId === project.id)
    };
  }

  usesEndpoint(projectId, { engine, host, port }) {
    const addresses = new Set(['localhost', '127.0.0.1', '::1', hostname().toLowerCase(),
      ...Object.values(networkInterfaces()).flatMap(interfaces => (interfaces ?? []).map(item => item.address.toLowerCase()))]);
    const wildcard = ['0.0.0.0', '::'].includes(host);
    return Object.values(this.value.bindings).some(binding => {
      const instance = this.value.instances[binding.instanceId];
      const server = this.value.servers[instance?.serverId];
      return binding.projectId !== projectId && server?.engine === engine && server.port === port &&
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
