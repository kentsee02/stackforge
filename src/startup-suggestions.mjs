import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { inspectNode } from './dependency-plan.mjs';
import { conventional, findMavenWrapper, localText, npmManifest, workspaceFolders, workspaceSegments } from './project-detection.mjs';
import { resolveStartup } from './project-startup.mjs';

const startupScripts = ['dev', 'start:dev', 'serve', 'start'];
const webScript = /^(?:vite|next\s+(?:dev|start)|nuxt\s+dev|react-router\s+dev|react-router-serve)(?:\s|$)/;

function startupPort(script) {
  if (!webScript.test(script) || /[;&|$<>`\r\n]/.test(script)) return;
  const flags = [...script.matchAll(/(?:^|\s)--port(?:=|\s+)([^\s]+)/g)];
  if (flags.length !== 1 || !/^\d+$/.test(flags[0][1])) return;
  const port = Number(flags[0][1]);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
}

function suggestedName(name, folder) {
  return name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40) || basename(folder).slice(0, 40);
}

async function springPort(folder) {
  const resources = join(folder, 'src', 'main', 'resources');
  const actual = await realpath(resources).catch(() => null);
  if (!actual || !childOf(actual, folder)) return;
  const [properties, ...yaml] = await Promise.all(['application.properties', 'application.yml', 'application.yaml'].map(file => localText(actual, file)));
  const values = [...properties.matchAll(/^[ \t]*server\.port[ \t]*[:=][ \t]*([^\r\n]*)/gm)].map(match => match[1].trim());
  for (const text of yaml) {
    const blocks = text.matchAll(/^server:[ \t]*(?:#[^\r\n]*)?\r?\n((?:[ \t][^\r\n]*\r?\n?)*)/gm);
    for (const [, block] of blocks) {
      const entries = block.split(/\r?\n/).filter(line => /^ +[^ #]/.test(line));
      const indent = Math.min(...entries.map(line => line.search(/\S/)));
      for (const line of entries) {
        if (line.search(/\S/) !== indent) continue;
        const port = /^\s*port:\s*(.*)$/.exec(line);
        if (port) values.push(port[1].replace(/\s+#.*$/, '').trim());
      }
    }
  }
  if (!values.length || values.some(value => !/^\d+$/.test(value))) return;
  const port = Number(values[0]);
  if (port >= 1024 && port <= 65535 && values.every(value => Number(value) === port)) return port;
}

async function springSuggestion(folder, root, pom) {
  const ownPom = pom.replace(/<(parent|pluginManagement|profiles)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  if (/<packaging>\s*pom\s*<\/packaging>/.test(ownPom) || !/<plugin\b[^>]*>(?:(?!<\/plugin>)[\s\S])*?<artifactId>\s*spring-boot-maven-plugin\s*<\/artifactId>/.test(ownPom)) return;
  const [launcher, port] = await Promise.all([findMavenWrapper(folder, root), springPort(folder)]);
  const name = suggestedName(/<artifactId>\s*([^<]+)<\/artifactId>/.exec(ownPom)?.[1] ?? '', folder);
  const directory = relative(root, folder).replaceAll('\\', '/') || '.';
  return { name, directory, choices: [{ command: (launcher ?? 'mvn') + ' spring-boot:run', script: 'spring-boot:run', kind: 'api', source: 'pom.xml · spring-boot-maven-plugin', ...(port && { port }) }] };
}

function workspaceScript(script, hasTurbo) {
  if (/^npm\s+run\s+[\w:-]+\s+--workspaces(?:\s+--if-present)?$/.test(script)) return true;
  if (/^pnpm\s+(?:-r|--recursive)\s+(?:--parallel\s+)?(?:run\s+)?[\w:-]+$/.test(script)) return true;
  return hasTurbo && /^turbo\s+(?:run\s+)?[\w:-]+(?:\s+--parallel)?$/.test(script);
}

function childOf(folder, root) {
  const path = relative(root, folder);
  return Boolean(path) && !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
}

export async function detectStartupSuggestions(project) {
  const { root, identity } = await resolveStartup(project, [], project.startup?.identity ?? project.cloneIdentity);
  const budget = { left: 2048 };
  const folders = new Set([root, ...await workspaceFolders(root, [...conventional, 'services/*'], budget)]);
  for (const service of project.startup?.services ?? []) {
    const result = await resolveStartup(project, [service], identity).catch(() => null);
    if (result) folders.add(result.commands[0].cwd);
  }

  const scanned = new Set(), records = new Map(), owner = new Map(), java = [];
  while (folders.size && scanned.size < 96) {
    const folder = [...folders].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    folders.delete(folder);
    if (scanned.has(folder)) continue;
    scanned.add(folder);
    const [packageText, pomText] = await Promise.all([localText(folder, 'package.json'), localText(folder, 'pom.xml')]);
    const pom = pomText.replace(/<!--[\s\S]*?-->/g, '');
    const spring = await springSuggestion(folder, root, pom);
    if (spring) java.push(spring);
    const modules = [...pom.matchAll(/<modules\b[^>]*>([\s\S]*?)<\/modules>/g)].flatMap(([, text]) =>
      [...text.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map(match => match[1]));
    for (const module of await workspaceFolders(folder, modules.slice(0, 32).filter(path => !path.includes('*')), budget)) {
      if (!scanned.has(module)) folders.add(module);
    }
    const manifest = npmManifest(packageText);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    const { tool, conflict, patterns } = await inspectNode(folder, manifest);
    const inherited = owner.get(folder)?.tool;
    const manager = conflict || (tool && inherited && tool !== inherited) ? undefined : tool ?? inherited;
    const unknownWorkspace = patterns === null || patterns.length > 32 || patterns.some(pattern => !workspaceSegments(pattern));
    const members = unknownWorkspace ? [] : [...await workspaceFolders(folder, patterns, budget)].filter(path => path !== folder);
    const directory = relative(root, folder).replaceAll('\\', '/') || '.';
    const name = suggestedName(typeof manifest.name === 'string' ? manifest.name.split('/').at(-1) : '', folder);
    const scripts = manifest.scripts;
    const turbo = members.length && await localText(folder, 'turbo.json');
    const choices = [];
    if (manager) for (const script of startupScripts) {
      const value = scripts?.[script];
      if (typeof value !== 'string' || !value.trim()) continue;
      const text = value.trim();
      const port = startupPort(text);
      const kind = webScript.test(text) ? 'web' : /^nest\s+start(?:\s|$)/.test(text) ? 'api' : undefined;
      choices.push({ command: manager + ' run ' + script, script,
        ...(port && { port }), ...(kind && { kind }), ...(members.length && workspaceScript(text, Boolean(turbo)) && { orchestrates: true }) });
    }
    records.set(folder, { directory, name, choices, members, unknownWorkspace });
    for (const member of members) {
      owner.set(member, { tool: manager });
      if (!scanned.has(member)) folders.add(member);
    }
  }

  const groups = java, suppressed = new Set();
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
