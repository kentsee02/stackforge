import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

export const postgresBackupLimit = 512 * 1024 * 1024;
export const sqlServerBackupSignature = Buffer.from('STACKFORGE-MSSQL\0');
export const isBackupFile = data => !Buffer.isBuffer(data);

export function streamBackupFile({ path, offset, bytes }, signal) {
  return createReadStream(path, { start: offset, end: offset + bytes - 1, signal });
}

export async function backupPrefix(file, max) {
  const fd = await open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(file.bytes, max));
    const result = await fd.read(buffer, 0, buffer.length, file.offset);
    return buffer.subarray(0, result.bytesRead);
  } finally { await fd.close(); }
}

export function backupInput(data) {
  return isBackupFile(data) ? { inputFile: data } : { input: data };
}
