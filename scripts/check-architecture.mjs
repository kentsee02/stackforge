import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

// Match top-level static imports and re-exports in the source tree.
const imports = /^(?:import\s+(?:[\w$*,\s]*(?:\{[^}]*\})?\s+from\s+)?|export\s+(?:\*[^'"\r\n]*?|\{[^}]*\})\s+from\s+)['"](\.\.?\/[^'"\r\n]+)['"]/gm;

export async function checkArchitecture(sourceRoot, files) {
  const dependencies = new Map();
  const describe = file => relative(sourceRoot, file).split(sep).join('/');
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const from = describe(file);
    const targets = [...source.matchAll(imports)].map(([, specifier]) => resolve(dirname(file), specifier));
    for (const target of targets) {
      const to = describe(target);
      if (!from.startsWith('http/') && to.startsWith('http/')) {
        throw new Error('Only HTTP modules can import HTTP adapters: ' + from + ' -> ' + to);
      }
      if (from.startsWith('platform/') && !to.startsWith('platform/') && !to.startsWith('../')) {
        throw new Error('Platform helpers must be independent of application modules: ' + from + ' -> ' + to);
      }
    }
    dependencies.set(file, targets);
  }

  const stack = new Set();
  const visited = new Set();
  function visit(file) {
    if (visited.has(file) || !dependencies.has(file)) return;
    if (stack.has(file)) {
      const path = [...stack];
      const cycle = [...path.slice(path.indexOf(file)), file].map(describe).join(' -> ');
      throw new Error('Circular source dependency: ' + cycle);
    }
    stack.add(file);
    for (const target of dependencies.get(file)) visit(target);
    stack.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file);
}
