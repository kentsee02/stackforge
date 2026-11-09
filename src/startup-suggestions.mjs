import { basename, relative } from 'node:path';
import { inspectNode } from './dependency-plan.mjs';
import { conventional, localText, npmManifest, workspaceFolders, workspaceSegments } from './project-detection.mjs';
import { resolveStartup } from './project-startup.mjs';

const startupScripts = ['dev', 'start:dev', 'serve', 'start'];

function startupPort(script) {
  if (!/^(?:vite|next\s+(?:dev|start)|nuxt\s+dev)(?:\s|$)/.test(script) || /[;&|$<>`\r\n]/.test(script)) return;
  const flags = [...script.matchAll(/(?:^|\s)--port(?:=|\s+)([^\s]+)/g)];
  if (flags.length !== 1 || !/^\d+$/.test(flags[0][1])) return;
  const port = Number(flags[0][1]);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
}

function workspaceScript(script, hasTurbo) {
  if (/^npm\s+run\s+[\w:-]+\s+--workspaces(?:\s+--if-present)?$/.test(script)) return true;
  if (/^pnpm\s+(?:-r|--recursive)\s+(?:--parallel\s+)?(?:run\s+)?[\w:-]+$/.test(script)) return true;
  return hasTurbo && /^turbo\s+(?:run\s+)?[\w:-]+(?:\s+--parallel)?$/.test(script);
}

function childOf(folder, root) {
  const path = relative(root, folder);
  return Boolean(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
}

export async function detectStartupSuggestions(project) {
  const { root, identity } = await resolveStartup(project, [], project.startup?.identity ?? project.cloneIdentity);
  const budget = { left: 2048 };
  const folders = new Set([root, ...await workspaceFolders(root, conventional, budget)]);
  for (const service of project.startup?.services ?? []) {
    const result = await resolveStartup(project, [service], identity).catch(() => null);
    if (result) folders.add(result.commands[0].cwd);
  }

  const scanned = new Set(), records = new Map(), owner = new Map();
  while (folders.size && scanned.size < 96) {
    const folder = [...folders].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    folders.delete(folder);
    if (scanned.has(folder)) continue;
    scanned.add(folder);
    const manifest = npmManifest(await localText(folder, 'package.json'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    const { tool, conflict, patterns } = await inspectNode(folder, manifest);
    const inherited = owner.get(folder)?.tool;
    const manager = conflict || (tool && inherited && tool !== inherited) ? undefined : tool ?? inherited;
    const unknownWorkspace = patterns === null || patterns.length > 32 || patterns.some(pattern => !workspaceSegments(pattern));
    const members = unknownWorkspace ? [] : [...await workspaceFolders(folder, patterns, budget)].filter(path => path !== folder);
    const directory = relative(root, folder).replaceAll('\\', '/') || '.';
    const name = (typeof manifest.name === 'string' ? manifest.name.split('/').at(-1) : '')
      .replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40) || basename(folder).slice(0, 40);
    const scripts = manifest.scripts;
    const turbo = members.length && await localText(folder, 'turbo.json');
    const choices = [];
    if (manager) for (const script of startupScripts) {
      const value = scripts?.[script];
      if (typeof value !== 'string' || !value.trim()) continue;
      const text = value.trim();
      const port = startupPort(text);
      choices.push({ command: manager + ' run ' + script, script,
        ...(port && { port }), ...(members.length && workspaceScript(text, Boolean(turbo)) && { orchestrates: true }) });
    }
    records.set(folder, { directory, name, choices, members, unknownWorkspace });
    for (const member of members) {
      owner.set(member, { tool: manager });
      if (!scanned.has(member)) folders.add(member);
    }
  }

  const groups = [], suppressed = new Set();
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
  return { groups: groups.slice(0, 12), limited: folders.size > 0 || budget.left <= 0 || groups.length > 12 };
}
