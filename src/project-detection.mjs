import { lstat, opendir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const npmFrameworks = [
  ['Next.js', 'next', ['react']],
  ['Nuxt', 'nuxt', ['vue']],
  ['SvelteKit', '@sveltejs/kit', ['svelte']],
  ['Angular', '@angular/core'],
  ['React', 'react'],
  ['Vue', 'vue'],
  ['Svelte', 'svelte'],
  ['NestJS', '@nestjs/core', ['express']],
  ['Express', 'express'],
  ['Fastify', 'fastify'],
  ['Koa', 'koa'],
  ['Hono', 'hono']
];
const pythonFrameworks = [['Django', 'django'], ['FastAPI', 'fastapi'], ['Flask', 'flask']];
const known = new Set([...npmFrameworks.map(([name]) => name), ...pythonFrameworks.map(([name]) => name), 'Spring Boot']);
export const validFrameworks = values => Array.isArray(values) ? [...new Set(values.filter(value => known.has(value)))] : [];

export async function localText(folder, filename) {
  try {
    const path = join(folder, filename);
    const file = await lstat(path);
    if (file.isFile() && file.size <= 512 * 1024) return await readFile(path, 'utf8');
  } catch { /* A missing or unreadable file provides no framework evidence. */ }
  return '';
}

async function localDirectory(path) {
  return (await lstat(path).catch(() => null))?.isDirectory() === true;
}

export function npmManifest(text) {
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { return undefined; }
}

export async function findMavenWrapper(directory, root) {
  return findBuildWrapper(directory, root, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
}

export async function findBuildWrapper(directory, root, wrapper) {
  const within = relative(root, directory);
  if (isAbsolute(within) || within.split(sep)[0] === '..') return;
  for (let folder = directory; ; folder = dirname(folder)) {
    if ((await lstat(join(folder, wrapper)).catch(() => null))?.isFile()) return (relative(directory, folder) || '.') + sep + wrapper;
    if (!relative(root, folder)) return;
  }
}

async function detectIn(folder) {
  const [npm, pom, gradle, gradleKotlin, requirements, pyproject] = await Promise.all(
    ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'requirements.txt', 'pyproject.toml'].map(file => localText(folder, file))
  );
  const manifest = npmManifest(npm);
  const dependencies = new Set();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const group = manifest?.[key];
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    for (const [name, version] of Object.entries(group)) if (typeof version === 'string' && version) dependencies.add(name);
  }
  const frameworks = [];
  for (const [name, dependency, supersedes = []] of npmFrameworks) {
    if (!dependencies.has(dependency)) continue;
    frameworks.push(name);
    for (const base of supersedes) dependencies.delete(base);
  }
  const maven = pom.replace(/<!--[\s\S]*?-->/g, '');
  const gradleBuild = (gradle + '\n' + gradleKotlin).replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, '');
  if (/<groupId>\s*org\.springframework\.boot\s*<\/groupId>\s*<artifactId>\s*spring-boot[\w-]*\s*<\/artifactId>/.test(maven) ||
      /\bid\s*\(?\s*['"]org\.springframework\.boot['"]/.test(gradleBuild)) frameworks.push('Spring Boot');
  const section = name => new RegExp(`^\\[${name}\\][ \\t]*\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(pyproject)?.[1] ?? '';
  const poetry = section('tool\\.poetry\\.dependencies');
  const pep621 = section('project').replace(/^[ \t]*#.*$/gm, '');
  const pythonDependencies = /^[ \t]*dependencies[ \t]*=[ \t]*\[((?:[^"'\[\]]|"[^"\r\n]*"|'[^'\r\n]*')*)\]/m.exec(pep621)?.[1] ?? '';
  for (const [name, dependency] of pythonFrameworks) {
    const version = "(?=$|[\\s<>=!~;\\[\"'])";
    if (new RegExp(`^\\s*${dependency}${version}`, 'im').test(requirements) ||
        new RegExp(`^\\s*${dependency}\\s*=`, 'im').test(poetry) ||
        new RegExp(`['"]${dependency}${version}`, 'i').test(pythonDependencies)) frameworks.push(name);
  }
  return frameworks;
}

export const conventional = ['frontend', 'backend', 'client', 'server', 'web', 'api', 'apps/*', 'packages/*'];
const ignored = name => name.startsWith('.') || name === 'node_modules';

export function workspaceSegments(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 512) return;
  const segments = pattern.replace(/^\.\//, '').replace(/\/$/, '').split('/');
  if (segments.length > 8 || segments.some(segment => ignored(segment) || !/^[\p{L}\p{N}@._*-]+$/u.test(segment))) return;
  return segments;
}

async function collectWorkspace(directory, segments, folders, budget, depth = 0) {
  if (budget.left-- <= 0 || folders.size >= 96 || depth > 8) return;
  if (!segments.length) { folders.add(directory); return; }
  const [segment, ...rest] = segments;
  if (!segment.includes('*')) {
    const child = join(directory, segment);
    if (await localDirectory(child)) await collectWorkspace(child, rest, folders, budget, depth + 1);
    return;
  }
  const recursive = segment === '**';
  const match = recursive ? null : new RegExp('^' + segment.replaceAll('.', '\\.').replaceAll('*', '.*') + '$');
  if (recursive) await collectWorkspace(directory, rest, folders, budget, depth);
  const entries = await opendir(directory).catch(() => null);
  if (!entries) return;
  try {
    for await (const entry of entries) {
      if (budget.left-- <= 0 || folders.size >= 96) break;
      if (entry.isDirectory() && !ignored(entry.name) && (recursive || match.test(entry.name))) {
        await collectWorkspace(join(directory, entry.name), recursive ? segments : rest, folders, budget, depth + 1);
      }
    }
  } catch { /* Directory contents can change during detection. */ }
}

export function declaredWorkspaces(manifest) {
  const workspaces = manifest?.workspaces;
  const declared = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  return Array.isArray(declared) ? declared : [];
}

export async function workspaceFolders(directory, patterns, budget = { left: 2048 }) {
  const folders = new Set();
  for (const pattern of patterns) {
    const segments = workspaceSegments(pattern);
    if (segments) await collectWorkspace(directory, segments, folders, budget);
  }
  return folders;
}

export async function detectFrameworks(directory) {
  if (!await localDirectory(directory)) return [];
  const manifest = npmManifest(await localText(directory, 'package.json'));
  const folders = new Set([directory, ...await workspaceFolders(directory, new Set([...declaredWorkspaces(manifest).slice(0, 32), ...conventional]))]);
  return validFrameworks((await Promise.all([...folders].map(detectIn))).flat());
}
