import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { detectBackendLaunchers } from './backend-startup.mjs';
import { inspectNode } from './node-project.mjs';
import { detectManifestFrameworks, localText, mavenLauncher, npmManifest, validFrameworks, workspaceFolders, workspaceSegments } from './project-detection.mjs';
import { resolveStartup } from './project-startup.mjs';

const serviceFolders = ['frontend', 'backend', 'client', 'server', 'web', 'api', 'apps/*', 'packages/*',
  'services/*', 'src/*', 'backend/*', 'server/*', 'cmd/*', 'backend/cmd/*', 'server/cmd/*', 'services/*/cmd/*', 'apps/*/cmd/*', '*'];

export function childOf(folder, root) {
  const path = relative(root, folder);
  return Boolean(path) && !isAbsolute(path) && path.split(sep)[0] !== '..';
}

export async function scanProjectServices(project) {
  const saved = project.startup;
  const { root, identity } = await resolveStartup(project, [], saved?.identity ?? project.cloneIdentity);
  const budget = { left: 2048 };
  const pending = new Set([root, ...await workspaceFolders(root, serviceFolders, budget)]);
  for (const service of saved?.services ?? []) {
    const resolved = await resolveStartup(project, [service], identity).catch(() => null);
    if (resolved) pending.add(resolved.commands[0].cwd);
  }

  const services = new Map(), owners = new Map(), opaqueWorkspaces = [];
  while (pending.size && services.size < 96) {
    const folder = [...pending].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    pending.delete(folder);
    if (services.has(folder)) continue;
    const actual = await realpath(folder).catch(() => null);
    if (!actual || relative(folder, actual)) continue;
    const [manifestText, pomText] = await Promise.all([localText(folder, 'package.json'), localText(folder, 'pom.xml')]);
    const parsed = npmManifest(manifestText);
    const manifest = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    const node = manifest && await inspectNode(folder, manifest);
    const pom = pomText.replace(/<!--[\s\S]*?-->/g, '');
    const modules = [...pom.matchAll(/<modules\b[^>]*>([\s\S]*?)<\/modules>/g)].flatMap(([, text]) =>
      [...text.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map(match => match[1]));
    const patterns = node?.patterns;
    const unknownWorkspace = patterns === null || Boolean(patterns && (patterns.length > 32 || patterns.some(pattern => !workspaceSegments(pattern))));
    const members = [...await workspaceFolders(folder, patterns?.slice(0, 32) ?? [], budget)].filter(path => path !== folder);
    const inherited = owners.get(folder)?.manager;
    const managerConflict = node?.conflict || Boolean(node?.tool && inherited && node.tool !== inherited);
    const manager = managerConflict ? undefined : node?.tool ?? inherited;
    const workspaceMember = owners.has(folder) || opaqueWorkspaces.some(parent => childOf(folder, parent));
    const directory = relative(root, folder).replaceAll('\\', '/') || '.';
    services.set(folder, { folder, directory, manifestText, manifest, node, manager, managerConflict, pom,
      workspaceMember, unknownWorkspace, members: unknownWorkspace ? [] : members });
    if (unknownWorkspace) opaqueWorkspaces.push(folder);
    else for (const member of members) owners.set(member, { manager });
    const mavenModules = await workspaceFolders(folder, modules.slice(0, 32).filter(path => !path.includes('*')), budget);
    for (const child of [...members, ...mavenModules]) if (!services.has(child)) pending.add(child);
  }
  return { root, identity, services: [...services.values()], limited: pending.size > 0 || budget.left <= 0 };
}

export async function detectFrameworks(project) {
  const { root, services } = await scanProjectServices(project);
  const frameworks = [];
  for (const { folder, manifest, pom } of services) {
    const [labels, { launchers }] = await Promise.all([detectManifestFrameworks(folder, manifest, pom), detectBackendLaunchers(folder, root)]);
    frameworks.push(...labels, mavenLauncher(pom)?.framework, ...launchers.map(({ name }) => name));
  }
  return validFrameworks(frameworks);
}
