import { createHash } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { conventional, declaredWorkspaces, localText, npmManifest, workspaceFolders, workspaceSegments } from './project-detection.mjs';
import { resolveStartup } from './project-startup.mjs';

const managers = {
  npm: ['npm-shrinkwrap.json', 'package-lock.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb']
};

const fileInfo = (directory, name) => lstat(join(directory, name)).catch(() => null);
const regularFile = async (directory, name) => (await fileInfo(directory, name))?.isFile() === true;
const shownFolder = (root, path) => relative(root, path).replaceAll('\\', '/') || '.';

function pnpmWorkspaces(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^packages\s*:/.test(line));
  if (start === -1) return ['**'];
  if (!/^packages\s*:\s*(?:#.*)?$/.test(lines[start])) return null;
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^\s*-\s+(?:'([^']+)'|"([^"]+)"|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (match) {
      const pattern = match[1] ?? match[2] ?? match[3];
      if (!/^[\p{L}\p{N}@._*/-]+$/u.test(pattern) || patterns.length >= 32) return null;
      patterns.push(pattern);
    } else if (/^\S/.test(line)) break;
    else return null;
  }
  return patterns;
}

async function inspectNode(directory, manifest) {
  const [locks, workspace] = await Promise.all([
    Promise.all(Object.entries(managers).map(async ([tool, names]) => {
      const files = await Promise.all(names.map(name => fileInfo(directory, name)));
      return { tool, file: names[files.findIndex(Boolean)], unsafe: files.some(file => file && !file.isFile()) };
    })),
    regularFile(directory, 'pnpm-workspace.yaml')
  ]);
  const candidates = locks.filter(lock => lock.file);
  const pin = typeof manifest.packageManager === 'string'
    ? /^(npm|pnpm|yarn|bun)@(\d+)\.\d+\.\d+(?:[-+][\w.+-]+)?$/.exec(manifest.packageManager)
    : null;
  const locked = candidates[0];
  const tool = pin?.[1] ?? locked?.tool ?? (workspace ? 'pnpm' : undefined);
  const patterns = workspace ? pnpmWorkspaces(await localText(directory, 'pnpm-workspace.yaml')) : declaredWorkspaces(manifest);
  const metadata = { patterns };
  if (candidates.length > 1 || candidates.some(lock => lock.unsafe) ||
      (locked && pin && locked.tool !== tool) || (workspace && tool !== 'pnpm') ||
      (manifest.packageManager !== undefined && !pin)) {
    return { ...metadata, issue: 'Package manager declarations and lockfiles conflict or are unsupported.' };
  }
  if (!tool) return { ...metadata, issue: 'No package manager is declared and no supported lockfile was found.' };

  let args = ['install'];
  if (locked) {
    if (tool === 'npm') args = ['ci'];
    else if (tool === 'yarn') {
      const text = await localText(directory, 'yarn.lock');
      const classic = pin ? pin[2] === '1' : /^# yarn lockfile v1\b/m.test(text);
      const modern = pin ? Number(pin[2]) >= 2 : /^__metadata:/m.test(text) || await regularFile(directory, '.yarnrc.yml');
      if (!classic && !modern) return { ...metadata, issue: 'The Yarn lockfile version could not be identified.' };
      args.push(classic ? '--frozen-lockfile' : '--immutable');
    } else args.push('--frozen-lockfile');
  }
  const evidence = [locked?.file, pin && 'package.json (' + manifest.packageManager + ')', workspace && 'pnpm-workspace.yaml'].filter(Boolean).join(' · ');
  return { ...metadata, step: { tool, command: [tool, ...args].join(' '), args, evidence } };
}

async function otherInstalls(directory) {
  const wrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
  const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const [pom, mavenWrapper, uvLock, pythonProject, requirements, venv] = await Promise.all([
    localText(directory, 'pom.xml'), regularFile(directory, wrapper), regularFile(directory, 'uv.lock'),
    regularFile(directory, 'pyproject.toml'), regularFile(directory, 'requirements.txt'), fileInfo(directory, '.venv')
  ]);
  const steps = [], issues = [];
  if (/<project(?:\s|>)/.test(pom.replace(/<!--[\s\S]*?-->/g, ''))) {
    if (mavenWrapper) {
      steps.push({ tool: 'Maven', command: (process.platform === 'win32' ? wrapper : './' + wrapper) + ' -B -DskipTests dependency:go-offline',
        args: ['-B', '-DskipTests', 'dependency:go-offline'], evidence: 'pom.xml · ' + wrapper });
    } else issues.push('A Maven project was found without a Maven Wrapper.');
  }
  if (uvLock && pythonProject) {
    steps.push({ tool: 'uv', command: 'uv sync --locked', args: ['sync', '--locked'], evidence: 'pyproject.toml · uv.lock' });
  } else if (requirements) {
    const interpreter = venv?.isDirectory() && await stat(join(directory, python)).catch(() => null);
    if (interpreter?.isFile()) {
      steps.push({ tool: 'pip', command: python + ' -m pip install -r requirements.txt', executable: python,
        args: ['-m', 'pip', 'install', '-r', 'requirements.txt'], evidence: 'requirements.txt · .venv' });
    } else issues.push('A requirements.txt file was found. A local .venv is needed for automatic pip installation.');
  } else if (pythonProject) issues.push('The Python project has no supported dependency lockfile.');
  return { steps, issues };
}

export async function detectDependencyPlan(project) {
  const saved = project.startup;
  const { identity, root } = await resolveStartup(project, [], saved?.identity ?? project.cloneIdentity);
  const budget = { left: 2048 };
  const folders = new Set([root, ...await workspaceFolders(root, conventional, budget)]);
  for (const service of saved?.services ?? []) {
    const resolved = await resolveStartup(project, [service], identity).catch(() => null);
    if (resolved) folders.add(resolved.commands[0].cwd);
  }

  const steps = [], issues = [], covered = new Set(), opaqueWorkspaces = [];
  const scanned = new Set();
  // Read the root and each parent before processing its possible workspace members.
  const pending = [...folders];
  while (pending.length && scanned.size < 96) {
    pending.sort((left, right) => left.length - right.length || left.localeCompare(right));
    const folder = pending.shift();
    if (scanned.has(folder)) continue;
    scanned.add(folder);
    const directory = shownFolder(root, folder);
    const manifestText = await localText(folder, 'package.json');
    const manifest = npmManifest(manifestText);
    const coveredByWorkspace = covered.has(folder) || opaqueWorkspaces.some(parent => {
      const inside = shownFolder(parent, folder);
      return inside !== '.' && !inside.startsWith('../') && inside !== '..';
    });
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest) && !coveredByWorkspace) {
      const { step, issue, patterns } = await inspectNode(folder, manifest);
      if (step) steps.push({ directory, ...step });
      if (issue) issues.push({ directory, message: issue });
      if (patterns === null || patterns.length > 32 || patterns.some(pattern => !workspaceSegments(pattern))) {
        opaqueWorkspaces.push(folder);
        issues.push({ directory, message: 'Workspace membership could not be verified. Nested JavaScript installs were skipped.' });
      } else if (patterns.length) {
        for (const member of await workspaceFolders(folder, patterns, budget)) {
          if (member === folder) continue;
          covered.add(member);
          if (!scanned.has(member)) pending.push(member);
        }
      }
    } else if (manifestText && !coveredByWorkspace) {
      issues.push({ directory, message: 'package.json could not be read as a valid manifest.' });
    }
    const other = await otherInstalls(folder);
    steps.push(...other.steps.map(step => ({ directory, ...step })));
    issues.push(...other.issues.map(message => ({ directory, message })));
  }
  if (steps.length > 16 || pending.length || budget.left <= 0) {
    steps.length = 0;
    issues.push({ directory: '.', message: 'This project has too many folders or install steps for automatic installation.' });
  }
  const id = createHash('sha256').update(JSON.stringify({ identity, steps, issues })).digest('hex');
  return { id, steps, issues, identity };
}
