import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverDatabases } from '../../src/database/discovery.mjs';
import { createApp } from '../../src/http/server.mjs';
import { ProjectOperations } from '../../src/projects/project-operations.mjs';
import { cloneGithub } from '../../src/projects/project-clone.mjs';
import { detectStartupSuggestions } from '../../src/projects/detection/startup-suggestions.mjs';

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

test('nested .NET hosts contribute startup suggestions and database settings from the same directories', async t => {
  const first = 'services/retail/components/host';
  const second = 'samples/edition/components/api';
  const root = await fixture(t, {
    [first + '/Web.csproj']: '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    [first + '/Properties/launchSettings.json']: '{\n // Local profile\n"profiles": {"Dev": {"commandName": "Project", "applicationUrl": "http://localhost:5104", }},\n}',
    [first + '/appsettings.Development.json']: '\ufeff{\n /* Local database */ "ConnectionStrings": {"Default": "Host=localhost;Database=inventory;Username=app", },\n}',
    [second + '/Api.fsproj']: '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    [second + '/appsettings.json']: { ConnectionStrings: { Default: 'Host=localhost;Database=catalog;Username=app' } },
    'samples/edition/components/library/Library.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    'samples/edition/obj/generated/Ignored.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />'
  });
  const project = { id: 'nested-dotnet-fixture', path: root };
  const [startup, databases] = await Promise.all([detectStartupSuggestions(project), discoverDatabases(project)]);
  assert.deepEqual(Object.fromEntries(startup.groups.map(({ directory, choices: [choice] }) => [directory, choice.command])), {
    [first]: 'dotnet run --project Web.csproj --launch-profile Dev',
    [second]: 'dotnet run --project Api.fsproj --no-launch-profile'
  });
  assert.equal(startup.groups.find(group => group.directory === first).choices[0].port, 5104);
  assert.deepEqual(databases.requirements.map(({ directory, source, engine, status }) => [directory, source, engine, status]).sort(), [
    [second, second + '/appsettings.json', 'postgres', 'configured'],
    [first, first + '/appsettings.Development.json', 'postgres', 'configured']
  ]);
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

test('FastAPI suggestions resolve multi-name imports and typed factory objects in their service directories', async t => {
  const path = await fixture(t, {
    'app/main.py': 'from fastapi import Depends, FastAPI\napp = FastAPI(docs_url="/reference")\n',
    'backend/src/main.py': 'import fastapi\nfrom src.config import settings\n\n' +
      'def initialize_backend_application() -> fastapi.FastAPI:\n    app = fastapi.FastAPI(**settings.attributes)\n    return app\n\n' +
      'backend_app: fastapi.FastAPI = initialize_backend_application()\n',
    'services/ambiguous/main.py': 'from fastapi import FastAPI\nfirst = FastAPI()\nsecond = FastAPI()\n'
  });
  const { groups } = await detectStartupSuggestions({ path });
  const fastapi = groups.filter(item => item.name === 'FastAPI');
  assert.deepEqual(fastapi.map(({ directory, choices: [choice] }) => [directory, choice.command.split(' -m uvicorn ')[1], choice.openPath]), [
    ['.', 'app.main:app --reload', '/reference'], ['backend', 'src.main:backend_app --reload', undefined]
  ]);
});

test('FastAPI supports declared entrypoints and discovers differently named applications in packages', async t => {
  const path = await fixture(t, {
    'services/catalog/pyproject.toml': '[project]\ndependencies = ["fastapi"]\n[tool.fastapi]\n# Select the service\nentrypoint = "products.http.gateway:application"\n[tool.other]\nflag = true\n',
    'services/catalog/src/products/http/gateway.py': 'from products.factory import build\napplication = build()\n',
    'services/catalog/main.py': 'from fastapi import FastAPI\nother = FastAPI()\n',
    'services/search/requirements.txt': 'fastapi[standard]\n',
    'services/search/api/http/entry.py': 'import os, fastapi as service\nsearch = service.FastAPI()\n',
    'services/search/tests/test_server.py': 'from fastapi import FastAPI\nfake = FastAPI()\n'
  });
  const result = (await detectStartupSuggestions({ path })).groups.filter(item => item.name === 'FastAPI');
  assert.deepEqual(result.map(group => [group.directory, group.choices[0].command.split(' -m uvicorn ')[1]]), [
    ['services/search', 'api.http.entry:search --reload'],
    ['services/catalog', 'products.http.gateway:application --reload --app-dir src']
  ]);
});

test('startup suggestions read literal endpoints from framework config, CLI flags and entry points', async t => {
  const pkg = (dev, dependencies) => ({ packageManager: 'npm@11.0.0', scripts: { dev }, dependencies });
  const pom = plugin => `<project><build><plugins><plugin><artifactId>${plugin}-maven-plugin</artifactId></plugin></plugins></build></project>`;
  const root = await fixture(t, {
    'frontend/package.json': { ...pkg('vite'), scripts: { dev: 'vite', start: 'vite --port 4179 --base=/override/' } },
    'frontend/vite.config.ts': "export default defineConfig({ server: { port: 4178, proxy: { '/api': { port: 9999 } } }, base: '/workspace/' })",
    'services/next/package.json': pkg('next dev -p 3012'),
    'services/next/next.config.ts': "const nextConfig: NextConfig = { basePath: '/portal' };\nexport default nextConfig;",
    'services/angular/package.json': pkg('ng serve --configuration local'),
    'services/angular/angular.json': { projects: { app: { architect: { serve: { options: { servePath: '/angular' }, configurations: { local: { port: 4207 } } } } } } },
    'services/nest/package.json': pkg('nest start --watch', { '@nestjs/core': '11.0.0' }),
    'services/nest/src/main.ts': "SwaggerModule.setup('reference', app, document);\nawait app.listen(3033);",
    'backend/pom.xml': pom('spring-boot'),
    'backend/src/main/resources/application.yml': 'server:\n  port: 8081\n  servlet:\n    context-path: /sales\nspringdoc:\n  swagger-ui:\n    path: /reference\n',
    'services/quarkus/pom.xml': pom('quarkus'),
    'services/quarkus/src/main/resources/application.properties': 'quarkus.http.port=8080\n%dev.quarkus.http.port=8082\nquarkus.swagger-ui.path=/local-docs',
    'services/net/Demo.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    'services/net/Properties/launchSettings.json': { profiles: { http: { commandName: 'Project', applicationUrl: 'http://localhost:5117', launchUrl: 'swagger/index.html' } } },
    'services/python/Procfile.dev': 'web: uvicorn main:app --port 8004\n',
    'services/python/main.py': "from fastapi import FastAPI\napp = FastAPI(docs_url='/reference')\n",
    'services/go/go.mod': 'module example.com/http\n',
    'services/go/main.go': 'package main\nimport "net/http"\nfunc main() { http.HandleFunc("/health", handler); http.ListenAndServe(":8099", nil) }',
    'services/rust/Cargo.toml': '[package]\nname = "api"\n[dependencies]\naxum = "0.8"\n',
    'services/rust/src/main.rs': 'async fn main() { TcpListener::bind("127.0.0.1:3034").await; }',
    'services/ruby/Gemfile': 'gem "rails"\n',
    'services/ruby/bin/rails': 'require "rails/commands"',
    'services/ruby/config/puma.rb': 'port 3035\n',
    'services/ktor/build.gradle.kts': 'plugins { id("io.ktor.plugin") }\napplication { mainClass.set("io.ktor.server.netty.EngineMain") }',
    'services/ktor/src/main/resources/application.conf': 'ktor { deployment { port = 8083 } application { modules = [] } }'
  });
  const { groups, limited } = await detectStartupSuggestions({ path: root });
  const pairs = Object.fromEntries(groups.map(group => [group.directory, group.choices.map(({ port, openPath }) => [port, openPath])]));
  assert.equal(limited, false);
  assert.deepEqual(pairs, {
    frontend: [[4178, '/workspace/'], [4179, '/override/']], backend: [[8081, '/sales/reference']],
    'services/next': [[3012, '/portal']], 'services/angular': [[4207, '/angular']], 'services/nest': [[3033, '/reference']],
    'services/quarkus': [[8082, '/local-docs']], 'services/net': [[5117, '/swagger/index.html']], 'services/python': [[8004, '/reference']],
    'services/go': [[8099, '/health']], 'services/rust': [[3034, undefined]], 'services/ruby': [[3035, undefined]], 'services/ktor': [[8083, undefined]]
  });
});

test('startup endpoints leave dynamic, ambiguous and non-local values for manual entry', async t => {
  const root = await fixture(t, {
    'frontend/package.json': { packageManager: 'npm@11.0.0', scripts: { dev: 'vite --port $PORT' } },
    'frontend/vite.config.ts': 'export default defineConfig({ server: { port: 4444 }, base: "/ignored/" })',
    'services/spread/package.json': { packageManager: 'npm@11.0.0', scripts: { dev: 'vite' } },
    'services/spread/vite.config.ts': 'export default { server: { port: 4445 }, ...environmentSettings }',
    'services/net/Demo.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    'services/net/Properties/launchSettings.json': { profiles: { https: { commandName: 'Project', applicationUrl: 'https://localhost:5117', launchUrl: '//external.example/path' } } },
    'services/tls/pom.xml': '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>',
    'services/tls/src/main/resources/application.properties': 'server.port=8443\nserver.ssl.enabled=true\nspringdoc.swagger-ui.path=/reference',
    'services/go/go.mod': 'module example.com/http\n',
    'services/go/main.go': 'package main\nimport "net/http"\nfunc main() { http.HandleFunc("/one", handler); http.HandleFunc("/two", handler); http.ListenAndServe(":8082", nil); http.ListenAndServe(":8083", nil) }'
  });
  const { groups } = await detectStartupSuggestions({ path: root });
  assert.equal(groups.length, 5);
  for (const { choices: [choice] } of groups) {
    assert.equal(choice.port, undefined);
    assert.equal(choice.openPath, undefined);
  }
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

test('local imports and clones share nested service evidence across startup, dependencies, databases and checks', async t => {
  const frontend = 'areas/customers/retail/display';
  const python = 'integrations/partners/search/http';
  const node = 'internal/tools/inventory/http';
  const java = 'features/payments/server';
  const django = 'workloads/accounts/identity/http';
  const compose = 'ops/env/local/data';
  const root = await realpath(await fixture(t, {
    'package.json': { packageManager: 'pnpm@10.0.0' },
    'pnpm-workspace.yaml': 'packages:\n  - areas/customers/retail/*\n',
    [frontend + '/package.json']: { dependencies: { next: '16.0.0' }, scripts: { dev: 'next dev', build: 'next build' } },
    [python + '/main.py']: 'from fastapi import FastAPI\napp = FastAPI()\n',
    [python + '/pyproject.toml']: '[project]\nname = "api"\ndependencies = ["fastapi"]',
    [python + '/uv.lock']: 'version = 1',
    [python + '/.env']: 'DATABASE_URL=postgresql://app@localhost:5432/search',
    'Example.Api/Example.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    'pom.xml': '<project><packaging>pom</packaging><modules><module>features/payments/server</module></modules></project>',
    [java + '/pom.xml']: '<project><build><plugins><plugin><artifactId>quarkus-maven-plugin</artifactId></plugin></plugins></build></project>',
    [java + '/src/main/resources/application-local.properties']: 'quarkus.datasource.jdbc.url=jdbc:postgresql://localhost:5432/payments',
    'backend/go.mod': 'module example.com/http\n',
    'backend/cmd/api/main.go': 'package main\nimport "net/http"\nfunc main() { http.ListenAndServe(":8080", nil) }',
    [node + '/package.json']: { packageManager: 'npm@11.0.0', dependencies: { fastify: '5.0.0' }, scripts: { start: 'node server.js', test: 'node --test' } },
    [node + '/.env']: 'DATABASE_URL=mysql://app@localhost:3306/inventory',
    [django + '/manage.py']: 'import os\nfrom django.core.management import execute_from_command_line\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "accounts.settings.local")\n',
    [django + '/accounts/settings/local.py']: 'DATABASES = {"default": {"ENGINE": "django.db.backends.mysql"}}\n',
    [compose + '/compose.yml']: 'services:\n  cache:\n    image: redis:7\n',
    'services/php/composer.json': { require: { 'laravel/framework': '^12.0' } },
    'services/php/artisan': '<?php',
    'services/php/Procfile': 'web: php artisan serve --port=8080',
    'node_modules/ignored/package.json': { dependencies: { hono: '4.0.0' }, packageManager: 'npm@11.0.0', scripts: { start: 'node index.js' } },
    'dist/ignored/compose.yml': 'services:\n  ignored:\n    image: mysql:8.4\n'
  }));
  const outside = await fixture(t, { 'package.json': { dependencies: { hono: '4.0.0' }, packageManager: 'pnpm@10.0.0', scripts: { dev: 'node app.js', test: 'node --test' } } });
  const linked = join(root, 'areas/customers/retail/outside');
  await symlink(outside, linked, 'junction');
  const cloneParent = await fixture(t, {});
  const calls = [];
  const operations = new ProjectOperations({ command: async (command, args, { cwd }) => { calls.push({ command, args, cwd }); } });
  const app = createApp({ stateDir: false, operations, clone: (repo, parent, options) => cloneGithub(repo, parent, {
    ...options, command: async (program, args) => {
      assert.equal(program, 'git');
      await cp(root, args.at(-1), { recursive: true, filter: source => source !== linked });
      await mkdir(join(args.at(-1), '.git'));
    }
  }) }).listen(0, '127.0.0.1');
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
  assert.deepEqual(frameworks.sort(), ['ASP.NET Core', 'Django', 'FastAPI', 'Fastify', 'Go', 'Laravel', 'Next.js', 'Quarkus']);
  const route = '/api/projects/' + id;
  const readViews = path => Promise.all(['startup-suggestions', 'dependencies', 'checks', 'database-discovery'].map(view => get(path + '/' + view)));
  const databaseTargets = ({ requirements }) => requirements.map(({ directory, engine, status }) => [directory, engine, status]);
  const [startup, dependencies, checks, databases] = await readViews(route);
  assert.equal(startup.limited, false);
  assert.deepEqual(startup.groups.map(group => group.directory).sort(), ['Example.Api', frontend, 'backend/cmd/api', java, python, node, 'services/php', django]);
  assert.equal(startup.groups.find(group => group.directory === 'services/php').choices[0].source, 'Procfile · web');
  assert.deepEqual(Object.fromEntries(dependencies.steps.map(({ directory, command }) => [directory, command])), {
    '.': 'pnpm install', backend: 'go mod download', 'Example.Api': 'dotnet restore Example.Api.csproj',
    'services/php': 'composer install --no-interaction', [python]: 'uv sync --locked', [node]: 'npm install'
  });
  assert.deepEqual(databaseTargets(databases), [[java, 'postgres', 'configured'], [python, 'postgres', 'configured'],
    [node, 'mysql', 'configured'], [compose, 'redis', 'unverified'], [django, 'mysql', 'declared']]);
  const check = checks.checks.find(item => item.directory === frontend);
  assert.deepEqual([check.directory, check.tool, check.name], [frontend, 'pnpm', 'build']);
  const clone = await post('/api/projects/clone', { repository: 'https://github.com/example/multiservice', parentDir: cloneParent });
  assert.equal(clone.status, 201);
  const cloned = await clone.json();
  assert.deepEqual(cloned.frameworks.sort(), frameworks);
  const [clonedStartup, clonedDependencies, clonedChecks, clonedDatabases] = await readViews('/api/projects/' + cloned.id);
  assert.deepEqual(clonedStartup, startup);
  assert.deepEqual(clonedDependencies.steps, dependencies.steps);
  assert.deepEqual(clonedChecks, checks);
  assert.deepEqual(databaseTargets(clonedDatabases), databaseTargets(databases));
  assert.deepEqual((await get('/api/projects?logs=' + id)).projects.find(project => project.id === id).startupServices, []);
  assert.deepEqual(calls, []);
  assert.equal((await post(route + '/run-check', { check: check.id })).status, 202);
  for (let i = 0; i < 40 && !calls.length; i++) await delay(25);
  assert.deepEqual(calls, [{ command: 'pnpm run build', args: [], cwd: join(root, frontend) }]);

  const services = [{ name: 'Custom path', directory: node, command: 'npm run start' }];
  assert.equal((await post(route + '/startup', { services })).status, 200);
  const saved = (await get('/api/projects?logs=' + id)).projects.find(project => project.id === id).startupServices;
  assert.deepEqual(saved.map(({ name, directory, command }) => ({ name, directory, command })), services);
});

test('independent root and nested launchers both survive a bounded scan', async t => {
  const manifest = { packageManager: 'npm@11.0.0', scripts: { start: 'node index.js' } };
  const nested = 'retail/europe/catalog/preview';
  const beyondLimit = Array(13).fill('nested').join('/');
  const path = await fixture(t, {
    'package.json': manifest,
    [nested + '/package.json']: manifest,
    [beyondLimit + '/package.json']: manifest
  });
  const result = await detectStartupSuggestions({ path });
  assert.equal(result.limited, true);
  assert.deepEqual(result.groups.map(group => group.directory), ['.', nested]);
});
