import { inflateRawSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

// Spring Initializr returns a regular ZIP. Reject ZIP64, encryption, symlinks,
// traversal and excessive expansion rather than delegating to a shell command.
export async function extractZip(buffer, target) {
  let end = -1;
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 65557); p--) {
    if (buffer.readUInt32LE(p) === 0x06054b50 && p + 22 + buffer.readUInt16LE(p + 20) === buffer.length) { end = p; break; }
  }
  if (end < 0) throw new Error('下载的文件不是有效 ZIP。');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  if (count === 65535 || count > 2000 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new Error('不支持的 ZIP 格式。');
  let total = 0;
  const seen = new Set();
  const root = resolve(target);
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录损坏。');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16;
    const local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    const parts = name.replaceAll('\\', '/').split('/');
    const destination = resolve(root, ...parts);
    if (!name || parts.some(p => p === '..' || p.includes(':') || p.includes('\0')) || !destination.startsWith(root + sep) || (mode & 0xf000) === 0xa000 || seen.has(destination.toLowerCase())) throw new Error('ZIP 包含不安全的路径。');
    seen.add(destination.toLowerCase());
    total += size;
    if (flags & 1 || ![0, 8].includes(method) || total > 64 * 1024 * 1024) throw new Error('ZIP 格式或大小超出限制。');
    if (name.endsWith('/')) { await mkdir(destination, { recursive: true }); continue; }
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP 条目损坏。');
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (dataStart + compressed > buffer.length) throw new Error('ZIP 条目不完整。');
    const raw = buffer.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) }) : raw;
    if (data.length !== size) throw new Error('ZIP 条目长度错误。');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data, { mode: mode & 0o111 ? 0o755 : 0o644 });
  }
  if (cursor !== buffer.readUInt32LE(end + 16) + buffer.readUInt32LE(end + 12)) throw new Error('ZIP 目录长度错误。');
}
