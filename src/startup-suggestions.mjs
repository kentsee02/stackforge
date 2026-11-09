import { basename } from 'node:path';
import { detectBackendLaunchers } from './backend-startup.mjs';
import { findMavenWrapper, localText, mavenLauncher } from './project-detection.mjs';
import { childOf, scanProjectServices } from './project-services.mjs';
import { jvmEndpoint, nodeApiEndpoint, webEndpoint } from './startup-endpoints.mjs';

const startupScripts = ['dev', 'start:dev', 'serve', 'start'];
const webScript = /^(?:vite|next\s+(?:dev|start)|(?:nuxt|nuxi)\s+dev|ng\s+serve|react-router\s+dev|react-router-serve)(?:\s|$)/;
const nodeBackendDependencies = ['@nestjs/core', 'express', 'fastify', 'koa', 'hono', '@hono/node-server'];

function nodeServiceKind(manifest, script) {
  if (webScript.test(script)) return 'web';
  if (/^nest\s+start(?:\s|$)/.test(script)) return 'api';
  if (/^(?:node|tsx|ts-node|nodemon|bun|wrangler\s+dev)(?:\s|$)/.test(script) &&
      nodeBackendDependencies.some(name => ['dependencies', 'devDependencies', 'optionalDependencies'].some(key =>
        typeof manifest[key]?.[name] === 'string' && manifest[key][name].trim()))) return 'api';
}

function suggestedName(name, folder) {
  return name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40) || basename(folder).slice(0, 40);
}

async function mavenSuggestion({ folder, directory, pom }, root) {
  const launcherInfo = mavenLauncher(pom);
  if (!launcherInfo) return;
  const { artifact, plugin, script, framework } = launcherInfo;
  const [launcher, { port, openPath }] = await Promise.all([findMavenWrapper(folder, root), jvmEndpoint(folder, framework)]);
  const name = suggestedName(artifact, folder);
  return { name, directory, choices: [{ command: (launcher ?? 'mvn') + ' ' + script, script, kind: 'api', source: 'pom.xml · ' + plugin, ...(port && { port }), ...(openPath && { openPath }) }] };
}

function workspaceScript(script, hasTurbo) {
  if (/^npm\s+run\s+[\w:-]+\s+--workspaces(?:\s+--if-present)?$/.test(script)) return true;
  if (/^pnpm\s+(?:-r|--recursive)\s+(?:--parallel\s+)?(?:run\s+)?[\w:-]+$/.test(script)) return true;
  return hasTurbo && /^turbo\s+(?:run\s+)?[\w:-]+(?:\s+--parallel)?$/.test(script);
}

export async function detectStartupSuggestions(project) {
  const { root, services, limited } = await scanProjectServices(project);
  const detectedEntries = new Set(), records = new Map(), groups = [];
  for (const service of services) {
    const { folder, directory, manifest, manager, members, unknownWorkspace } = service;
    const [maven, { declared, launchers }] = await Promise.all([mavenSuggestion(service, root), detectBackendLaunchers(folder, root)]);
    if (maven) groups.push(maven);
    for (const { name, choice, entryPath } of declared ? [declared] : launchers) {
      if (entryPath && detectedEntries.has(entryPath)) continue;
      if (entryPath) detectedEntries.add(entryPath);
      if (name === 'Spring Boot' && maven?.choices[0].script === 'spring-boot:run') continue;
      groups.push({ name, directory, choices: [choice] });
    }
    if (!manifest) continue;
    const name = suggestedName(typeof manifest.name === 'string' ? manifest.name.split('/').at(-1) : '', folder);
    const scripts = manifest.scripts;
    const turbo = members.length && await localText(folder, 'turbo.json');
    const choices = [];
    if (manager) for (const script of startupScripts) {
      const value = scripts?.[script];
      if (typeof value !== 'string' || !value.trim()) continue;
      const text = value.trim();
      const kind = nodeServiceKind(manifest, text);
      const { port, openPath } = kind === 'web' ? await webEndpoint(folder, text) : kind === 'api' ? await nodeApiEndpoint(folder, text) : {};
      choices.push({ command: manager + ' run ' + script, script,
        ...(port && { port }), ...(openPath && { openPath }), ...(kind && { kind }), ...(members.length && workspaceScript(text, Boolean(turbo)) && { orchestrates: true }) });
    }
    records.set(folder, { directory, name, choices, members, unknownWorkspace });
  }

  const suppressed = new Set();
  for (const [folder, record] of records) {
    if (suppressed.has(folder) || !record.choices.length) continue;
    const orchestrators = record.choices.filter(choice => choice.orchestrates);
    if (orchestrators.length) {
      for (const member of record.members) suppressed.add(member);
      groups.push({ directory: record.directory, name: record.name, choices: orchestrators });
    } else if (!record.members.some(member => records.get(member)?.choices.length) &&
        !((folder === root || record.unknownWorkspace) && [...records].some(([candidate, item]) => item.choices.length && childOf(candidate, folder)))) {
      groups.push({ directory: record.directory, name: record.name, choices: record.choices });
    }
  }
  return { groups: groups.slice(0, 12), limited: limited || groups.length > 12 };
}
