import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { databaseKey, sqlName } from './database-discovery.mjs';
import { localSession } from './database-local.mjs';

const changed = 'The initialization plan changed. Preview the database initialization again.';
const unsupported = 'Use reviewed CREATE TABLE statements in database/migrations for automatic initialization.';
const columnType = /^(?:smallint|integer|int|bigint|boolean|bool|text|date|timestamp|datetime|(?:var)?char\([1-9]\d{0,3}\)|decimal\([1-9]\d?,\s*\d{1,2}\))$/i;
const column = /^([a-z][a-z\d_]{0,62})\s+((?:var)?char\(\d+\)|decimal\(\d+,\s*\d+\)|[a-z]+)((?:\s+(?:NOT NULL|NULL|PRIMARY KEY|UNIQUE))*)$/i;

function migrationTables(text, engine, filename) {
  const tables = [];
  for (const sql of text.replace(/^\s*--[^\r\n]*$/gm, '').split(';').map(item => item.trim()).filter(Boolean)) {
    const match = /^CREATE\s+TABLE\s+([a-z][a-z\d_]{0,62})\s*\(([\s\S]+)\)$/i.exec(sql);
    if (!match) throw new Error(unsupported);
    const columns = match[2].split(/,(?![^()]*\))/).map(line => {
      const item = column.exec(line.trim().replace(/\s+/g, ' '));
      if (!item || !columnType.test(item[2])) throw new Error(unsupported);
      const [, name, type, flags] = item;
      const quote = engine === 'postgres' ? '"' : '`';
      return `${quote}${name.toLowerCase()}${quote} ${type}${flags}`;
    });
    tables.push({ name: match[1].toLowerCase(), columns, file: filename });
  }
  return tables;
}

async function readMigrations(root, engine) {
  const directory = join(root, 'database', 'migrations');
  let files;
  try {
    if (await realpath(directory) !== directory) throw new Error(unsupported);
    files = await readdir(directory, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return []; throw new Error(unsupported); }
  const sqlFiles = files.filter(file => file.name.endsWith('.sql'));
  if (sqlFiles.length > 24) throw new Error(unsupported);
  const batches = await Promise.all(sqlFiles.sort((a, b) => a.name.localeCompare(b.name)).map(async file => {
    if (!file.isFile() || !/^[a-z\d_-]{1,80}\.sql$/i.test(file.name)) throw new Error(unsupported);
    const path = join(directory, file.name);
    if ((await lstat(path)).size > 16_384 || await realpath(path) !== path) throw new Error(unsupported);
    return migrationTables(await readFile(path, 'utf8'), engine, file.name);
  }));
  const tables = batches.flat();
  if (tables.length > 100 || new Set(tables.map(item => item.name)).size !== tables.length) throw new Error(unsupported);
  return tables;
}

export async function initializationPlan({ project, binding, target, credentials, command, signal, schema = false }) {
  const session = localSession(target, credentials, command, signal);
  const state = await session.inspect();
  const tables = schema ? await readMigrations(project.path, target.engine) : [];
  const steps = [];
  if (!state.exists && state.permissions.create) steps.push('create');
  if (tables.length && (state.exists ? state.permissions.initialize : state.permissions.create && state.permissions.inspectSchema)) steps.push('schema');
  const id = databaseKey(project.id, project.path, binding.instanceId, target, credentials.user, state.fingerprint, state.exists, state.empty, steps, tables);
  return { session, tables, id, state, steps };
}

export function publicInitializationPlan(plan) {
  const { id, steps, state: { exists, empty, version, permissions, fingerprint }, tables } = plan;
  return { id, steps, exists, empty, version, verified: Boolean(fingerprint), permissions,
    migrations: tables.map(({ file, name, columns }) => ({ file, table: name, columns })) };
}

export async function executeInitialization({ project, binding, target, credentials, command, signal, id, confirmName, schema,
  recordMigration, revalidate, recordVerification = async () => {} }) {
  if (target.name !== confirmName || !sqlName.test(confirmName)) throw new Error('Type the exact database name to confirm initialization.');
  const plan = await initializationPlan({ project, binding, target, credentials, command, signal, schema });
  if (plan.id !== id || !plan.steps.length || !plan.state.fingerprint) throw new Error(changed);
  const { session, tables, state } = plan;
  const check = async () => {
    await revalidate();
    const current = await session.inspect();
    if (current.fingerprint !== state.fingerprint) throw new Error(changed);
    return current;
  };
  if (plan.steps.includes('create')) {
    const current = await check();
    if (current.exists || !current.permissions.create) throw new Error(changed);
    const existsMessage = 'The database could not be created. Refresh the plan before retrying.';
    try { await session.query(session.guardedCreate(state.serverIdentity)); }
    catch (error) { if (error.name === 'AbortError') throw error; throw new Error(existsMessage); }
  }
  const current = await check();
  if (!current.exists) throw new Error('StackForge could not verify the initialized database.');
  if (!plan.steps.includes('schema')) {
    await recordVerification(current);
    return { initialized: true, schema: current.empty === true ? 'empty' : current.empty === false ? 'present' : 'unknown' };
  }
  if (!current.empty || !current.permissions.initialize) throw new Error(changed);
  const digest = databaseKey(tables);
  const postgres = target.engine === 'postgres';
  const statements = tables.map(({ name, columns }) =>
    `CREATE TABLE ${postgres ? 'public.' : ''}${session.quote(name)} (${columns.join(', ')});`).join('\n');
  try {
    await session.query(session.guardedSchema(state.serverIdentity, statements), target.name);
    const after = await check();
    if (after.empty) throw new Error(changed);
    const list = tables.map(table => `'${table.name}'`).join(', ');
    const tableCount = await session.query(`SELECT COUNT(DISTINCT table_name) FROM information_schema.tables
      WHERE table_schema = ${postgres ? "'public'" : 'DATABASE()'} AND table_type='BASE TABLE' AND table_name IN (${list});`, target.name);
    if (Number(tableCount) !== tables.length) throw new Error(changed);
    await recordVerification(after);
  } catch (error) {
    await recordMigration(digest, error.name === 'AbortError' ? 'cancelled' : 'failed');
    if (error.name === 'AbortError') throw error;
    throw new Error('Schema initialization did not finish. Review the database before retrying.');
  }
  await recordMigration(digest, 'succeeded');
  return { initialized: true, schema: 'verified' };
}
