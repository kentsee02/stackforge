import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { absoluteDirectory } from './paths.mjs';
import { validateOptions } from './catalog.mjs';
import { detectFrameworks, validFrameworks } from './project-detection.mjs';
import { recordedIdentity } from './project-identity.mjs';

export const projectPathKey = path => process.platform === 'win32' ? path.toLowerCase() : path;

export function importedProject(id, path, source) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid project record.');
  path = absoluteDirectory(path);
  const cloned = /^[a-f0-9]{32}$/.test(source?.cloneId ?? '') ? { cloneId: source.cloneId, cloneIdentity: recordedIdentity(source.cloneIdentity) } : {};
  if (source?.unmanaged === true || source?.external === true) return {
    id, path, name: basename(path) || path, frontend: 'none', backend: 'none', database: 'none',
    imported: true, unmanaged: true, frameworks: validFrameworks(source.frameworks), ...cloned
  };
  if (!['name', 'frontend', 'backend', 'database'].every(key => typeof source?.[key] === 'string')) throw new Error('Invalid project record.');
  const { name, frontend, backend, database } = validateOptions({ name: source.name, parentDir: dirname(path), frontend: source.frontend, backend: source.backend, database: source.database, install: false, git: false });
  return { id, path, name, frontend, backend, database, imported: true, folderIdentity: recordedIdentity(source.folderIdentity), ...cloned };
}

export function defaultPorts(project) {
  return {
    ...(project.frontend !== 'none' && { frontend: 5173 }),
    ...(project.backend !== 'none' && { backend: 8080 }),
    ...(project.database !== 'none' && { database: project.database === 'mysql' ? 3306 : 5432 })
  };
}

export function validatePorts(project, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter valid project ports.');
  const defaults = defaultPorts(project);
  const ports = {};
  for (const [name, port] of Object.entries(input)) {
    if (!Object.hasOwn(defaults, name) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Enter a port from 1024 to 65535.');
    ports[name] = port;
  }
  const effective = Object.values({ ...defaults, ...ports });
  if (new Set(effective).size !== effective.length) throw new Error('Use a different port for each service.');
  return ports;
}

export class ProjectConfig {
  constructor(file) {
    this.file = file;
    this.value = { ports: {}, imports: [] };
    this.pending = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== 1) return;
      if (saved.ports && typeof saved.ports === 'object') this.value.ports = saved.ports;
      if (Array.isArray(saved.imports)) for (const project of saved.imports) {
        try {
          const imported = importedProject(project.id, project.path, project);
          if (imported.unmanaged) imported.frameworks = await detectFrameworks(imported.path);
          this.value.imports.push(imported);
        }
        catch { /* ignore a single damaged project record */ }
      }
    } catch { /* a missing or damaged file should not block startup */ }
  }

  ports(project) {
    try { return validatePorts(project, this.value.ports[project.id] ?? {}); }
    catch { return {}; }
  }

  savePorts(project, ports) {
    return this.update(value => ({ ...value, ports: { ...value.ports, [project.id]: ports } }));
  }

  async addProject(project) {
    await this.update(value => {
      if (value.imports.some(item => projectPathKey(item.path) === projectPathKey(project.path))) throw new Error('This folder is already in Projects.');
      return { ...value, imports: [project, ...value.imports] };
    });
  }

  removeImport(id) {
    return this.update(value => ({ ...value, imports: value.imports.filter(item => item.id !== id) }));
  }

  update(change) {
    const writing = this.pending.catch(() => {}).then(async () => {
      await this.ready;
      const next = change(this.value);
      if (this.file) {
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = this.file + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, JSON.stringify({ version: 1, ...next }), { mode: 0o600 });
        await rename(temporary, this.file);
      }
      this.value = next;
    });
    this.pending = writing;
    return writing;
  }
}
