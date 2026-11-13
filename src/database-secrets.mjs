import { posix } from 'node:path';

const hidden = '[redacted]';
const secretKey = /(?:PASSWORD|PASSWD|(?:^|_)PWD|SECRET|TOKEN|DATABASE_URL|CONNECTION_STRING)/i;
const databaseUrl = /(?:jdbc:)?\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|mssql|sqlserver):\/\/[^\s"'<>]+/gi;
const assignment = /(\b[\w.]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|DATABASE_URL|CONNECTION_STRING)[\w.]*\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;,]+)/gi;
const redactionError = 'Could not verify database log redaction.';
const secretLimit = 64 * 1024;

export function databaseSecretFiles(environment) {
  return Object.entries(environment ?? {}).filter(([key, value]) => secretKey.test(key) && /_FILE$/i.test(key) && value);
}

function readSecretArchive(archive) {
  // docker cp emits a tar stream. Accept a single regular file and never extract to disk.
  if (!Buffer.isBuffer(archive) || archive.length < 1536 || archive.length % 512) throw new Error(redactionError);
  let offset = 0;
  for (let records = 0; records < 4 && offset + 512 <= archive.length; records++) {
    const header = archive.subarray(offset, offset + 512);
    const rawSize = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(rawSize)) break;
    const size = Number.parseInt(rawSize, 8);
    const start = offset + 512;
    offset = start + Math.ceil(size / 512) * 512;
    if (size > secretLimit || offset > archive.length) break;
    if (header[156] === 120) continue; // PAX metadata for a long file name.
    if ([0, 48].includes(header[156]) && archive.length >= offset + 1024 && archive.subarray(offset).every(byte => byte === 0)) {
      return archive.toString('utf8', start, start + size).replace(/\n+$/, '');
    }
    break;
  }
  throw new Error(redactionError);
}

export async function addContainerSecretFiles(redact, environment, docker, id, status) {
  const files = databaseSecretFiles(environment);
  if (files.length > 16) throw new Error(redactionError);
  const values = await Promise.all(files.map(async ([key, path]) => {
    if (typeof path !== 'string' || path === '/' || !posix.isAbsolute(path) || posix.normalize(path) !== path ||
        path.endsWith('/') || /^\/(?:proc|sys|dev)(?:\/|$)/.test(path) || /[\u0000-\u001f]/u.test(path)) {
      throw new Error(redactionError);
    }
    try {
      let value;
      if (['running', 'starting', 'unhealthy'].includes(status)) {
        const content = await docker(['exec', id, 'sh', '-c', 'test -f "$1" && exec head -c 65537 -- "$1"', 'stackforge', path],
          { binaryLimit: secretLimit, timeout: 4000 });
        value = content.toString('utf8').replace(/\n+$/, '');
      } else {
        const archive = await docker(['cp', `${id}:${path}`, '-'], { binaryLimit: secretLimit + 8192, timeout: 4000 });
        value = readSecretArchive(archive);
      }
      return [key.slice(0, -5), value];
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error(redactionError);
    }
  }));
  redact.add(Object.fromEntries(values));
}

export function databaseRedactor(environment) {
  const values = new Set();
  let literals;
  const add = variables => {
    for (const [key, value] of Object.entries(variables ?? {})) {
      if (!secretKey.test(key) || /_FILE$/i.test(key) || typeof value !== 'string' || !value) continue;
      values.add(value);
      for (const line of value.split(/\r?\n/)) if (line) values.add(line);
      try {
        values.add(encodeURIComponent(value));
        const url = new URL(value.replace(/^jdbc:/i, ''));
        if (url.password) {
          values.add(url.password);
          values.add(decodeURIComponent(url.password));
        }
      } catch { /* plain passwords and malformed URLs still match literally */ }
    }
    literals = undefined;
  };
  add(environment);
  return { add, text(value) {
    if (!literals && values.size) {
      const patterns = [...values].sort((a, b) => b.length - a.length).map(value => {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return value.length < 4 ? `(?<![\\w])${escaped}(?![\\w])` : escaped;
      });
      literals = new RegExp(patterns.join('|'), 'g');
    }
    const masked = literals ? value.replace(literals, hidden) : value;
    return masked.replace(databaseUrl, hidden).replace(assignment, (_, prefix) => prefix + hidden);
  } };
}
