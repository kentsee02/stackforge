import { lstat, opendir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

async function localText(folder, filename) {
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

async function detectIn(folder) {
  const [npm, pom, gradle, gradleKotlin, requirements, pyproject] = await Promise.all(
    ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'requirements.txt', 'pyproject.toml'].map(file => localText(folder, file))
  );
  let manifest;
  try { manifest = JSON.parse(npm.replace(/^\uFEFF/, '')); } catch { /* No usable npm manifest. */ }
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

export async function detectFrameworks(directory) {
  if (!await localDirectory(directory)) return [];
  const folders = [directory];
  for (const name of ['frontend', 'backend', 'client', 'server', 'web', 'api', 'apps', 'packages']) {
    const path = join(directory, name);
    if (!await localDirectory(path)) continue;
    if (name !== 'apps' && name !== 'packages') {
      folders.push(path);
      continue;
    }
    const entries = await opendir(path).catch(() => null);
    if (!entries) continue;
    let scanned = 0;
    try {
      for await (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') folders.push(join(path, entry.name));
        if (++scanned === 12) break;
      }
    } catch { /* Directory contents can change during detection. */ }
  }
  return validFrameworks((await Promise.all(folders.map(detectIn))).flat());
}
