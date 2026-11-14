import { createHash } from 'node:crypto';
import { backupLimit } from './database-backup.mjs';

const format = Buffer.from('STACKFORGE-DB-1\n');
const checksum = value => createHash('sha256').update(value).digest('hex');
const versions = /^\d{1,2}\.\d+(?:\.\d+)?$/;
const signatures = {
  postgres: Buffer.from('PGDMP'), mysql: Buffer.from('-- MySQL dump '), sqlite: Buffer.from('SQLite format 3\0')
};
const extensions = { postgres: 'pg.dump', mysql: 'mysql.sql', sqlite: 'sqlite' };
const unreadable = 'The backup checksum, metadata, or database format is invalid.';
export const archiveLimit = backupLimit + 4096;

export function archiveBackup({ data, engine, version, project }) {
  if (!validPayload(data, engine) || !versions.test(version)) throw new Error(unreadable);
  const metadata = { engine, version, bytes: data.length, checksum: checksum(data), createdAt: new Date().toISOString() };
  const name = project.replace(/[^\w.-]/g, '-').slice(0, 72) || 'project';
  return { metadata, data: Buffer.concat([format, Buffer.from(JSON.stringify(metadata) + '\n'), data]),
    filename: `${name}-${metadata.createdAt.replace(/[:.]/g, '-')}-${extensions[engine]}.sfdb` };
}

function validPayload(data, engine) {
  return Object.hasOwn(signatures, engine) && Buffer.isBuffer(data) && data.length <= backupLimit &&
    data.subarray(0, signatures[engine].length).equals(signatures[engine]);
}

export function inspectArchive(archive, engine, targetVersion) {
  if (!archive.subarray(0, format.length).equals(format)) throw new Error(unreadable);
  const end = archive.indexOf(10, format.length);
  if (end < 0 || end - format.length > 1024) throw new Error(unreadable);
  let metadata;
  try { metadata = JSON.parse(archive.toString('utf8', format.length, end)); }
  catch { throw new Error(unreadable); }
  if (!metadata || metadata.engine !== engine) throw new Error('The backup engine does not match the restore target.');
  const data = archive.subarray(end + 1);
  if (!validPayload(data, engine) || !versions.test(metadata.version) || metadata.bytes !== data.length ||
      metadata.checksum !== checksum(data) || typeof metadata.createdAt !== 'string' || !Number.isFinite(Date.parse(metadata.createdAt))) {
    throw new Error(unreadable);
  }
  checkVersion(engine, metadata.version, targetVersion);
  return { data, metadata: { engine, version: metadata.version, bytes: data.length, checksum: metadata.checksum, createdAt: metadata.createdAt } };
}

export function isLegacyBackup(data, engine) {
  return engine !== 'sqlite' && validPayload(data, engine);
}

export function inspectLegacyBackup(data, engine, version, targetVersion) {
  if (!isLegacyBackup(data, engine) || !versions.test(version ?? '')) throw new Error(unreadable);
  checkVersion(engine, version, targetVersion);
  return { data, metadata: { engine, version, bytes: data.length, checksum: checksum(data), legacy: true } };
}

function checkVersion(engine, version, targetVersion) {
  const source = version.split('.').map(Number);
  const target = targetVersion?.split('.').map(Number) ?? [];
  const compatible = versions.test(targetVersion ?? '') && (engine === 'postgres' ? source[0] <= target[0] :
    engine === 'mysql' ? source[0] === target[0] && source[1] <= target[1] : source[0] === target[0]);
  if (!compatible) throw new Error('The backup database version is incompatible with the restore target.');
}

export function archiveDigest(value) {
  return checksum(value);
}
