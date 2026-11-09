import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { projectPathKey } from './project-config.mjs';
import { inspectRecordedProject } from './project-runtime.mjs';
import { scanProjectServices } from './project-services.mjs';
import { findMavenWrapper } from './project-detection.mjs';
import { resolveStartup } from './project-startup.mjs';
import { checkNames, inspectToolchains, mavenProject } from './project-toolchains.mjs';

const mavenGoals = ['package', 'test'];
const checkKey = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

export async function projectChecks(project) {
  await inspectRecordedProject(project);
  const { root, services } = await scanProjectServices(project);
  const checks = [];
  for (const { folder: cwd, directory, manifest, manager, managerConflict, pom } of services) {
    const scope = directory === '.' ? 'root' : ['frontend', 'backend'].includes(directory) ? directory : 'service';
    if (manifest && !managerConflict) {
      const scripts = manifest.scripts;
      const tool = manager ?? 'npm';
      const key = scope === 'service' ? 'service:' + checkKey(directory) : scope;
      for (const name of checkNames) {
        if (typeof scripts?.[name] === 'string' && scripts[name].trim()) {
          checks.push({ id: `${key}:${name}`, scope, directory, tool, name, cwd, command: `${tool} run ${name}` });
        }
      }
    }
    const wrapper = mavenProject(pom) && await findMavenWrapper(cwd, root);
    if (wrapper) {
      const managed = scope === 'backend' && project.backend === 'spring';
      for (const name of mavenGoals) {
        const kind = name === 'package' ? 'build' : 'test';
        const id = managed ? `maven:${name}` : `tool:${checkKey(directory + '\0maven')}:${kind}`;
        checks.push({ id, scope, directory, tool: 'maven', name, cwd, wrapper, args: ['-B', name], command: `Maven Wrapper ${name}` });
      }
    }
    const toolchains = await inspectToolchains(cwd, root);
    for (const check of toolchains.checks) {
      const id = `tool:${checkKey(directory + '\0' + check.tool)}:${check.name}`;
      checks.push({ ...check, id, scope, directory, cwd });
    }
  }
  for (const check of project.customChecks?.commands ?? []) {
    const resolved = await resolveStartup(project, [check], project.customChecks.identity).catch(() => null);
    if (!resolved) continue;
    const id = `custom:${checkKey(JSON.stringify(check))}:${check.name}`;
    checks.push({ ...resolved.commands[0], id, scope: 'service', tool: 'custom' });
  }
  const order = ['root', 'frontend', 'backend', 'service'];
  return checks.sort((left, right) => order.indexOf(left.scope) - order.indexOf(right.scope));
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
