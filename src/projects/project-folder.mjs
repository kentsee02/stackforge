import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { sameDirectory } from '../platform/project-identity.mjs';
import { projectPathKey } from './project-config.mjs';
import { resolveStartup } from './project-startup.mjs';

export const recordedProjectChanged = 'The recorded StackForge project is missing, has moved, or no longer matches its record.';

export async function projectDirectory(path) {
  const root = await lstat(path);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error();
  return realpath(path);
}

export async function readProjectFolder(path) {
  const directory = await projectDirectory(path);
  const manifestFile = join(directory, 'stackforge.json');
  const manifestInfo = await lstat(manifestFile);
  if (!manifestInfo.isFile() || manifestInfo.size > 64 * 1024) throw new Error();
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.generator !== 'StackForge') throw new Error();
  return { directory, manifest };
}

export async function inspectRecordedProject(project) {
  if (project.unmanaged) {
    const { root: directory } = await resolveStartup(project, []);
    if (projectPathKey(directory) !== projectPathKey(project.path)) throw new Error(recordedProjectChanged);
    return { directory, manifest: {} };
  }
  try {
    const info = await readProjectFolder(project.path);
    if (project.folderIdentity && !sameDirectory(await lstat(info.directory, { bigint: true }), project.folderIdentity)) throw new Error();
    if (['name', 'frontend', 'backend', 'database'].some(key => info.manifest.options?.[key] !== project[key])) throw new Error();
    return info;
  } catch {
    throw new Error(recordedProjectChanged);
  }
}

export async function developmentScript(directory) {
  const script = join(directory, 'scripts', 'dev.mjs');
  try {
    if (!(await lstat(script)).isFile() || projectPathKey(await realpath(script)) !== projectPathKey(script)) throw new Error();
    return script;
  } catch { throw new Error('The recorded StackForge project or its development script is missing or has moved.'); }
}
