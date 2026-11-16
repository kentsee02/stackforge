import { hasNodeBackend } from '../generation/catalog.mjs';
import { discoverDatabases } from '../database/discovery.mjs';
import { findPathExecutable } from '../platform/paths.mjs';
import { portAvailable } from '../platform/ports.mjs';
import { defaultPorts } from './project-config.mjs';
import { developmentScript, inspectRecordedProject } from './project-folder.mjs';
import { resolveStartup } from './project-startup.mjs';

const tools = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'java', 'javac', 'mvn', 'gradle', 'python', 'python3',
  'uv', 'dotnet', 'go', 'cargo', 'php', 'composer', 'ruby', 'bundle', 'docker']);
const active = new Set(['starting', 'running', 'stopping']);

function commandTool(command) {
  const token = /^[a-z][a-z0-9]*(?:\.exe|\.cmd|\.bat)?(?=\s|$)/i.exec(command)?.[0];
  const name = process.platform === 'win32' ? token?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '') : token;
  return tools.has(name) ? token.toLowerCase() : undefined;
}

function databaseChecks({ requirements, limited, connections }) {
  const items = [];
  const guided = new Set(requirements.filter(item => item.guidedSetup)
    .map(item => item.directory + '\0' + item.environmentVariable));
  const seen = new Set();
  for (const requirement of requirements) {
    const { status, kind, engine, directory, source, environmentVariable, guidedSetup, id } = requirement;
    const key = directory + '\0' + environmentVariable;
    if (environmentVariable && guided.has(key) && !guidedSetup) continue;
    if (kind !== 'compose' && !['configured', 'missing', 'placeholder', 'ambiguous'].includes(status)) continue;
    if (status === 'placeholder' && !environmentVariable) continue;
    const issue = { engine, source, ...(environmentVariable && { variable: environmentVariable }),
      action: guidedSetup && ['missing', 'placeholder'].includes(status) ? 'postgres' : 'database',
      ...(guidedSetup && { requirementId: id }) };
    const dedup = source + '\0' + engine + '\0' + environmentVariable;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    if (environmentVariable && ['missing', 'placeholder'].includes(status)) {
      const code = status === 'missing' ? 'database-missing' : 'database-placeholder';
      const definitive = guidedSetup && connections.get(id)?.environmentConflict === false;
      items.push({ ...issue, code, status: definitive ? 'attention' : 'unverified' });
    } else {
      items.push({ ...issue, code: status === 'configured' ? 'database-configured' : 'database-unverified', status: 'unverified' });
    }
  }
  items.sort((a, b) => Number(b.status === 'attention') - Number(a.status === 'attention'));
  if (limited || items.length > 12) items.splice(12, Infinity, { code: 'database-scan-limited', status: 'unverified', action: 'database' });
  else if (!items.length && requirements.length) items.push({ code: 'database-unverified', status: 'unverified', action: 'database' });
  return items;
}

export async function startupPreflight(project, { runtime, operations, ports, findTool = findPathExecutable, probePort = portAvailable }) {
  let identity, folder;
  try {
    ({ identity } = await resolveStartup(project, []));
    if (!project.unmanaged) folder = await inspectRecordedProject(project);
  } catch {
    return { items: [{ code: 'folder-changed', status: 'attention', action: 'import' }] };
  }
  const hasIdentity = Boolean(project.folderIdentity || project.cloneIdentity || project.startup?.identity);
  const items = [hasIdentity ? { code: 'folder-verified', status: 'passed' } : { code: 'folder-unverified', status: 'unverified' }];
  const lookups = new Map();
  const portsToCheck = [];
  const checkTool = async (tool, cwd, detail = {}) => {
    if (!tool) return { ...detail, code: 'command-unverified', status: 'unverified', action: 'startup' };
    const key = cwd + '\0' + tool;
    if (!lookups.has(key)) lookups.set(key, findTool(tool, { cwd }));
    const found = await lookups.get(key);
    return { ...detail, tool, code: found ? 'tool-found' : 'tool-missing', status: found ? 'passed' : 'attention' };
  };
  const checkPort = async (port, detail, action) => {
    if (active.has(runtime.status(project).status)) return { ...detail, port, code: 'port-active', status: 'unverified' };
    const available = await probePort(port);
    if (active.has(runtime.status(project).status)) return { ...detail, port, code: 'port-active', status: 'unverified' };
    return { ...detail, port, code: available ? 'port-free' : 'port-in-use', status: available ? 'passed' : 'attention',
      ...(!available && action && { action }) };
  };

  if (project.unmanaged) {
    const services = project.startup?.services.filter(service => service.command) ?? [];
    if (!services.length) items.push({ code: 'startup-missing', status: 'attention', action: 'startup' });
    for (const service of services) {
      const detail = { service: service.name, directory: service.directory };
      let cwd;
      try { ({ commands: [{ cwd }] } = await resolveStartup(project, [service], identity)); }
      catch { items.push({ ...detail, code: 'working-directory-invalid', status: 'attention', action: 'startup' }); continue; }
      items.push({ ...detail, code: 'startup-verified', status: 'passed' });
      items.push(await checkTool(commandTool(service.command), cwd, detail));
      if (service.port) portsToCheck.push([service.port, detail, 'startup']);
    }
  } else {
    const { directory, manifest } = folder;
    try { await developmentScript(directory); items.push({ code: 'launcher-verified', status: 'passed' }); }
    catch { items.push({ code: 'launcher-missing', status: 'attention' }); }
    const requirements = ['node'];
    if (project.frontend !== 'none' || hasNodeBackend(project.backend)) requirements.push('npm');
    if (project.backend === 'spring') requirements.push('java');
    if (project.database !== 'none') requirements.push('docker');
    items.push(...await Promise.all(requirements.map(tool => checkTool(tool, directory))));
    const effective = { ...defaultPorts(project), ...ports };
    for (const service of ['frontend', 'backend']) {
      if (effective[service]) portsToCheck.push([effective[service], { role: service }, manifest.portConfig === 1 ? 'ports' : undefined]);
    }
  }

  const [discovery, ...portItems] = await Promise.all([
    discoverDatabases(project, { includeConnections: true }).catch(() => null), ...portsToCheck.map(args => checkPort(...args))
  ]);
  items.push(...portItems);
  const { dependencies } = operations.status(project, true);
  const diagnostic = runtime.status(project).diagnostic;
  if (dependencies?.status === 'succeeded') items.push({ code: 'dependencies-installed', status: 'passed', action: 'dependencies' });
  else if (['dependencies', 'pythonDependencies'].includes(diagnostic)) items.push({ code: 'dependencies-missing', status: 'attention', action: 'dependencies' });
  else items.push({ code: 'dependencies-unverified', status: 'unverified', action: 'dependencies' });

  items.push(...(discovery ? databaseChecks(discovery) : [{ code: 'database-unverified', status: 'unverified', action: 'database' }]));
  try { await resolveStartup(project, [], identity); }
  catch { return { items: [{ code: 'folder-changed', status: 'attention', action: 'import' }] }; }
  return { items };
}
