import { createHash } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { findMavenWrapper } from './project-detection.mjs';
import { scanProjectServices } from './project-services.mjs';
import { inspectToolchains, mavenProject } from './project-toolchains.mjs';

const fileInfo = (directory, name) => lstat(join(directory, name)).catch(() => null);
const regularFile = async (directory, name) => (await fileInfo(directory, name))?.isFile() === true;

async function otherInstalls({ folder: directory, pom }, root) {
  const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const [uvLock, pythonProject, requirements, venv] = await Promise.all([
    regularFile(directory, 'uv.lock'),
    regularFile(directory, 'pyproject.toml'), regularFile(directory, 'requirements.txt'), fileInfo(directory, '.venv')
  ]);
  const steps = [], issues = [];
  if (mavenProject(pom)) {
    const wrapper = await findMavenWrapper(directory, root);
    if (wrapper) {
      const launcher = process.platform === 'win32' && wrapper.startsWith('.\\') ? wrapper.slice(2) : wrapper;
      steps.push({ tool: 'Maven', command: launcher + ' -B -DskipTests dependency:go-offline',
        wrapper: launcher, args: ['-B', '-DskipTests', 'dependency:go-offline'], evidence: 'pom.xml · ' + launcher });
    } else issues.push('A Maven project was found without a Maven Wrapper.');
  }
  if (uvLock && pythonProject) {
    steps.push({ tool: 'uv', command: 'uv sync --locked', args: ['sync', '--locked'], evidence: 'pyproject.toml · uv.lock' });
  } else if (requirements) {
    const interpreter = venv?.isDirectory() && await stat(join(directory, python)).catch(() => null);
    if (interpreter?.isFile()) {
      steps.push({ tool: 'pip', command: python + ' -m pip install -r requirements.txt', executable: python,
        args: ['-m', 'pip', 'install', '-r', 'requirements.txt'], evidence: 'requirements.txt · .venv' });
    } else issues.push('A requirements.txt file was found. A local .venv is needed for automatic pip installation.');
  } else if (pythonProject) issues.push('The Python project has no supported dependency lockfile.');
  return { steps, issues };
}

export async function detectDependencyPlan(project) {
  const { identity, root, services, limited } = await scanProjectServices(project);
  const steps = [], issues = [];
  for (const service of services) {
    const { directory, manifestText, node, workspaceMember, unknownWorkspace } = service;
    if (node && !workspaceMember) {
      const { step, issue } = node;
      if (step) steps.push({ directory, ...step });
      if (issue) issues.push({ directory, message: issue });
      if (unknownWorkspace) {
        issues.push({ directory, message: 'Workspace membership could not be verified. Nested JavaScript installs were skipped.' });
      }
    } else if (manifestText && !workspaceMember) {
      issues.push({ directory, message: 'package.json could not be read as a valid manifest.' });
    }
    const [other, toolchains] = await Promise.all([otherInstalls(service, root), inspectToolchains(service.folder, root)]);
    steps.push(...[...other.steps, ...toolchains.installs].map(step => ({ directory, ...step })));
    issues.push(...[...other.issues, ...toolchains.issues].map(message => ({ directory, message })));
  }
  if (steps.length > 16 || limited) {
    steps.length = 0;
    issues.push({ directory: '.', message: 'This project has too many folders or install steps for automatic installation.' });
  }
  const id = createHash('sha256').update(JSON.stringify({ identity, steps, issues })).digest('hex');
  return { id, steps, issues, identity };
}
