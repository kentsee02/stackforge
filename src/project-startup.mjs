import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { directoryIdentity, sameDirectory } from './project-identity.mjs';

export function validateStartup(input) {
  if (!Array.isArray(input) || input.length > 6) throw new Error('Configure up to six startup services.');
  const names = new Set();
  const ports = new Set();
  return input.map(service => {
    const { name, directory, command, port } = service ?? {};
    const label = typeof name === 'string' ? name.trim() : '';
    const folder = typeof directory === 'string' ? directory.trim().replaceAll('\\', '/') || '.' : '';
    const script = typeof command === 'string' ? command.trim() : '';
    if (!label || label.length > 40 || /[\x00-\x1f\x7f]/.test(name) || names.has(label.toLowerCase())) throw new Error('Enter a unique service name of up to 40 characters.');
    if (!folder || folder.length > 240 || /[:\x00-\x1f\x7f]/.test(directory) || isAbsolute(folder) || win32.isAbsolute(folder) || folder.split('/').includes('..')) throw new Error('Use a working directory inside the project.');
    if (!script || script.length > 500 || /[\x00-\x1f\x7f]/.test(command)) throw new Error('Enter a single-line startup command of up to 500 characters.');
    if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535 || ports.has(port))) throw new Error('Use a different HTTP port from 1024 to 65535 for each service.');
    names.add(label.toLowerCase());
    if (port !== undefined) ports.add(port);
    return { name: label, directory: folder, command: script, ...(port !== undefined && { port }) };
  });
}

export async function resolveStartup(project, services, expectedIdentity) {
  const changed = 'The startup project folder was moved or replaced. Import it again to configure startup.';
  const info = await lstat(project.path, { bigint: true }).catch(() => null);
  const identity = info && directoryIdentity(info);
  if (!identity || (expectedIdentity && !sameDirectory(info, expectedIdentity))) throw new Error(changed);
  const root = await realpath(project.path);
  const commands = await Promise.all(services.map(async service => {
    const cwd = await realpath(resolve(root, service.directory)).catch(() => null);
    const within = cwd && relative(root, cwd);
    if (!cwd || within.split(/[\\/]/)[0] === '..' || isAbsolute(within) || !(await stat(cwd).catch(() => null))?.isDirectory()) {
      throw new Error('Choose an existing working directory inside the project.');
    }
    return { ...service, cwd };
  }));
  return { identity, commands };
}
