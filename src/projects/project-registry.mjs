import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { absoluteDirectory, locationExists } from '../platform/paths.mjs';
import { directoryIdentity, sameDirectory } from '../platform/project-identity.mjs';
import { detectFrameworks } from './detection/project-services.mjs';
import { verifyClone } from './project-clone.mjs';
import { importedProject, projectPathKey } from './project-config.mjs';
import { developmentScript, inspectRecordedProject, projectDirectory, readProjectFolder } from './project-folder.mjs';

export function createProjectRegistry({ projectConfig, generatedProjects, isProjectBusy, isProjectRunning,
  discoverDatabases, syncDatabaseBindings, removeDatabaseRegistration }) {
  function list() {
    const created = generatedProjects().map(project => ({ ...project, path: projectConfig.value.locations[project.id] ?? project.path }));
    const paths = new Set(created.map(project => projectPathKey(project.path)));
    return [...projectConfig.value.imports.filter(project => !paths.has(projectPathKey(project.path))), ...created];
  }

  async function relocate(project, directory) {
    const current = list().find(item => item.id === project.id);
    if (!current || !project.folderIdentity || isProjectBusy(current) || isProjectRunning(current) ||
        await locationExists(current.path) || !sameDirectory(await lstat(directory, { bigint: true }), project.folderIdentity) ||
        list().some(item => projectPathKey(item.path) === projectPathKey(directory))) {
      throw new Error('Choose the original project folder at its new location.');
    }
    const moved = { ...current, path: directory };
    await inspectRecordedProject(moved);
    if (moved.cloneId) await verifyClone(directory, moved.cloneId, moved.cloneIdentity);
    await projectConfig.relocate(current, directory);
    return moved;
  }

  async function register(path, clone = {}) {
    const directory = await projectDirectory(absoluteDirectory(path)).catch(() => {
      throw new Error('Choose an existing project directory.');
    });
    const info = await lstat(directory, { bigint: true });
    const folderIdentity = directoryIdentity(info);
    const previous = !clone.cloneId && folderIdentity && list().find(item =>
      sameDirectory(info, item.folderIdentity) && projectPathKey(item.path) !== projectPathKey(directory));
    if (previous) {
      const moved = await relocate(previous, directory);
      await syncDatabaseBindings(moved);
      return moved;
    }

    let project;
    try {
      const { manifest } = await readProjectFolder(directory);
      await developmentScript(directory);
      const { name, frontend, backend, database } = manifest.options ?? {};
      project = importedProject(randomUUID(), directory, { name, frontend, backend, database, folderIdentity, ...clone });
    } catch {
      const frameworks = await detectFrameworks({ path: directory, folderIdentity, ...clone });
      project = importedProject(randomUUID(), directory, { unmanaged: true, folderIdentity, ...clone, frameworks });
    }

    const existing = await Promise.all(list().filter(item => !item.imported).map(item => realpath(item.path).catch(() => item.path)));
    if (existing.some(item => projectPathKey(item) === projectPathKey(project.path))) throw new Error('This folder is already in Projects.');

    const discovery = await discoverDatabases(project);
    const previousClone = project.cloneId && projectConfig.value.imports.find(item =>
      item.cloneId && projectPathKey(item.path) === projectPathKey(project.path));
    await projectConfig.addProject(project);
    try {
      if (previousClone) await removeDatabaseRegistration(previousClone.id);
      await syncDatabaseBindings(project, discovery);
    } catch {
      // The discovery panel can retry catalog writes after registration.
    }
    return project;
  }

  return { list, register };
}
