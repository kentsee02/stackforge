import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { throwIfCancelled } from '../../platform/process.mjs';
import { readMigrationFile } from './migration-files.mjs';
import { versionKey } from './flyway-preview.mjs';

const invalid = 'Choose a project-relative Flyway classes folder built for Java 21 or earlier.';
const packagePath = /^[a-zA-Z_$][\w$]*(?:\/[a-zA-Z_$][\w$]*)*$/;
const compiledPath = /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/;
const callbackType = 'org/flywaydb/core/api/callback/Callback';
const migrationType = 'org/flywaydb/core/api/migration/BaseJavaMigration';
const migrationInterface = 'org/flywaydb/core/api/migration/JavaMigration';
const constantSize = { 3: 4, 4: 4, 5: 8, 6: 8, 8: 2, 9: 4, 10: 4, 11: 4, 12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2 };

function classDeclaration(bytes) {
  if (bytes.readUInt32BE(0) !== 0xcafebabe || bytes.readUInt16BE(6) > 65) throw new Error(invalid);
  const count = bytes.readUInt16BE(8);
  const pool = [];
  let cursor = 10;
  for (let index = 1; index < count; index++) {
    const tag = bytes.readUInt8(cursor++);
    if (tag === 1) {
      const length = bytes.readUInt16BE(cursor);
      cursor += 2;
      pool[index] = bytes.toString('utf8', cursor, cursor += length);
    } else if (tag === 7) {
      pool[index] = bytes.readUInt16BE(cursor);
      cursor += 2;
    } else {
      if (!Object.hasOwn(constantSize, tag)) throw new Error(invalid);
      cursor += constantSize[tag];
      if (tag === 5 || tag === 6) index++;
    }
  }
  const className = offset => pool[pool[bytes.readUInt16BE(offset)]];
  const interfaces = Array.from({ length: bytes.readUInt16BE(cursor + 6) }, (_, index) => className(cursor + 8 + index * 2));
  return { name: className(cursor + 2), parent: className(cursor + 4), interfaces,
    public: Boolean(bytes.readUInt16BE(cursor) & 1) };
}

function jar(entries) {
  const contents = [], directory = [];
  let offset = 0, directoryBytes = 0;
  for (const [path, data] of entries) {
    const name = Buffer.from(path);
    const checksum = crc32(data);
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    if (path.endsWith('/')) entry.writeUInt32LE(16, 38);
    entry.writeUInt32LE(offset, 42);
    contents.push(header, name, data);
    directory.push(entry, name);
    offset += header.length + name.length + data.length;
    directoryBytes += entry.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directoryBytes, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...contents, ...directory, end]);
}

export async function compiledFlywayRuntime(root, source, output, signal) {
  if (typeof output !== 'string' || output.length > 240 || !compiledPath.test(output) ||
      output.split('/').some(part => /[. ]$/.test(part) || part.toLowerCase() === '.git')) throw new Error(invalid);
  const locations = [...new Set((source.locations ?? []).filter(path => path.startsWith('src/main/resources/'))
    .map(path => path.slice('src/main/resources/'.length)))];
  if (!locations.length || locations.some(path => !packagePath.test(path))) throw new Error(invalid);
  const classes = new Map(), migrations = [], callbacks = [], resources = [];
  const directories = locations.map(path => ({ path, depth: 0 }));
  let remaining = 4 * 1024 * 1024, inspected = 0;
  try {
    for (const { path, depth } of directories) {
      const folder = join(root, output, path);
      if (await realpath(folder) !== folder) throw new Error();
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        throwIfCancelled(signal);
        if (++inspected > 500 || entry.isSymbolicLink()) throw new Error();
        const name = path + '/' + entry.name;
        if (entry.isDirectory()) {
          if (depth >= 8 || !packagePath.test(name)) throw new Error();
          directories.push({ path: name, depth: depth + 1 });
          continue;
        }
        if (!entry.name.endsWith('.class') || classes.has(name)) continue;
        const file = output + '/' + name;
        const bytes = await readMigrationFile(join(root, file), Math.min(remaining, 256 * 1024), value => value);
        remaining -= bytes.length;
        const declaration = classDeclaration(bytes);
        const qualified = declaration.name?.replaceAll('/', '.');
        if (declaration.name !== name.slice(0, -6) || !packagePath.test(declaration.name)) throw new Error();
        const versioned = /^V(\d+(?:_\d+)*)__([\w$]+)\.class$/.exec(entry.name);
        if (declaration.interfaces.includes(migrationInterface) ||
            declaration.parent !== migrationType && /^(?:[VUB]\d+(?:_\d+)*|R)__[^$]+\.class$/.test(entry.name)) throw new Error();
        if (declaration.parent === migrationType) {
          if (!declaration.public || !versioned || !versionKey(versioned[1])) throw new Error();
          migrations.push({ kind: 'versioned', version: versioned[1], file, description: versioned[2].replaceAll('_', ' '),
            verified: true, javaClass: qualified });
        }
        if (declaration.interfaces.includes(callbackType)) {
          if (!declaration.public) throw new Error();
          callbacks.push(qualified);
        }
        resources.push(file);
        classes.set(name, bytes);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(invalid);
  }
  if (!migrations.length && !callbacks.length) throw new Error(invalid);
  const entries = new Map();
  for (const [path, bytes] of classes) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index++) entries.set(segments.slice(0, index).join('/') + '/', Buffer.alloc(0));
    entries.set(path, bytes);
  }
  return { locations, migrations, callbacks, resources, jar: jar(entries) };
}
