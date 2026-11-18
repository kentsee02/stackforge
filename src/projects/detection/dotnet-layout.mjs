import { opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { throwIfCancelled } from '../../platform/process.mjs';

const ignored = /^(?:\.|bin$|obj$|node_modules$|TestResults$|coverage$|vendor$|dist$)/i;
const projectManifest = /\.(?:csproj|fsproj|vbproj)$/i;

export async function scanDotnetLayout(root, { includeSources = false, signal } = {}) {
  const projects = [];
  const pending = [{ directory: '', depth: 0 }];
  let count = 0, limited = false;
  for (const { directory, depth, owner } of pending) {
    throwIfCancelled(signal);
    const folder = join(root, directory);
    if (await realpath(folder).catch(() => '') !== folder) { limited = true; continue; }
    const listing = await opendir(folder).catch(() => undefined);
    if (!listing) { limited = true; continue; }
    const entries = [];
    try {
      for await (const entry of listing) {
        if (++count > 4096) return { projects, limited: true };
        if (!ignored.test(entry.name) && !/[\x00-\x1f\x7f]/.test(entry.name)) entries.push(entry);
      }
    } catch { limited = true; continue; }
    const prefix = directory ? directory + '/' : '';
    const manifests = entries.filter(entry => entry.isFile() && projectManifest.test(entry.name));
    let target = owner;
    if (manifests.length) {
      const assemblies = manifests.map(entry => ({ directory, source: prefix + entry.name, files: [] }));
      if (!includeSources) projects.push(...assemblies);
      else {
        const csharpProjects = assemblies.filter(assembly => /\.csproj$/i.test(assembly.source));
        target = manifests.length === 1 ? csharpProjects[0] : undefined;
        if (target) projects.push(target);
        else if (csharpProjects.length) limited = true;
      }
    }
    for (const entry of entries) {
      if (includeSources && entry.isFile() && /\.cs$/i.test(entry.name) && target) target.files.push(prefix + entry.name);
      if (entry.isDirectory()) {
        if (depth < 7) pending.push({ directory: prefix + entry.name, depth: depth + 1, owner: target });
        else limited = true;
      }
    }
  }
  return { projects, limited };
}
