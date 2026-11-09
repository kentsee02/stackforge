import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';
import { ProjectOperations } from '../src/project-operations.mjs';
import { detectStartupSuggestions } from '../src/startup-suggestions.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'stackforge-startup-suggestions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(Object.entries(files).map(async ([name, value]) => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  }));
  return root;
}

test('workspace members inherit their package manager and offer declared startup choices', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'workspace', packageManager: 'pnpm@10.0.0', scripts: { dev: 'echo no known orchestration' } },
    'pnpm-workspace.yaml': "packages:\n  - 'services/*'\n",
    'services/web/package.json': { name: '@team/web', scripts: { dev: 'vite --port 5178', start: 'vite --port 5179 && echo done' } },
    'services/api/package.json': { name: 'api', scripts: { 'start:dev': 'nest start --watch', test: 'node test.mjs' } },
    'services/conflict/package.json': { packageManager: 'npm@11.0.0', scripts: { dev: 'node main.mjs' } },
    'services/no-start/package.json': { scripts: { test: 'node test.mjs' } },
    'frontend/package.json': { scripts: { dev: 'vite' } },
    'workers/queue/package.json': { name: 'queue', packageManager: 'bun@1.2.0', scripts: { start: 'bun worker.ts' } }
  });
  const startup = { services: [{ directory: 'workers/queue' }] };
  const { groups, limited } = await detectStartupSuggestions({ path: root, startup });
  assert.equal(limited, false);
  assert.deepEqual(Object.fromEntries(groups.map(group => [group.directory, group.choices])), {
    'services/web': [{ command: 'pnpm run dev', script: 'dev', port: 5178, kind: 'web' }, { command: 'pnpm run start', script: 'start', kind: 'web' }],
    'services/api': [{ command: 'pnpm run start:dev', script: 'start:dev', kind: 'api' }],
    'workers/queue': [{ command: 'bun run start', script: 'start' }]
  });
});

test('Spring Boot startup uses the POM folder, local or ancestor wrapper, and a literal HTTP port', async t => {
  const wrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
  const pom = name => `<project><artifactId>${name}</artifactId><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>`;
  const root = await fixture(t, {
    'pom.xml': pom('root-api'),
    [wrapper]: 'wrapper',
    'src/main/resources/application.properties': 'server.port=8081\n',
    'frontend/package.json': { scripts: { dev: 'react-router dev' } },
    'frontend/pnpm-lock.yaml': 'lockfileVersion: 9.0',
    'backend/pom.xml': pom('nested-api'),
    'backend/src/main/resources/application.yml': 'server:\n  servlet:\n    port: 10001\n  port: 9090 # development\n',
    'services/other/pom.xml': pom('other-api'),
    ['services/other/' + wrapper]: 'wrapper',
    'services/other/src/main/resources/application.properties': 'server.port=\u0024{PORT:8080}\n',
    'services/aggregate/pom.xml': '<project><artifactId>aggregate</artifactId><packaging>pom</packaging><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>'
  });
  const { groups } = await detectStartupSuggestions({ path: root });
  const choices = Object.fromEntries(groups.map(group => [group.directory, group.choices[0]]));
  assert.deepEqual(Object.keys(choices).sort(), ['.', 'backend', 'frontend', 'services/other']);
  assert.equal(choices['.'].command, '.' + sep + wrapper + ' spring-boot:run');
  assert.equal(choices['.'].port, 8081);
  assert.equal(choices.backend.command, '..' + sep + wrapper + ' spring-boot:run');
  assert.equal(choices.backend.port, 9090);
  assert.equal(choices.backend.kind, 'api');
  assert.equal(choices['services/other'].command, '.' + sep + wrapper + ' spring-boot:run');
  assert.equal(choices['services/other'].port, undefined);
  assert.equal(choices.frontend.command, 'pnpm run dev');
  assert.equal(choices.frontend.kind, 'web');
});

test('a recognized workspace launcher replaces its member suggestions', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'root', workspaces: ['apps/*'], scripts: { dev: 'turbo run dev', start: 'node one.mjs' } },
    'package-lock.json': '{}',
    'turbo.json': '{}',
    'apps/web/package.json': { scripts: { dev: 'vite --port 5173' } },
    'apps/api/package.json': { scripts: { dev: 'node server.mjs' } },
    'server/package.json': { name: 'other', scripts: { start: 'node main.mjs' } },
    'server/yarn.lock': '# yarn lockfile v1'
  });
  const { groups } = await detectStartupSuggestions({ path: root });
  assert.deepEqual(groups, [
    { directory: '.', name: 'root', choices: [{ command: 'npm run dev', script: 'dev', orchestrates: true }] },
    { directory: 'server', name: 'other', choices: [{ command: 'yarn run start', script: 'start' }] }
  ]);
});

test('mixed Python, .NET, Go, Rust, PHP, and Ruby services use their own entry directories', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'frontend', packageManager: 'npm@11.0.0', scripts: { dev: 'vite --port 5178' } },
    'backend/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'services/django/manage.py': "from django.core.management import execute_from_command_line\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'settings')",
    'services/django/pyproject.toml': '[project]\nname = "django-demo"\n',
    'services/django/uv.lock': 'version = 1\n',
    'services/flask/app.py': 'from flask import Flask\napp = Flask(__name__)\n',
    'Example.Api/Http.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    'Example.Api/Program.cs': 'app.MapControllers();',
    'Example.Api/Properties/launchSettings.json': { profiles: {
      Development: { commandName: 'Project', applicationUrl: 'https://localhost:7110;http://localhost:5110' }
    } },
    'services/go/go.mod': 'module example.com/server\n',
    'services/go/cmd/api/main.go': 'package main\nimport "net/http"\nfunc main() { http.ListenAndServe(":8080", nil) }',
    'services/rust/Cargo.toml': '[package]\nname = "rust-server"\n[dependencies]\naxum = "0.8"\n',
    'services/rust/src/main.rs': 'async fn main() {}',
    'services/php/composer.json': { require: { 'laravel/framework': '^12.0' } },
    'services/php/artisan': '<?php',
    'services/ruby/Gemfile': "source 'https://rubygems.org'\ngem 'rails', '~> 8.0'\n",
    'services/ruby/bin/rails': 'require "rails/commands"'
  });
  const { groups, limited } = await detectStartupSuggestions({ path: root });
  const python = process.platform === 'win32' ? 'python' : 'python3';
  assert.equal(limited, false);
  assert.deepEqual(Object.fromEntries(groups.map(group => [group.directory, group.choices[0].command])), {
    '.': 'npm run dev',
    backend: python + ' -m uvicorn app.main:app --reload',
    'services/django': 'uv run --no-sync python manage.py runserver',
    'services/flask': python + ' -m flask --app app.py run',
    'Example.Api': 'dotnet run --project Http.csproj --launch-profile Development',
    'services/go/cmd/api': 'go run .',
    'services/rust': 'cargo run --bin rust-server',
    'services/php': 'php artisan serve',
    'services/ruby': 'ruby bin/rails server'
  });
  const dotnet = groups.find(group => group.directory === 'Example.Api').choices[0];
  assert.equal(dotnet.port, 5110);
  assert.equal(dotnet.kind, 'api');
});

test('JVM suggestions require active plugins and prefer project wrappers', async t => {
  const gradle = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const root = await fixture(t, {
    [gradle]: 'wrapper',
    'build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.0" apply false }',
    'services/boot/build.gradle.kts': 'plugins { id("org.springframework.boot") }',
    'services/boot/src/main/resources/application.properties': 'server.port=8082',
    'services/quarkus/build.gradle': "plugins { id 'io.quarkus' }",
    'services/ktor/build.gradle.kts': 'plugins { id("io.ktor.plugin") }\napplication { mainClass.set("server.MainKt") }',
    'services/no-main/build.gradle.kts': 'plugins { id("io.ktor.plugin") }',
    'services/maven/pom.xml': '<project><build><plugins><plugin><artifactId>quarkus-maven-plugin</artifactId></plugin></plugins></build></project>',
    'services/micronaut/pom.xml': '<project><build><plugins><plugin><artifactId>micronaut-maven-plugin</artifactId></plugin></plugins></build></project>',
    'services/parent/pom.xml': '<project><build><pluginManagement><plugins><plugin><artifactId>quarkus-maven-plugin</artifactId></plugin></plugins></pluginManagement></build></project>'
  });
  const { groups } = await detectStartupSuggestions({ path: root });
  const launcher = ['..', '..', gradle].join(sep);
  assert.deepEqual(Object.fromEntries(groups.map(group => [group.directory, group.choices[0].command])), {
    'services/boot': launcher + ' bootRun',
    'services/quarkus': launcher + ' quarkusDev',
    'services/ktor': launcher + ' run',
    'services/maven': 'mvn quarkus:dev',
    'services/micronaut': 'mvn mn:run'
  });
  assert.equal(groups.find(group => group.directory === 'services/boot').choices[0].port, 8082);
});

test('declared cross-framework commands work and ambiguous entries stay manual', async t => {
  const root = await fixture(t, {
    'services/custom/Procfile.dev': 'worker: custom worker\r\nweb: custom serve --local\r\n',
    'services/custom/Procfile': 'web: custom serve --production\n',
    'services/duplicate/Procfile': 'web: first\nweb: second\n',
    'services/python/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'services/python/app.py': 'from flask import Flask\napp = Flask(__name__)\n',
    'services/dotnet/Tools.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    'services/go/main.go': 'package main\nimport "net/http"\nfunc main() { http.ListenAndServe(":8080", nil) }',
    'services/node/package.json': { name: 'api', packageManager: 'npm@11.0.0', dependencies: { express: '5.0.0' },
      scripts: { dev: 'vite', 'start:dev': 'node --watch api.mjs' } }
  });
  const { groups } = await detectStartupSuggestions({ path: root });
  assert.deepEqual(groups.map(group => group.directory), ['services/custom', 'services/node']);
  assert.deepEqual(groups[0].choices, [{ command: 'custom serve --local', script: 'Web process', source: 'Procfile.dev · web' }]);
  assert.deepEqual(groups[1].choices.map(choice => choice.kind), ['web', 'api']);
});

test('reading suggestions leaves saved custom configuration and project files untouched', async t => {
  const root = await fixture(t, {
    'package.json': { name: 'fixture', scripts: { dev: 'node should-not-run.mjs' } },
    'package-lock.json': '{}',
    'should-not-run.mjs': "import { writeFileSync } from 'node:fs'; writeFileSync('executed.txt', 'unexpected');"
  });
  const app = createApp({ stateDir: false });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await app.shutdownTasks(); await new Promise(resolve => app.close(resolve)); });
  const url = 'http://127.0.0.1:' + app.address().port;
  const get = async path => {
    const response = await fetch(url + path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const { token } = await get('/api/state');
  const post = async (path, body, status) => {
    const response = await fetch(url + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body) });
    assert.equal(response.status, status);
    return response.json();
  };
  const { id } = await post('/api/projects/import', { path: root }, 201);
  const saved = [{ name: 'Existing', directory: '.', command: 'node worker.js', installCommand: 'npm ci' }];
  await post('/api/projects/' + id + '/startup', { services: saved }, 200);
  const data = await get('/api/projects/' + id + '/startup-suggestions');
  assert.equal(data.groups[0].choices[0].command, 'npm run dev');
  assert.deepEqual((await get('/api/projects?logs=' + id)).projects[0].startupServices, saved);
  await assert.rejects(stat(join(root, 'executed.txt')), { code: 'ENOENT' });
});

test('one service scan feeds import labels, startup, dependencies and workspace checks before saving any configuration', async t => {
  const root = await realpath(await fixture(t, {
    'package.json': { packageManager: 'pnpm@10.0.0' },
    'pnpm-workspace.yaml': 'packages:\n  - modules/*\n',
    'modules/ui/package.json': { dependencies: { next: '16.0.0' }, scripts: { dev: 'next dev', build: 'next build' } },
    'services/python/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'services/python/pyproject.toml': '[project]\nname = "api"\ndependencies = ["fastapi"]',
    'services/python/uv.lock': 'version = 1',
    'Example.Api/Example.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    'pom.xml': '<project><packaging>pom</packaging><modules><module>features/payments/server</module></modules></project>',
    'features/payments/server/pom.xml': '<project><build><plugins><plugin><artifactId>quarkus-maven-plugin</artifactId></plugin></plugins></build></project>',
    'backend/go.mod': 'module example.com/http\n',
    'backend/cmd/api/main.go': 'package main\nimport "net/http"\nfunc main() { http.ListenAndServe(":8080", nil) }',
    'internal/tools/hidden/package.json': { packageManager: 'npm@11.0.0', dependencies: { fastify: '5.0.0' }, scripts: { start: 'node server.js', test: 'node --test' } },
    'services/php/composer.json': { require: { 'laravel/framework': '^12.0' } },
    'services/php/artisan': '<?php',
    'services/php/Procfile': 'web: php artisan serve --port=8080'
  }));
  const outside = await fixture(t, { 'package.json': { dependencies: { hono: '4.0.0' }, packageManager: 'pnpm@10.0.0', scripts: { dev: 'node app.js', test: 'node --test' } } });
  await symlink(outside, join(root, 'modules/outside'), 'junction');
  const calls = [];
  const operations = new ProjectOperations({ command: async (command, args, { cwd }) => { calls.push({ command, args, cwd }); } });
  const app = createApp({ stateDir: false, operations }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await app.shutdownTasks(); await new Promise(resolve => app.close(resolve)); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const get = async path => (await fetch(base + path)).json();
  const { token } = await get('/api/state');
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body) });
  const response = await post('/api/projects/import', { path: root });
  assert.equal(response.status, 201);
  const { id, external, frameworks } = await response.json();
  assert.equal(external, false);
  assert.deepEqual(frameworks.sort(), ['ASP.NET Core', 'FastAPI', 'Go', 'Laravel', 'Next.js', 'Quarkus']);
  const route = '/api/projects/' + id;
  const [startup, dependencies, checks] = await Promise.all(['startup-suggestions', 'dependencies', 'checks'].map(view => get(route + '/' + view)));
  assert.deepEqual(startup.groups.map(group => group.directory).sort(), ['Example.Api', 'backend/cmd/api', 'features/payments/server', 'modules/ui', 'services/php', 'services/python']);
  assert.equal(startup.groups.find(group => group.directory === 'services/php').choices[0].source, 'Procfile · web');
  assert.deepEqual(dependencies.steps.map(({ directory, command }) => [directory, command]), [['.', 'pnpm install'], ['services/python', 'uv sync --locked']]);
  assert.equal(checks.checks.length, 1);
  const [check] = checks.checks;
  assert.deepEqual([check.directory, check.tool, check.name], ['modules/ui', 'pnpm', 'build']);
  assert.deepEqual((await get('/api/projects?logs=' + id)).projects[0].startupServices, []);
  assert.deepEqual(calls, []);
  assert.equal((await post(route + '/run-check', { check: check.id })).status, 202);
  for (let i = 0; i < 40 && !calls.length; i++) await delay(25);
  assert.deepEqual(calls, [{ command: 'pnpm run build', args: [], cwd: join(root, 'modules', 'ui') }]);

  const configured = 'internal/tools/hidden';
  assert.equal((await post(route + '/startup', { services: [{ name: 'Custom path', directory: configured, command: 'npm run start' }] })).status, 200);
  assert.ok((await get('/api/projects')).projects[0].frameworks.includes('Fastify'));
  assert.ok((await get(route + '/startup-suggestions')).groups.some(group => group.directory === configured));
  assert.ok((await get(route + '/dependencies')).steps.some(step => step.directory === configured));
  assert.ok((await get(route + '/checks')).checks.some(item => item.directory === configured));
});
