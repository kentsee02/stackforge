import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { findBuildWrapper, localText, npmManifest } from './project-detection.mjs';

export const checkNames = ['build', 'test', 'lint'];
export const mavenProject = pom => /<project(?=[\s/>])/.test(pom);
const fileInfo = (folder, file) => lstat(join(folder, file)).catch(() => null);
const file = async (folder, name) => (await fileInfo(folder, name))?.isFile();
const dir = async (folder, name) => (await fileInfo(folder, name))?.isDirectory();

const command = (tool, program, args, evidence, shell = false) => ({ tool, program, args, evidence, shell,
  command: [program, ...args.map(arg => arg.includes(' ') ? `"${arg}"` : arg)].join(' ') });

async function dotnetTarget(folder) {
  const entries = await opendir(folder).catch(() => null);
  if (!entries) return;
  const solutions = [], projects = [];
  let count = 0;
  try {
    for await (const entry of entries) {
      if (++count > 192) return;
      if (!entry.isFile() || !/^[a-z0-9][a-z0-9_. -]{0,119}\.(?:slnx?|csproj|fsproj|vbproj)$/i.test(entry.name)) continue;
      const content = (await localText(folder, entry.name)).replace(/<!--[\s\S]*?-->/g, '');
      if (/\.slnx?$/i.test(entry.name)) {
        if (/Microsoft Visual Studio Solution File|<Solution(?=[\s/>])/.test(content)) solutions.push(entry.name);
      } else if (/<Project(?=[\s/>])/.test(content)) projects.push(entry.name);
    }
  } catch { return; }
  const candidates = solutions.length ? solutions : projects;
  return candidates.length === 1 ? candidates[0] : candidates.length > 1 ? null : undefined;
}

export async function inspectToolchains(folder, root) {
  const [kotlin, groovy, go, cargo, composerText, gemfile, dotnet] = await Promise.all([
    ...['build.gradle.kts', 'build.gradle', 'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile'].map(name => localText(folder, name)),
    dotnetTarget(folder)
  ]);
  const installs = [], checks = [], issues = [];
  const add = (name, spec) => checks.push({ name, ...spec });
  const gradle = (kotlin + '\n' + groovy).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
  const jvm = gradle.split(/[\r\n;]/).some(line => !/\bapply\s*\(?\s*false\b/.test(line) &&
    /\bid\s*\(?\s*['"](?:java(?:-library)?|application|org\.springframework\.boot|org\.jetbrains\.kotlin\.jvm|io\.quarkus|io\.micronaut\.application|io\.ktor\.plugin)['"]|(?:^|\{)\s*(?:java(?:-library)?|application)\s*(?:$|\})|\bkotlin\s*\(\s*['"]jvm['"]/.test(line));
  if (jvm) {
    const wrapper = await findBuildWrapper(folder, root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    if (wrapper) {
      const evidence = (kotlin ? 'build.gradle.kts' : 'build.gradle') + ' · ' + wrapper;
      const task = name => command('Gradle', wrapper, [name], evidence, process.platform === 'win32');
      installs.push(task('classes'));
      add('build', task('assemble'));
      add('test', task('test'));
    } else issues.push('A JVM Gradle project was found without a Gradle Wrapper.');
  }
  if (dotnet) {
    const task = name => command('.NET', 'dotnet', [name, dotnet], dotnet);
    installs.push(task('restore'));
    add('build', task('build'));
    add('test', task('test'));
    if (await file(folder, '.editorconfig')) add('lint', command('.NET', 'dotnet', ['format', dotnet, '--verify-no-changes'], dotnet + ' · .editorconfig'));
  } else if (dotnet === null) issues.push('Multiple .NET projects or solutions were found in this folder.');
  if (/^[ \t]*module[ \t]+\S+/m.test(go)) {
    const task = name => command('Go', 'go', [name, './...'], 'go.mod');
    installs.push(command('Go', 'go', ['mod', 'download'], 'go.mod'));
    add('build', task('build'));
    add('test', task('test'));
    add('lint', task('vet'));
  }
  if (/^[ \t]*\[(?:package|workspace)\][ \t]*(?:#.*)?$/m.test(cargo)) {
    const locked = await file(folder, 'Cargo.lock');
    const evidence = locked ? 'Cargo.toml · Cargo.lock' : 'Cargo.toml';
    const task = name => command('Cargo', 'cargo', [name, ...(locked ? ['--locked'] : [])], evidence);
    installs.push(task('fetch'));
    add('build', task('build'));
    add('test', task('test'));
    if (await file(folder, 'rustfmt.toml') || await file(folder, '.rustfmt.toml')) {
      add('lint', command('Cargo', 'cargo', ['fmt', '--all', '--', '--check'], evidence));
    }
  }
  const composer = npmManifest(composerText);
  if (composer && typeof composer === 'object' && !Array.isArray(composer)) {
    const evidence = await file(folder, 'composer.lock') ? 'composer.json · composer.lock' : 'composer.json';
    const task = args => command('Composer', 'composer', args, evidence, process.platform === 'win32');
    installs.push(task(['install', '--no-interaction']));
    for (const name of checkNames) {
      const script = composer.scripts?.[name];
      if ((typeof script === 'string' && script.trim()) || (Array.isArray(script) && script.length && script.every(value => typeof value === 'string' && value.trim()))) {
        add(name, task(['run-script', name]));
      }
    }
    const testRunner = composer['require-dev']?.['phpunit/phpunit'] ?? composer['require-dev']?.['pestphp/pest'];
    if (!checks.some(check => check.tool === 'Composer' && check.name === 'test') && typeof testRunner === 'string' &&
        typeof composer.require?.['laravel/framework'] === 'string' && await file(folder, 'artisan')) {
      add('test', command('Laravel', 'php', ['artisan', 'test'], 'composer.json · artisan'));
    }
  }
  if (/^[ \t]*(?:source|gem|gemspec)\b/m.test(gemfile)) {
    const evidence = await file(folder, 'Gemfile.lock') ? 'Gemfile · Gemfile.lock' : 'Gemfile';
    const task = args => command('Bundler', 'bundle', args, evidence, process.platform === 'win32');
    installs.push(task(['install']));
    if (/^[ \t]*gem\s+['"]rails['"]/m.test(gemfile) && await dir(folder, 'test')) add('test', task(['exec', 'rails', 'test']));
    if (/^[ \t]*gem\s+['"]rubocop(?:-rails-omakase)?['"]/m.test(gemfile)) add('lint', task(['exec', 'rubocop']));
  }
  return { installs, checks, issues };
}
