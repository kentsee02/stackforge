import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { projectPathKey } from './project-config.mjs';
import { inspectRecordedProject } from './project-runtime.mjs';

const npmScripts = ['build', 'test', 'lint'];
const mavenGoals = ['package', 'test'];
const mavenWrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';

async function localFile(directory, filename, maxSize = Infinity) {
  const path = join(directory, filename);
  const file = await lstat(path).catch(error => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  });
  return file?.isFile() && file.size <= maxSize ? path : undefined;
}

export async function projectChecks(project) {
  const { directory } = await inspectRecordedProject(project);
  const checks = [];
  for (const scope of ['root', 'frontend', 'backend']) {
    const cwd = scope === 'root' ? directory : join(directory, scope);
    const actual = await realpath(cwd).catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return '';
      throw error;
    });
    if (!actual || projectPathKey(actual) !== projectPathKey(cwd)) continue;

    const manifest = await localFile(cwd, 'package.json', 512 * 1024);
    if (manifest) {
      const content = await readFile(manifest, 'utf8');
      let scripts;
      try { scripts = JSON.parse(content.replace(/^\uFEFF/, ''))?.scripts; }
      catch { /* npm scripts are unavailable until this package.json is valid. */ }
      for (const name of npmScripts) {
        if (typeof scripts?.[name] === 'string' && scripts[name].trim()) {
          checks.push({ id: `${scope}:${name}`, scope, tool: 'npm', name, cwd });
        }
      }
    }
    if (scope === 'backend' && project.backend === 'spring' && await localFile(cwd, 'pom.xml') && await localFile(cwd, mavenWrapper)) {
      for (const name of mavenGoals) checks.push({ id: `maven:${name}`, scope, tool: 'maven', name, cwd });
    }
  }
  return checks;
}

export async function projectGitStatus(project, command) {
  const { directory } = await inspectRecordedProject(project);
  try { await lstat(join(directory, '.git')); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'absent' }; throw error; }

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const options = { cwd: directory, env, stdoutOnly: true, timeout: 5000 };
  try {
    const root = (await command('git', ['rev-parse', '--show-toplevel'], options)).replace(/\r?\n$/, '');
    if (projectPathKey(await realpath(root)) !== projectPathKey(directory)) return { status: 'absent' };
    const output = await command('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status',
      '--porcelain=v2', '--branch', '--ahead-behind', '--untracked-files=normal', '--ignore-submodules=dirty'],
    { ...options, stdoutLimit: 1024 * 1024 });
    if (!output.startsWith('# branch.oid ')) throw new Error();
    const lines = output.split(/\r?\n/);
    const header = name => lines.find(line => line.startsWith(`# branch.${name} `))?.slice(`# branch.${name} `.length);
    const head = header('head');
    if (!head) throw new Error();
    const comparison = /^\+(\d+) -(\d+)$/.exec(header('ab'));
    return {
      status: 'available',
      branch: head === '(detached)' ? null : head,
      initial: header('oid') === '(initial)',
      changes: lines.filter(line => /^[12u?] /.test(line)).length,
      upstream: header('upstream') ?? null,
      ahead: comparison ? Number(comparison[1]) : null,
      behind: comparison ? Number(comparison[2]) : null
    };
  } catch {
    throw new Error('Could not read Git status. Check that Git is installed and the repository is accessible.');
  }
}
