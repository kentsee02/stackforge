import { opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { throwIfCancelled } from '../../platform/process.mjs';

export const composeConfigFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
export const databaseEnvironmentFiles = ['.env', '.env.local', '.env.example'];
export const dotnetManifest = /\.(?:csproj|fsproj|vbproj)$/i;
export const dotnetSettingsFile = /^appsettings(?:\.[\w-]+)?\.json$/i;
export const jvmSettingsFile = /^application(?:-[\w-]+)?\.(?:properties|ya?ml|conf)$/i;

const generated = /^(?:\.|__pycache__$|node_modules$|bower_components$|site-packages$|venv$|vendor$|bin$|obj$|TestResults$|coverage$|dist$|target$)/i;
export const ignoredRepositoryDirectory = name => generated.test(name);

export async function walkRepository(root, visit, {
  signal, maxEntries = 8192, maxDepth = 12, skipDirectory = ignoredRepositoryDirectory
} = {}) {
  const queue = [{ directory: '', parent: undefined, depth: 0 }];
  let examined = 0, limited = false;
  for (const { directory, parent, depth } of queue) {
    throwIfCancelled(signal);
    const folder = join(root, directory);
    if (await realpath(folder).catch(() => '') !== folder) { limited = true; continue; }
    const listing = await opendir(folder).catch(() => undefined);
    if (!listing) { limited = true; continue; }
    const files = [], children = [];
    try {
      for await (const entry of listing) {
        if (++examined > maxEntries) return true;
        if (/[\x00-\x1f\x7f]/.test(entry.name)) continue;
        if (entry.isFile()) files.push(entry.name);
        else if (entry.isDirectory() && !skipDirectory(entry.name)) children.push(entry.name);
      }
    } catch { limited = true; continue; }
    visit({ folder, directory, parent, files });
    if (depth >= maxDepth) limited ||= children.length > 0;
    else for (const name of children.sort()) {
      queue.push({ directory: directory ? directory + '/' + name : name, parent: directory, depth: depth + 1 });
    }
  }
  return limited;
}
