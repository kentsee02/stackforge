import { dotnetManifest, walkRepository } from './repository-layout.mjs';

const ignored = /^(?:\.|bin$|obj$|node_modules$|TestResults$|coverage$|vendor$|dist$)/i;

export async function scanDotnetLayout(root, { signal } = {}) {
  const projects = [], owners = new Map();
  let ambiguous = false;
  const limited = await walkRepository(root, ({ directory, parent, files }) => {
    const prefix = directory ? directory + '/' : '';
    const manifests = files.filter(file => dotnetManifest.test(file));
    let target = owners.get(parent);
    if (manifests.length) {
      const csharp = manifests.filter(file => /\.csproj$/i.test(file));
      target = manifests.length === 1 && csharp.length ? { directory, source: prefix + csharp[0], files: [] } : undefined;
      if (target) projects.push(target);
      else if (csharp.length) ambiguous = true;
    }
    if (target) {
      owners.set(directory, target);
      for (const file of files) if (!file.startsWith('.') && /\.cs$/i.test(file)) target.files.push(prefix + file);
    }
  }, { signal, maxEntries: 4096, maxDepth: 7, skipDirectory: name => ignored.test(name) });
  return { projects, limited: limited || ambiguous };
}
