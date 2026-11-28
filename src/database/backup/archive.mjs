import { createHash } from 'node:crypto';
import { backupLimit } from './docker-transfer.mjs';
import { backupPrefix, postgresBackupLimit, sqlServerBackupSignature, streamBackupFile } from './payload.mjs';

const format = Buffer.from('STACKFORGE-DB-1\n');
const checksum = value => createHash('sha256').update(value).digest('hex');
const versions = /^\d{1,2}\.\d+(?:\.\d+)?$/;
const signatures = {
  postgres: Buffer.from('PGDMP'), mysql: Buffer.from('-- MySQL dump '), sqlite: Buffer.from('SQLite format 3\0'), sqlserver: sqlServerBackupSignature
};
const extensions = { postgres: 'pg.dump', mysql: 'mysql.sql', sqlite: 'sqlite', sqlserver: 'sqlserver.bak' };
const unreadable = 'The backup checksum, metadata, or database format is invalid.';
export const archiveLimit = backupLimit + 4096;
export const postgresArchiveLimit = postgresBackupLimit + 4096;
const largeUnsupported = 'Large backups up to 512 MiB require a PostgreSQL target. The limit for other engines is 64 MiB.';

function archiveInfo(engine, version, project, bytes, checksum) {
  const metadata = { engine, version, bytes, checksum, createdAt: new Date().toISOString() };
  const name = project.replace(/[^\w.-]/g, '-').slice(0, 72) || 'project';
  const header = Buffer.concat([format, Buffer.from(JSON.stringify(metadata) + '\n')]);
  return { metadata, header, filename: `${name}-${metadata.createdAt.replace(/[:.]/g, '-')}-${extensions[engine]}.sfdb` };
}

export function archiveBackup({ data, engine, version, project }) {
  if (!validPayload(data, engine) || !versions.test(version)) throw new Error(unreadable);
  const { metadata, header, filename } = archiveInfo(engine, version, project, data.length, checksum(data));
  return { metadata, data: Buffer.concat([header, data]), filename };
}

export async function archiveFile({ data, engine, version, project, signal }) {
  if (engine !== 'postgres' || data.bytes > postgresBackupLimit) throw new Error(largeUnsupported);
  if (!validSignature(await backupPrefix(data, 16), engine) || !versions.test(version)) throw new Error(unreadable);
  const checksum = await fileDigest(data, signal);
  const { header, ...info } = archiveInfo(engine, version, project, data.bytes, checksum);
  return { ...info, header, data };
}

function validSignature(data, engine) {
  return Object.hasOwn(signatures, engine) && data.subarray(0, signatures[engine].length).equals(signatures[engine]);
}

function validPayload(data, engine) {
  return Buffer.isBuffer(data) && data.length <= backupLimit && validSignature(data, engine);
}

function archiveMetadata(archive, engine) {
  if (!archive.subarray(0, format.length).equals(format)) throw new Error(unreadable);
  const end = archive.indexOf(10, format.length);
  if (end < 0 || end - format.length > 1024) throw new Error(unreadable);
  let metadata;
  try { metadata = JSON.parse(archive.toString('utf8', format.length, end)); }
  catch { throw new Error(unreadable); }
  if (!metadata || metadata.engine !== engine) throw new Error('The backup engine does not match the restore target.');
  if (!versions.test(metadata.version) || typeof metadata.createdAt !== 'string' || !Number.isFinite(Date.parse(metadata.createdAt))) throw new Error(unreadable);
  return { metadata, end };
}

export function inspectArchive(archive, engine, targetVersion) {
  const { metadata, end } = archiveMetadata(archive, engine);
  const data = archive.subarray(end + 1);
  if (!validPayload(data, engine) || metadata.bytes !== data.length || metadata.checksum !== checksum(data)) throw new Error(unreadable);
  checkVersion(engine, metadata.version, targetVersion);
  return { data, metadata: { engine, version: metadata.version, bytes: data.length, checksum: metadata.checksum, createdAt: metadata.createdAt } };
}

export async function inspectArchiveFile(file, engine, targetVersion, signal) {
  if (engine !== 'postgres') throw new Error(largeUnsupported);
  const { metadata, end } = archiveMetadata(await backupPrefix(file, 1100), engine);
  const data = { ...file, offset: file.offset + end + 1, bytes: file.bytes - end - 1 };
  if (data.bytes < 5 || data.bytes > postgresBackupLimit || metadata.bytes !== data.bytes ||
      !validSignature(await backupPrefix(data, 16), engine) || metadata.checksum !== await fileDigest(data, signal)) throw new Error(unreadable);
  checkVersion(engine, metadata.version, targetVersion);
  return { data, metadata: { engine, version: metadata.version, bytes: data.bytes, checksum: metadata.checksum, createdAt: metadata.createdAt } };
}

export async function legacyFileBackup(file, engine, version, targetVersion, signal) {
  if (engine !== 'postgres' || file.bytes > postgresBackupLimit || !versions.test(version ?? '') ||
      !validSignature(await backupPrefix(file, 16), engine)) throw new Error(unreadable);
  checkVersion(engine, version, targetVersion);
  return { data: file, metadata: { engine, version, bytes: file.bytes, checksum: await fileDigest(file, signal), legacy: true } };
}

export async function isLegacyFileBackup(file, engine) {
  return engine === 'postgres' && file.bytes <= postgresBackupLimit && validSignature(await backupPrefix(file, 16), engine);
}

export function isLegacyBackup(data, engine) {
  return ['postgres', 'mysql'].includes(engine) && validPayload(data, engine);
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
    engine === 'mysql' ? source[0] === target[0] && source[1] <= target[1] :
    engine === 'sqlserver' ? source[0] === 16 && target[0] === 16 && (source[1] < target[1] || source[1] === target[1] && source[2] <= target[2]) :
    source[0] === target[0]);
  if (!compatible) throw new Error('The backup database version is incompatible with the restore target.');
}

export function archiveDigest(value) {
  return checksum(value);
}

export async function fileDigest(file, signal) {
  const hash = createHash('sha256');
  let size = 0;
  const stream = streamBackupFile(file, signal);
  for await (const chunk of stream) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (size !== file.bytes) throw new Error(unreadable);
  return hash.digest('hex');
}
