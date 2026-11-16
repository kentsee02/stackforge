import { locationExists } from '../platform/paths.mjs';
import { verifyClone } from './project-clone.mjs';
import { inspectRecordedProject, recordedProjectChanged } from './project-folder.mjs';

export function removeOnly(project) {
  return project.cloneId ? !project.cloneIdentity : project.unmanaged === true;
}

export class ProjectRemovalError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

export function createProjectRemoval({ projectConfig, removals, trashProject, isProjectBusy, isProjectRunning,
  isCreatingProject, removeDatabaseProfiles, removeDatabaseRegistration, recordProfileCleanup }) {
  return async function removeProject(project, { action, confirmName }) {
    if (confirmName !== project.name) throw new ProjectRemovalError('invalid-request', 'Enter the exact project name to confirm deletion.');
    const offline = !await locationExists(project.path);
    if (isProjectBusy(project)) throw new ProjectRemovalError('conflict', 'Wait for the current project operation to finish.');
    if (action === 'remove' && !project.imported && !offline) {
      throw new ProjectRemovalError('conflict', 'Only imported projects can be removed from the list.');
    }
    if (isCreatingProject()) throw new ProjectRemovalError('conflict', 'Wait for StackForge to finish its current task.');
    if (isProjectRunning(project)) throw new ProjectRemovalError('conflict', 'Stop the project before moving it to the trash.');

    const moving = action !== 'remove' && !offline && !removeOnly(project);
    const done = (async () => {
      if (moving) {
        const { directory } = await inspectRecordedProject(project);
        if (project.cloneId) {
          await verifyClone(directory, project.cloneId, project.cloneIdentity);
          await trashProject(directory, project.cloneIdentity);
        } else {
          await trashProject(directory, project.folderIdentity, recordedProjectChanged);
        }
        if (await locationExists(project.path)) throw new Error('The project is still at its original location. Check the system trash before retrying.');
        const record = recordProfileCleanup(project);
        await removeDatabaseProfiles(project).then(() => record('succeeded'), () => record('failed'));
      } else {
        await removeDatabaseProfiles(project);
      }
      if (moving ? project.cloneId : project.imported) await projectConfig.removeImport(project.id);
      else await projectConfig.hideMissingProject(project.id);
      await removeDatabaseRegistration(project.id);
      return moving ? { trashed: true, databaseDeleted: false } : { removed: true };
    })();
    removals.set(project.path, { moving, done });
    try { return await done; }
    catch (error) {
      if (!moving) throw error;
      throw new ProjectRemovalError('conflict', error.message);
    }
    finally { removals.delete(project.path); }
  };
}
