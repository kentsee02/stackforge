export const cloneFolderChanged = 'The folder could not be verified as the original StackForge clone.';

export function directoryIdentity(info) {
  if (!info.isDirectory() || info.isSymbolicLink() || typeof info.ino !== 'bigint' || info.ino === 0n) return;
  return { dev: String(info.dev), ino: String(info.ino), birth: String(info.birthtimeNs) };
}

export function recordedIdentity(value) {
  const { dev, ino, birth } = value ?? {};
  if ([dev, ino, birth].every(part => typeof part === 'string' && /^-?\d{1,24}$/.test(part)) && ino !== '0') {
    return { dev, ino, birth };
  }
}

export function sameDirectory(info, expected) {
  const current = directoryIdentity(info);
  return current && expected && current.dev === expected.dev && current.ino === expected.ino && current.birth === expected.birth;
}
