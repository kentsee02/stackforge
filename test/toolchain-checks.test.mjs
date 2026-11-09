import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';
import { ProjectOperations } from '../src/project-operations.mjs';

async function fixture(t, files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-toolchains-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

async function connect(t, options) {
  const app = createApp(options).listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = 'http://127.0.0.1:' + app.address().port;
  const get = async path => (await fetch(base + path)).json();
  const { token } = await get('/api/state');
  const post = (path, body, authorized = true) => fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-StackForge-Token': authorized ? token : 'invalid'
  }, body: JSON.stringify(body) });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.shutdownTasks();
    await new Promise(done => app.close(done));
  };
  t.after(close);
  return { get, post, close };
}

async function importProject(post, path) {
  const response = await post('/api/projects/import', { path });
  assert.equal(response.status, 201);
  return (await response.json()).id;
}

async function outcome(get, id, kind) {
  for (let i = 0; i < 120; i++) {
    const { projects } = await get('/api/projects?logs=' + id);
    const task = projects.find(item => item.id === id)?.[kind];
    if (['succeeded', 'failed', 'cancelled'].includes(task?.status)) return task;
    await delay(25);
  }
  assert.fail('Operation did not finish');
}

test('reviewed external dependency plans and checks run the detected tool in the service directory', async t => {
  const win = process.platform === 'win32';
  const maven = win ? 'mvnw.cmd' : 'mvnw';
  const gradle = win ? 'gradlew.bat' : 'gradlew';
  const root = await fixture(t, {
    'services/java/build.gradle.kts': 'plugins { java }',
    ['services/java/' + gradle]: 'fixture',
    'services/dotnet/Demo Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    'services/go/go.mod': 'module example.com/server\n',
    'services/rust/Cargo.toml': '[package]\nname = "server"\n',
    'services/rust/Cargo.lock': 'version = 4',
    'services/php/composer.json': { require: { 'laravel/framework': '^12.0' }, scripts: { test: 'php artisan test' } },
    'services/ruby/Gemfile': 'gem "rails"\ngem "rubocop"\n',
    'services/ruby/test/app_test.rb': '',
    'services/spring/pom.xml': '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>',
    ['services/spring/' + maven]: 'fixture',
    'services/unwrapped/build.gradle': "plugins { id 'java' }",
    'services/ambiguous/One.csproj': '<Project/>',
    'services/ambiguous/Two.csproj': '<Project/>'
  });
  const calls = [];
  const operations = new ProjectOperations({ command: async (program, args, { cwd, shell }) => calls.push({ program, args, cwd, shell }) });
  const { get, post } = await connect(t, { stateDir: false, operations });
  const id = await importProject(post, root);
  const route = `/api/projects/${id}`;
  assert.ok((await get('/api/projects')).projects[0].frameworks.includes('ASP.NET Core'));
  assert.match((await get(route + '/startup-suggestions')).groups.find(group => group.directory === 'services/dotnet').choices[0].command, /--project "Demo Api.csproj"/);
  const plan = await get(route + '/dependencies');
  assert.deepEqual(Object.fromEntries(plan.steps.map(step => [step.directory, step.tool])), {
    'services/java': 'Gradle', 'services/dotnet': '.NET', 'services/go': 'Go', 'services/rust': 'Cargo',
    'services/php': 'Composer', 'services/ruby': 'Bundler', 'services/spring': 'Maven'
  });
  assert.match(plan.steps.find(step => step.tool === '.NET').command, /dotnet restore "Demo Api.csproj"/);
  assert.equal(plan.steps.find(step => step.tool === 'Cargo').command, 'cargo fetch --locked');
  assert.deepEqual(plan.issues.map(issue => issue.directory).sort(), ['services/ambiguous', 'services/unwrapped']);
  const { checks } = await get(route + '/checks');
  assert.deepEqual(checks.filter(check => check.directory === 'services/spring').map(check => check.name), ['package', 'test']);
  for (const expected of ['go vet ./...', 'dotnet test "Demo Api.csproj"', 'cargo build --locked', 'composer run-script test', 'bundle exec rails test', 'bundle exec rubocop']) {
    assert.ok(checks.some(check => check.command === expected), expected);
  }
  assert.deepEqual(calls, []);
  assert.equal((await post(route + '/install', { mode: 'detected', planId: plan.id })).status, 202);
  assert.equal((await outcome(get, id, 'dependencies')).status, 'succeeded');
  const restore = calls.find(call => call.program === 'dotnet');
  assert.deepEqual(restore.args, ['restore', 'Demo Api.csproj']);
  assert.equal(restore.cwd, join(root, 'services', 'dotnet'));
  const mavenTest = checks.find(check => check.directory === 'services/spring' && check.name === 'test');
  assert.equal((await post(route + '/run-check', { check: mavenTest.id })).status, 202);
  assert.equal((await outcome(get, id, 'checkTask')).status, 'succeeded');
  assert.equal(calls.at(-1).cwd, join(root, 'services', 'spring'));
  assert.match(calls.at(-1).args.join(' '), /-B test$/);
});

test('custom checks persist separately, run only by saved ID, and reject replaced project folders', async t => {
  const root = await fixture(t, { 'project/service/.keep': '' });
  const outside = await fixture(t, {});
  const project = join(root, 'project');
  await symlink(outside, join(project, 'outside'), 'junction');
  const options = { stateDir: join(root, 'state', 'jobs') };
  const first = await connect(t, options);
  const id = await importProject(first.post, project);
  const route = `/api/projects/${id}`;
  const commands = [{ name: 'lint', directory: 'service', command: `node -e "console.log('custom check passed')"` }];
  assert.equal((await first.post(route + '/check-config', { commands }, false)).status, 403);
  for (const directory of ['..', 'outside']) {
    assert.equal((await first.post(route + '/check-config', { commands: [{ ...commands[0], directory }] })).status, 400);
  }
  assert.equal((await first.post(route + '/check-config', { commands })).status, 200);
  assert.equal((await first.get('/api/projects?logs=' + id)).projects[0].checkTask, undefined);
  await first.close();
  const second = await connect(t, options);
  const saved = await second.get(route + '/checks');
  assert.deepEqual(saved.customChecks, commands);
  assert.equal((await second.post(route + '/run-check', { check: commands[0].command })).status, 409);
  assert.equal((await second.post(route + '/run-check', { check: saved.checks[0].id, command: 'invalid' })).status, 202);
  const task = await outcome(second.get, id, 'checkTask');
  assert.equal(task.status, 'succeeded');
  assert.match(task.log, /\r?\ncustom check passed/);
  await rename(project, join(root, 'moved'));
  await mkdir(join(project, 'service'), { recursive: true });
  assert.deepEqual((await second.get(route + '/checks')).checks, []);
  assert.equal((await second.post(route + '/check-config', { commands })).status, 400);
  assert.equal((await second.post(route + '/check-config', { commands: [] })).status, 200);
  assert.deepEqual((await second.get(route + '/checks')).customChecks, []);
});
