import { lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

const invalid = 'Choose a SQLite database file inside the project.';
const signatures = stat => [stat.dev, stat.ino, stat.birthtimeNs].map(String);
const revision = stat => stat && [signatures(stat), stat.size, stat.mtimeNs, stat.ctimeNs].map(String);

export function sqliteFileState(file) {
  const parent = dirname(file);
  if (realpathSync.native(parent) !== parent) throw new Error(invalid);
  const directory = lstatSync(parent, { bigint: true });
  const files = ['', '-wal', '-shm', '-journal'].map(suffix => {
    const path = file + suffix;
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || realpathSync.native(path) !== path) throw new Error(invalid);
      return stat;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  });
  const [main, wal, shm, journal] = files;
  // Opening an idle WAL database for reading can leave an empty WAL file.
  const walRevision = wal?.size ? revision(wal) : undefined;
  return { main, files, identity: JSON.stringify([signatures(directory), main && signatures(main)]),
    revision: JSON.stringify([revision(main), walRevision, revision(journal)]),
    orphaned: !main && Boolean(wal || shm || journal) };
}
