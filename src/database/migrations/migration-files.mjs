import { lstat, open, realpath } from 'node:fs/promises';

function utf8(buffer) {
  const text = buffer.toString('utf8');
  if (!Buffer.from(text).equals(buffer)) throw new Error();
  return text;
}

export async function readMigrationFile(path, limit, decode = utf8) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.size > BigInt(limit) || await realpath(path) !== path) throw new Error();
  const handle = await open(path, 'r');
  try {
    const start = await handle.stat({ bigint: true });
    // Older libuv on Windows may only report the volume identifier for an open handle.
    const missingVolume = process.platform === 'win32' && info.dev === 0n;
    if (!start.isFile() || !missingVolume && start.dev !== info.dev || start.ino !== info.ino ||
        start.ctimeNs !== info.ctimeNs || start.size !== info.size) throw new Error();
    const buffer = Buffer.alloc(Number(info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (bytesRead !== buffer.length || start.ctimeNs !== end.ctimeNs || start.size !== end.size ||
        !current.isFile() || current.dev !== info.dev || current.ino !== info.ino ||
        current.ctimeNs !== info.ctimeNs || current.size !== info.size || await realpath(path) !== path) throw new Error();
    return decode(buffer);
  } finally { await handle.close(); }
}
