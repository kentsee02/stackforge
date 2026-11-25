import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/http/server.mjs';
import { run } from '../../src/platform/process.mjs';
import { cloneGithub } from '../../src/projects/project-clone.mjs';
import { ProjectOperations } from '../../src/projects/project-operations.mjs';
import { createDesktop } from '../../src/platform/desktop.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-browser-')));
const project = join(root, 'portal');
const monorepo = join(root, 'monorepo');
const fixtureRepo = join(root, 'upstream');
const checkoutParent = join(root, 'checkouts');
const repository = 'https://github.com/stackforge-test/cloned-portal';
const healthPath = '/browser-ready';
const fixtureServer = name => `
  import { createServer } from 'node:http';
  const name = ${JSON.stringify(name)};
  const path = ${JSON.stringify(healthPath)};
  createServer((request, response) => {
    if (request.url !== path) { response.writeHead(404).end(); return; }
    response.end(name + ' is ready');
  }).listen(Number(process.env.PORT), '127.0.0.1', () => console.log(name + ' is listening'));
`;

async function availablePort() {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function cloneFixture(url, parent, options) {
  const command = (program, args, config) => {
    const separator = args.indexOf('--');
    assert.equal(program, 'git');
    assert.equal(args[separator + 1], repository + '.git');
    // Keep the real Git checkout and StackForge promotion, using a fixture transport.
    return run(program, ['-c', 'protocol.file.allow=always', ...args.slice(0, separator + 1), fixtureRepo, args.at(-1)], config);
  };
  return cloneGithub(url, parent, { ...options, command });
}

let app, browser;
try {
  await mkdir(join(project, 'prisma'), { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({
    name: 'portal', packageManager: 'npm@11.0.0',
    scripts: { dev: 'node server.mjs', test: 'node --test' }, dependencies: { pg: '8.0.0', express: '5.0.0' }
  }));
  await writeFile(join(project, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }');
  await writeFile(join(project, 'prisma.config.ts'), 'import "dotenv/config";\nexport default { datasource: { url: env("DATABASE_URL") } };');
  await writeFile(join(project, 'server.mjs'), fixtureServer('Imported portal'));
  await mkdir(fixtureRepo);
  await writeFile(join(fixtureRepo, 'server.mjs'), fixtureServer('Cloned portal'));
  await writeFile(join(fixtureRepo, 'package.json'), JSON.stringify({ name: 'cloned-portal', dependencies: { express: '5.0.0' },
    devDependencies: { 'drizzle-kit': '^0.31.1' } }));
  await mkdir(join(fixtureRepo, 'frontend'));
  await writeFile(join(fixtureRepo, 'frontend/package.json'), '{"name":"approval-fixture","packageManager":"pnpm@11.17.0"}');
  await writeFile(join(fixtureRepo, 'frontend/pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await mkdir(join(fixtureRepo, 'services/api/alembic/versions'), { recursive: true });
  await writeFile(join(fixtureRepo, 'services/api/alembic.ini'), '[alembic]\nscript_location = %(here)s/alembic\n');
  await writeFile(join(fixtureRepo, 'services/api/alembic/versions/first.py'), "revision = 'start'\ndown_revision = None\n");
  const billing = join(fixtureRepo, 'services/billing/storage');
  await mkdir(join(billing, 'changes'), { recursive: true });
  await writeFile(join(billing, 'flyway.toml'), '[flyway]\nlocations = ["filesystem:./changes"]');
  await writeFile(join(billing, 'changes/V1__Create_invoice.sql'), 'CREATE TABLE invoice (id integer);');
  await writeFile(join(billing, 'changes/R__Refresh_totals.sql'), 'CREATE VIEW totals AS SELECT count(*) FROM invoice;');
  await writeFile(join(billing, 'liquibase.properties'), 'changeLogFile=liquibase/master.xml');
  await mkdir(join(billing, 'liquibase'));
  await writeFile(join(billing, 'liquibase/master.xml'), '<databaseChangeLog><include file="invoice.sql" relativeToChangelogFile="true"/></databaseChangeLog>');
  await writeFile(join(billing, 'liquibase/invoice.sql'), '--liquibase formatted sql\n--changeset billing:invoice-init\nCREATE TABLE invoice (id integer);');
  await mkdir(join(fixtureRepo, 'services/reporting/storage/db'), { recursive: true });
  await writeFile(join(fixtureRepo, 'services/reporting/storage/Reports.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
  await writeFile(join(fixtureRepo, 'services/reporting/storage/db/Schema.cs'), `using Microsoft.EntityFrameworkCore.Migrations;
    using Microsoft.EntityFrameworkCore.Infrastructure;
    namespace Reports.Data;
    [DbContext(typeof(ReportsContext))]
    [Migration("20260102123456_CreateReports")]
    public class CreateReports : Migration { }
  `);
  await writeFile(join(fixtureRepo, 'drizzle.config.ts'), `import type { Config } from 'drizzle-kit';
    export default { dialect: 'postgresql', dbCredentials: { url: process.env.STACKFORGE_BROWSER_DRIZZLE_URL! } } satisfies Config;`);
  await mkdir(join(fixtureRepo, 'drizzle/meta'), { recursive: true });
  await writeFile(join(fixtureRepo, 'drizzle/meta/_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql',
    entries: [{ idx: 0, version: '7', when: 1726443359662, tag: '0000_create', breakpoints: true }] }));
  await writeFile(join(fixtureRepo, 'drizzle/0000_create.sql'), 'CREATE TABLE sample (id integer);');
  const gitOptions = { cwd: fixtureRepo, timeout: 15000 };
  await run('git', ['init', '-b', 'main'], gitOptions);
  await run('git', ['add', 'package.json', 'server.mjs', 'drizzle.config.ts', 'drizzle', 'frontend', 'services'], gitOptions);
  await run('git', ['-c', 'user.name=StackForge Test', '-c', 'user.email=stackforge-test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + join(root, 'disabled-hooks'), 'commit', '-m', 'Create isolated browser fixture'], gitOptions);
  const terminals = [];
  const installCommands = [];
  const workspace = cwd => join(cwd, 'pnpm-workspace.yaml');
  const operations = new ProjectOperations({ install: async () => {}, async command(program, args, config) {
    if (!program.startsWith('pnpm install ')) return;
    installCommands.push([program, args, config.cwd]);
    if (!(await readFile(workspace(config.cwd), 'utf8').catch(() => '')).includes('esbuild@0.25.4')) {
      await writeFile(workspace(config.cwd), 'allowBuilds:\n  esbuild: set this to true or false\n');
      config.log('[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @tailwindcss/oxide@4.1.7, esbuild@0.25.4, INVALID URL');
      throw new Error('pnpm exited with code 1');
    }
  } });
  const desktop = { ...createDesktop(), async openProject(folder, action, verify) {
    await verify();
    terminals.push({ folder, action });
  } };
  let alembicChecks = 0, efChecks = 0;
  const localDatabase = { probe: async () => false, async command(program, args, options) {
    const sql = options.input?.toString();
    if (program !== 'psql' || !sql) throw new Error('ENOENT');
    if (sql.includes('"reporting"."ReportHistory"')) {
      efChecks++;
      assert.match(sql, /BEGIN READ ONLY/);
      assert.equal(args[args.indexOf('-d') + 1], 'browser_alembic');
      return JSON.stringify({ name: 'browser_alembic', table: 'readable', rows: ['20260102123456_CreateReports'] });
    }
    if (sql.includes('"public"."flyway_schema_history"')) return JSON.stringify({
      name: 'browser_alembic', table: 'readable', rows: [[1, '1', 'V1__Create_invoice.sql', 'SQL', 0, true]]
    });
    if (sql.includes('"public"."databasechangelog"')) return JSON.stringify({
      name: 'browser_alembic', table: 'readable', rows: [['invoice-init', 'billing', 'liquibase/invoice.sql', 'MARK_RAN']]
    });
    if (!sql.includes('"public"."alembic_version"')) throw new Error('ENOENT');
    alembicChecks++;
    assert.match(sql, /BEGIN READ ONLY/);
    assert.equal(args[args.indexOf('-d') + 1], 'browser_alembic');
    return JSON.stringify({ name: 'browser_alembic', table: 'readable', hasObjects: true, rows: ['start'] });
  } };
  app = createApp({ stateDir: false, clone: cloneFixture, operations, desktop, localDatabase });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = 'http://127.0.0.1:' + app.address().port;
  browser = await chromium.launch({ channel: process.env.STACKFORGE_BROWSER_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const contains = (selector, text) => page.waitForFunction(({ selector, text }) =>
    document.querySelector(selector)?.textContent.includes(text), { selector, text });
  const check = code => '#preflight-results [data-check="' + code + '"]';
  async function runPreflight(code) {
    await page.locator('#preflight-check').click();
    await page.locator(check(code)).first().waitFor();
  }
  await page.goto(origin);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('#language').selectOption('zh-CN');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await page.goto(origin + '/projects');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await page.locator('#project-import-toggle').click();
  await page.locator('#project-import-path').fill(project);
  await page.locator('#project-import-submit').click();
  await contains('#selected-project-name', 'portal');
  await runPreflight('database-missing');
  await contains(check('database-missing'), '缺少数据库配置 DATABASE_URL。');
  await contains(check('startup-missing'), '需要处理');
  await page.locator('#language').selectOption('en');
  await contains(check('database-missing'), 'Missing database setting DATABASE_URL.');
  await page.locator(check('startup-missing')).getByRole('button', { name: 'Review startup configuration' }).click();
  assert.equal(await page.locator('#project-startup').getAttribute('open'), '');
  await page.locator(check('database-missing')).getByRole('button', { name: 'Set up PostgreSQL' }).click();
  await contains('#postgres-setup-status', 'No server responded on this port.');
  const developmentRoute = '**/api/projects/*/database-development';
  await page.route(developmentRoute, async route => {
    if (route.request().method() === 'GET') return route.continue();
    const { mode, name, port, targetId } = route.request().postDataJSON();
    assert.equal(mode, 'preview');
    assert.equal(name, 'app_portal');
    assert.match(targetId, /^[a-f0-9]{64}$/);
    await route.fulfill({ json: { plan: 'preview-only', name, port, targetId, host: '127.0.0.1', image: 'postgres:17' } });
  });
  await page.getByRole('button', { name: 'Open project PostgreSQL' }).click();
  await page.locator('#development-postgres-preview').click();
  await contains('#development-postgres-dialog-title', 'Create project PostgreSQL');
  assert.equal(await page.locator('#development-postgres-apply').isDisabled(), true);
  await page.locator('#development-postgres-confirm').fill('app_portal');
  assert.equal(await page.locator('#development-postgres-apply').isEnabled(), true);
  await page.locator('#development-postgres-cancel').click();
  await page.unroute(developmentRoute);
  await page.locator('#language').selectOption('zh-CN');
  await contains('#project-development-postgres > summary', '项目开发数据库');
  await contains('#development-postgres-preview', '预览数据库实例');
  await page.locator('#language').selectOption('en');
  await assert.rejects(stat(join(project, '.env')), { code: 'ENOENT' });
  await writeFile(join(project, '.env'), 'DATABASE_URL=postgresql://demo:changeme@127.0.0.1:5432/example\n');
  await runPreflight('database-placeholder');
  await contains(check('database-placeholder'), 'contains a placeholder.');
  await page.locator(check('dependencies-unverified')).getByRole('button', { name: 'Review dependency plan' }).click();
  await contains('#dependency-steps', 'npm install');
  assert.equal((await fetch(origin + '/api/projects').then(response => response.json())).projects[0].operation, undefined);
  await page.locator('#language').selectOption('zh-CN');
  await page.locator('#project-database-discovery summary').click();
  await contains('#database-requirements', '声明的依赖');
  await page.locator('#language').selectOption('en');
  await contains('#database-requirements', 'Declared dependency');
  assert.match(await page.locator('#database-requirements').innerText(), /PostgreSQL · package\.json · Declared dependency/);
  await contains('#dependency-steps', 'npm install');
  await page.locator('#detect-startup').click();
  await page.locator('#startup-suggestions button:not([disabled])').first().click();
  assert.equal(await page.locator('#project-startup-services input[name="command"]').inputValue(), 'npm run dev');
  await page.locator('#project-startup-save').click();
  await contains('#project-startup-message', 'Startup configuration saved.');
  await page.locator('#project-checks summary').first().click();
  await page.locator('#check-command option').first().waitFor({ state: 'attached' });
  await page.locator('#check-config-editor summary').click();
  await page.locator('#check-config-add').click();
  await page.locator('#check-config-rows [name="command"]').last().fill('node --version');
  await page.locator('#check-config-save').click();
  await contains('#check-config-message', 'Custom check commands saved.');
  await page.locator('#project-git summary').click();
  await contains('#git-message', 'This project has no local Git repository.');
  async function exerciseRuntime(name, kind, viaPreflight = false) {
    const row = page.locator('#project-startup-services .startup-service').first();
    const port = await availablePort();
    await row.locator('[name="port"]').fill(String(port));
    await row.locator('[name="kind"]').selectOption(kind);
    await row.locator('[name="openPath"]').fill(healthPath);
    await page.locator('#project-startup-save').click();
    await contains('#project-startup-message', 'Startup configuration saved.');
    const action = page.locator('#runtime-action');
    const link = page.locator('#runtime-custom-links').getByRole('link', { name: kind === 'api' ? 'Open API' : 'Open app' });
    assert.equal(await link.isVisible(), false);
    if (viaPreflight) {
      await runPreflight('port-free');
      await contains(check('port-free'), 'Port ' + port + ' is available.');
      await page.locator('#language').selectOption('zh-CN');
      await contains(check('port-free'), '端口 ' + port + ' 可用。');
      await page.getByRole('button', { name: '继续启动项目' }).click();
      await page.locator('#language').selectOption('en');
    } else await action.click();
    await page.locator('#selected-project-state[data-state="ready"]').waitFor();
    await contains('#runtime-output', name + ' is listening');
    const expected = `http://127.0.0.1:${port}${healthPath}`;
    assert.equal(await link.getAttribute('href'), expected);
    const [tab] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await tab.waitForLoadState();
    assert.equal(tab.url(), expected);
    assert.equal(await tab.locator('body').innerText(), name + ' is ready');
    await tab.close();
    await action.click();
    await page.locator('#selected-project-state[data-state="stopped"]').waitFor();
    await link.waitFor({ state: 'hidden' });
    assert.match(await page.locator('#runtime-output').textContent(), /is listening/);
    await assert.rejects(fetch(expected, { signal: AbortSignal.timeout(2000) }), /fetch failed/);
  }
  await exerciseRuntime('Imported portal', 'web');
  const setup = page.locator('#database-requirements');
  await setup.getByRole('button', { name: 'Set up PostgreSQL' }).click();
  await contains('#postgres-setup-status', 'No server responded on this port.');
  assert.equal(await page.locator('#postgres-setup-guide').isVisible(), true);
  assert.equal(await page.locator('#postgres-setup-next').isVisible(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#postgres-setup-dialog').isVisible(), false);
  await page.locator('#language').selectOption('zh-CN');
  await contains('#database-requirements', '声明的依赖');
  await page.setViewportSize({ width: 390, height: 780 });
  await setup.getByRole('button', { name: '设置 PostgreSQL' }).click();
  await contains('#postgres-setup-status', '此端口没有服务器响应');
  const box = await page.locator('#postgres-setup-dialog').boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 391);
  await page.keyboard.press('Escape');
  await page.locator('#language').selectOption('en');
  await writeFile(join(project, '.env.local'), 'DATABASE_URL=postgresql://other@127.0.0.1:5432/other\n');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/database-discovery') && response.ok()),
    page.locator('#database-discovery-refresh').click()
  ]);
  await setup.getByRole('button', { name: 'Set up PostgreSQL' }).click();
  await contains('#postgres-setup-status', 'Check the environment configuration.');
  await contains('#postgres-setup-status', '.env.local');
  assert.equal(await page.locator('#postgres-setup-next').isVisible(), false);
  await page.keyboard.press('Escape');
  await page.locator('#project-delete').click();
  await contains('#project-trash-title', 'Remove project from Projects?');
  await page.locator('#project-trash-name').fill('Portal');
  assert.equal(await page.locator('#project-trash-confirm').isDisabled(), true);
  await page.locator('#project-trash-name').fill('portal');
  await page.locator('#project-trash-confirm').click();
  await contains('#project-feedback', 'Project removed from Projects.');
  const { projects } = await (await fetch(origin + '/api/projects')).json();
  assert.deepEqual(projects, []);
  assert.equal(JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).name, 'portal');
  await page.setViewportSize({ width: 1280, height: 820 });
  await mkdir(join(monorepo, 'frontend'), { recursive: true });
  await mkdir(join(monorepo, 'backend'));
  const { token } = await fetch(origin + '/api/state').then(response => response.json());
  const post = (path, body) => fetch(origin + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify(body) });
  const importedMono = await post('/api/projects/import', { path: monorepo });
  assert.equal(importedMono.status, 201);
  const { id: monoId } = await importedMono.json();
  const occupied = createServer().listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  try {
    const port = occupied.address().port;
    assert.equal((await post('/api/projects/' + monoId + '/startup', { services: [
      { name: 'Frontend service', directory: 'frontend', command: 'node app.mjs', port },
      { name: 'Backend service', directory: 'backend', command: 'node app.mjs' }
    ] })).status, 200);
    await rename(join(monorepo, 'backend'), join(monorepo, 'moved-backend'));
    await contains('#selected-project-name', 'monorepo');
    await runPreflight('working-directory-invalid');
    await contains(check('working-directory-invalid'), 'Backend service · backend');
    await contains(check('port-in-use'), 'Frontend service · frontend');
    await contains(check('port-in-use'), 'Port ' + port + ' is unavailable.');
    await page.locator('#language').selectOption('zh-CN');
    await contains(check('working-directory-invalid'), '已保存的工作目录不存在，或位于项目之外。');
    await contains(check('port-in-use'), '端口 ' + port + ' 不可用。');
    assert.equal(await page.locator('#preflight-start').isVisible(), false);
    await page.locator('#language').selectOption('en');
  } finally { await new Promise(resolve => occupied.close(resolve)); }
  await page.locator('#project-import-toggle').click();
  await page.locator('#project-clone-url').fill(repository);
  await page.locator('#project-clone-parent').fill(checkoutParent);
  const [clonedResponse] = await Promise.all([
    page.waitForResponse(response => response.url() === origin + '/api/projects/clone' && response.request().method() === 'POST'),
    page.locator('#project-clone-submit').click()
  ]);
  assert.equal(clonedResponse.status(), 201, await clonedResponse.text());
  await contains('#selected-project-name', 'cloned-portal');
  const { projects: [cloned] } = await (await fetch(origin + '/api/projects')).json();
  assert.equal(cloned.cloned, true);
  assert.equal(cloned.path, join(checkoutParent, 'cloned-portal'));
  await page.getByRole('button', { name: 'Install detected dependencies' }).click();
  await page.locator('#dependency-approval').waitFor();
  await contains('#dependency-approval', 'pnpm build scripts need review');
  assert.deepEqual(await page.locator('#dependency-approval-packages li').allTextContents(), ['@tailwindcss/oxide@4.1.7', 'esbuild@0.25.4']);
  await contains('#dependency-approval-directory', 'Install folder frontend');
  await page.locator('#language').selectOption('zh-CN');
  await contains('#dependency-approval', 'pnpm 构建脚本需要审核');
  await page.getByRole('button', { name: '打开安装目录的终端' }).click();
  await contains('#project-feedback', '项目终端已打开。');
  const frontend = join(cloned.path, 'frontend');
  assert.deepEqual(terminals, [{ folder: frontend, action: 'terminal' }]);
  // Simulate reviewing the requested packages in the terminal. This fixture
  // uses a stub installer so CI does not run third-party build scripts.
  await writeFile(workspace(frontend), "allowBuilds:\n  'esbuild@0.25.4': true\n");
  await page.getByRole('button', { name: '重试安装依赖' }).click();
  await contains('#dependency-status', '依赖已安装。');
  assert.equal(await page.locator('#dependency-approval').isVisible(), false);
  assert.deepEqual(installCommands, Array(2).fill(['pnpm install --frozen-lockfile', [], frontend]));
  await page.locator('#language').selectOption('en');
  await writeFile(join(cloned.path, '.env'), 'ALEMBIC_DATABASE_URL=postgresql://browseruser:browser_test_only@127.0.0.1:5432/browser_alembic\n');
  const ownedTarget = { id: 'f'.repeat(64), host: '127.0.0.1', port: 55432, name: 'project_fixture', engine: 'postgres', projectPostgres: true };
  const ownedMysql = { id: 'b'.repeat(64), host: '127.0.0.1', port: 53306, name: 'mysql_fixture', engine: 'mysql', projectMysql: true };
  const ownedSql = { id: 'd'.repeat(64), host: '127.0.0.1', port: 51433, name: 'sqlserver_fixture', engine: 'sqlserver', projectSqlServer: true };
  await page.route('**/api/projects/' + cloned.id + '/database-discovery', async route => {
    const response = await route.fetch();
    const data = await response.json();
    for (const key of ['sqlMigrationTargets', 'alembicTargets', 'efCoreTargets']) data[key].unshift(ownedTarget);
    data.sqlMigrationTargets.unshift(ownedMysql);
    data.efCoreTargets.unshift(ownedSql);
    return route.fulfill({ response, json: data });
  });
  await page.route('**/api/projects/' + cloned.id + '/database-liquibase-preview', async route => {
    const { targetId, sourceId } = route.request().postDataJSON();
    if (targetId !== ownedMysql.id) return route.continue();
    const response = await route.fetch({ postData: { sourceId } });
    const data = await response.json();
    return route.fulfill({ response, json: { ...data, database: { target: ownedMysql, status: 'recorded', tags: ['release-one'] } } });
  });
  let nativeExecutions = 0;
  const reviewedPlan = { status: 'planned', target: ownedTarget, tool: 'Flyway', version: '11.20.3',
    directory: 'services/billing/storage', history: { schema: 'public', table: 'flyway_schema_history' },
    migrations: [{ revision: '1', file: 'services/billing/storage/changes/V1__Create_invoice.sql' }], planId: 'fixture-plan' };
  await page.route('**/api/projects/' + cloned.id + '/database-native-migration', route => {
    const payload = route.request().postDataJSON();
    assert.equal(payload.targetId, payload.adapter === 'liquibase' ? ownedMysql.id : payload.adapter === 'ef-core' ? ownedSql.id : ownedTarget.id);
    if (payload.adapter === 'alembic') {
      assert.equal(payload.operation, 'apply');
      assert.equal(payload.revision, 'start');
      assert.equal(payload.dependencyLock, 'requirements-alembic.lock');
      return route.fulfill({ json: { ...reviewedPlan, tool: 'Alembic', version: '1.20.1', fromRevision: 'base', toRevision: 'start',
        expectedHeads: ['start'], dependencyLock: payload.dependencyLock, packages: [{ name: 'sqlalchemy-utils', version: '0.42.1' }],
        nontransactional: true } });
    }
    if (payload.adapter === 'ef-core') {
      assert.equal(payload.operation, 'rollback');
      assert.equal(payload.schema, 'dbo');
      assert.equal(payload.revision, 'base');
      assert.equal(payload.scriptFile, 'artifacts/rollback.sql');
      assert.match(payload.groupId, /^[a-f0-9]{64}$/);
      return route.fulfill({ json: { ...reviewedPlan, target: ownedSql, tool: 'EF Core', version: '', fromRevision: '20260102123456_CreateReports',
        toRevision: 'base', scriptFile: payload.scriptFile, sql: 'DROP TABLE reports;' } });
    }
    if (payload.adapter === 'liquibase') {
      assert.equal(payload.operation, 'rollback');
      assert.equal(payload.table, 'DATABASECHANGELOG');
      assert.deepEqual([payload.contextFilter, payload.labelFilter, payload.liquibaseProperties], ['stage', 'feature', ['table=invoice']]);
      if (payload.rollbackTag) {
        assert.equal(payload.rollbackTag, 'release-one');
        assert.equal(payload.rollbackCount, undefined);
      } else assert.equal(payload.rollbackCount, 2);
      return route.fulfill({ json: { ...reviewedPlan, target: ownedMysql, tool: 'Liquibase', version: '4.33.0',
        rollbackTag: payload.rollbackTag, undo: ['DROP TABLE invoice;'] } });
    }
    assert.equal(payload.adapter, 'flyway');
    assert.equal(payload.operation, 'apply');
    if (payload.mode === 'execute') {
      assert.equal(payload.confirmName, ownedTarget.name);
      assert.equal(payload.planId, reviewedPlan.planId);
      nativeExecutions++;
    }
    return route.fulfill({ json: { ...reviewedPlan, ...(payload.mode === 'execute' && { status: 'applied' }) } });
  });
  const databaseDiscovery = page.locator('#project-database-discovery');
  if (await databaseDiscovery.getAttribute('open') === null) await databaseDiscovery.locator(':scope > summary').click();
  await page.locator('#database-discovery-refresh').click();
  const alembic = page.locator('.alembic-preview');
  const targetLabel = '127.0.0.1:5432/browser_alembic · .env · ALEMBIC_DATABASE_URL';
  await alembic.locator('option').filter({ hasText: targetLabel }).waitFor({ state: 'attached' });
  const ef = page.locator('.ef-core-preview');
  await ef.locator(':scope > summary').press('Enter');
  await contains('.ef-core-preview [role="status"]', 'Database status is unverified.');
  await contains('.ef-core-preview summary', 'services/reporting/storage/Reports.csproj');
  await contains('.ef-core-preview li', '20260102123456_CreateReports · db/Schema.cs');
  await page.locator('#language').selectOption('zh-CN');
  await contains('.ef-core-preview summary', '预览 EF Core 迁移');
  await contains('.ef-core-preview [role="status"]', '数据库状态未验证。');
  await page.locator('#language').selectOption('en');
  const efTarget = ef.locator('select[name="targetId"]');
  await efTarget.selectOption({ label: 'PostgreSQL · ' + targetLabel });
  await ef.getByText('History table', { exact: true }).click();
  await ef.getByLabel('History schema').fill('reporting');
  await ef.getByLabel('History table name').fill('ReportHistory');
  await ef.getByRole('button', { name: 'Check database history' }).click();
  await contains('.ef-core-preview', 'The selected history table records every local migration for this DbContext.');
  await contains('.ef-core-preview li', 'CreateReports · db/Schema.cs · Applied');
  assert.equal(efChecks, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#language').selectOption('zh-CN');
  await contains('.ef-core-preview', '所选历史表包含此 DbContext 的全部本地迁移记录。');
  await contains('.ef-core-preview li', 'CreateReports · db/Schema.cs · 已应用');
  assert.equal(await ef.evaluate(panel => panel.scrollWidth <= panel.clientWidth), true);
  const flyway = page.locator('.flyway-preview');
  await flyway.locator('summary').press('Enter');
  await contains('.flyway-preview summary', '预览 Flyway 迁移');
  await contains('.flyway-preview [role="status"]:first-of-type', '数据库历史尚未核对。');
  await contains('.flyway-preview', '可重复迁移 · changes/R__Refresh_totals.sql');
  assert.equal(await flyway.evaluate(panel => panel.scrollWidth <= panel.clientWidth), true);
  const liquibase = page.locator('.liquibase-preview');
  await liquibase.locator('summary').press('Enter');
  await contains('.liquibase-preview summary', '预览 Liquibase 变更集');
  await contains('.liquibase-preview [role="status"]:first-of-type', '数据库应用记录未核对。');
  await contains('.liquibase-preview li', 'invoice-init · billing · liquibase/invoice.sql');
  assert.equal(await liquibase.evaluate(panel => panel.scrollWidth <= panel.clientWidth), true);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.locator('#language').selectOption('en');
  await contains('.flyway-preview', 'Versioned migration · changes/V1__Create_invoice.sql');
  await flyway.getByRole('button', { name: 'Rescan Flyway files' }).click();
  await contains('.flyway-preview [role="status"]', 'Database history is unverified.');
  await contains('.liquibase-preview summary', 'Preview Liquibase changesets');
  await liquibase.getByRole('button', { name: 'Rescan Liquibase files' }).click();
  await contains('.liquibase-preview [role="status"]', 'Database history is unverified.');
  for (const panel of [flyway, liquibase]) {
    await panel.locator(':scope > form select').selectOption({ label: targetLabel });
    await panel.getByRole('button', { name: 'Check database history' }).click();
  }
  await contains('.flyway-preview', 'Checksum changed');
  await contains('.liquibase-preview', 'Marked as run');
  await page.locator('#language').selectOption('zh-CN');
  await contains('.flyway-preview', '校验和已变化');
  await contains('.liquibase-preview', '标记为已运行');
  await liquibase.locator(':scope > form select').selectOption(ownedMysql.id);
  await liquibase.locator(':scope > form button').click();
  await liquibase.locator('.native-migration datalist option[value="release-one"]').waitFor({ state: 'attached' });
  const liquibaseNative = liquibase.locator('.native-migration');
  await liquibaseNative.getByLabel('上下文过滤（可选）').fill('stage');
  await liquibaseNative.getByLabel('标签过滤（可选）').fill('feature');
  await liquibaseNative.getByLabel('以 name=value 输入字面属性，用逗号分隔').fill('table=invoice');
  await liquibaseNative.getByLabel('要回滚的变更集数量').fill('2');
  await liquibaseNative.getByRole('button', { name: '预览回滚计划' }).click();
  await contains('.liquibase-preview .native-migration pre', 'DROP TABLE invoice;');
  await contains('.liquibase-preview .native-migration form', '执行计划前请备份 MySQL。');
  assert.equal(await liquibaseNative.getByRole('button', { name: '执行已审核的回滚' }).isDisabled(), true);
  await liquibaseNative.getByLabel('回滚标签（可选）').fill('release-one');
  assert.equal(await liquibaseNative.getByLabel('要回滚的变更集数量').isDisabled(), true);
  await liquibaseNative.getByRole('button', { name: '预览回滚计划' }).click();
  await contains('.liquibase-preview .native-migration form', 'release-one');
  await flyway.locator(':scope > form select').selectOption(ownedTarget.id);
  const native = flyway.locator('.native-migration');
  await native.getByRole('button', { name: '预览迁移计划' }).click();
  await contains('.flyway-preview .native-migration form', 'Flyway 11.20.3');
  await contains('.flyway-preview .native-migration form', 'services/billing/storage/changes/V1__Create_invoice.sql');
  assert.equal(await native.getByRole('button', { name: '应用已审核的迁移' }).isDisabled(), true);
  await page.locator('#language').selectOption('en');
  await contains('.liquibase-preview .native-migration form', 'A failed or cancelled migration can leave schema changes committed.');
  const confirm = native.locator('input');
  await confirm.fill('Project_fixture');
  assert.equal(await native.getByRole('button', { name: 'Apply reviewed migrations' }).isDisabled(), true);
  await confirm.fill(ownedTarget.name);
  await native.getByRole('button', { name: 'Apply reviewed migrations' }).click();
  await contains('.flyway-preview .native-migration [role="status"]', 'Migration finished and the database history was verified.');
  assert.equal(nativeExecutions, 1);
  await page.locator('#language').selectOption('en');
  await alembic.locator(':scope > summary').press('Enter');
  await contains('.alembic-preview [role="status"]', 'Database status is unverified.');
  await contains('.alembic-preview', 'Declared heads · start');
  await contains('.alembic-preview', 'services/api/alembic/versions');
  await contains('.alembic-preview li', 'start · first.py');
  await page.locator('#language').selectOption('zh-CN');
  await contains('.alembic-preview summary', '预览 Alembic 迁移');
  await contains('.alembic-preview', '代码中声明的分支末端 · start');
  await contains('.alembic-preview [role="status"]', '数据库状态未验证。');
  assert.equal(alembicChecks, 0);
  const checkHistory = alembic.getByRole('button', { name: '检查数据库迁移历史' });
  assert.equal(await checkHistory.isDisabled(), true);
  const target = alembic.getByLabel('public.alembic_version 所在数据库');
  await target.selectOption({ label: targetLabel });
  await checkHistory.click();
  await contains('.alembic-preview', '数据库的迁移记录覆盖所有本地版本。');
  await contains('.alembic-preview li', 'start · first.py · 已应用');
  assert.equal(alembicChecks, 1);
  await page.locator('#language').selectOption('en');
  await contains('.alembic-preview', 'The recorded revision history covers every local revision.');
  await alembic.getByLabel('Database for public.alembic_version').selectOption('');
  assert.equal(await alembic.getByRole('button', { name: 'Check database history' }).isDisabled(), true);
  assert.equal(await alembic.locator('.alembic-revision-state').count(), 0);
  await alembic.getByLabel('Database for public.alembic_version').selectOption(ownedTarget.id);
  await alembic.getByLabel('Target revision').selectOption('start');
  await alembic.getByLabel('Dependency lock file inside the project (optional)').fill('requirements-alembic.lock');
  await alembic.getByRole('button', { name: 'Preview migration plan' }).click();
  await contains('.alembic-preview .native-migration form', 'base → start');
  await contains('.alembic-preview .native-migration form', 'Recorded revisions after migration · start');
  await contains('.alembic-preview .native-migration form', 'Locked Python package · sqlalchemy-utils==0.42.1');
  await alembic.getByLabel('Type the target database name to confirm.').fill(ownedTarget.name);
  assert.equal(await alembic.getByRole('button', { name: 'Apply reviewed migrations' }).isDisabled(), true);
  await alembic.getByLabel('I have a verified backup and accept that some changes may commit before a failure.').check();
  assert.equal(await alembic.getByRole('button', { name: 'Apply reviewed migrations' }).isEnabled(), true);
  await ef.getByLabel('History schema').fill('public');
  await efTarget.selectOption(ownedTarget.id);
  await efTarget.selectOption(ownedSql.id);
  await page.locator('#language').selectOption('zh-CN');
  await contains('.alembic-preview .native-migration form', '迁移后记录的版本 · start');
  await contains('.alembic-preview .native-migration form', '锁定的 Python 包 · sqlalchemy-utils==0.42.1');
  assert.equal(await alembic.getByLabel('我有经过验证的备份，并接受失败前可能已有部分变更提交。').isChecked(), true);
  await alembic.getByLabel('项目内的依赖锁文件（可选）').fill('different.lock');
  assert.equal(await alembic.locator('.native-migration form').isVisible(), false);
  const efNative = ef.locator('.native-migration');
  await efNative.getByLabel('目标版本').selectOption('base');
  await efNative.getByLabel('EF Core SQL 文件的项目相对路径').fill('artifacts/rollback.sql');
  await efNative.getByRole('button', { name: '预览回滚计划' }).click();
  await contains('.ef-core-preview .native-migration pre', 'DROP TABLE reports;');
  assert.equal(await efNative.getByRole('button', { name: '执行已审核的回滚' }).isDisabled(), true);
  await page.locator('#language').selectOption('en');
  await contains('.ef-core-preview .native-migration form', 'Review the exported SQL');
  await page.getByText('Preview Drizzle migrations', { exact: true }).click();
  await contains('.drizzle-preview [role="status"]', 'Save a supported direct PostgreSQL URL');
  await contains('.drizzle-preview li', 'Unverified · drizzle/0000_create.sql');
  await page.locator('#language').selectOption('zh-CN');
  await contains('.drizzle-preview li', '未验证 · drizzle/0000_create.sql');
  const drizzlePanel = page.locator('.drizzle-preview');
  const drizzleState = { variable: 'POSTGRES_URL', target: ownedTarget, history: 'drizzle.__drizzle_migrations',
    rollbackTargets: [null], migrations: [{ state: 'applied', file: 'drizzle/0000_create.sql' }] };
  let drizzleMysqlStatus, drizzleSqlite;
  await page.route('**/api/projects/' + cloned.id + '/database-drizzle-preview', route => {
    const selection = route.request().postDataJSON();
    if (drizzleSqlite) {
      const selected = selection.databaseFile;
      return route.fulfill({ json: { engine: 'sqlite', chooseFile: true,
        status: selected ? 'pending' : 'configuration-needed',
        ...(selected && { target: { path: selected, name: 'app.sqlite' }, planId: 'sqlite-plan', reviewSql: 'CREATE TABLE notes (id INTEGER);' }) } });
    }
    if (drizzleMysqlStatus) return route.fulfill({ json: {
      engine: 'mysql', status: drizzleMysqlStatus, variable: 'DRIZZLE_DATABASE_URL',
      target: { ...ownedTarget, port: 3306 }, history: ownedTarget.name + '.__drizzle_migrations',
      migrations: [{ state: 'pending', file: 'drizzle/20260101000000_create/migration.sql' }],
      ...(drizzleMysqlStatus === 'pending' && { planId: 'drizzle-mysql', reviewSql: 'CREATE TABLE messages (id INT);' })
    } });
    if (!selection.operation) return route.fulfill({ json: { ...drizzleState, status: 'current' } });
    assert.deepEqual([selection.operation, selection.revision, selection.scriptFile], ['rollback', null, 'drizzle/revert.sql']);
    return route.fulfill({ json: { ...drizzleState, status: 'rollback-planned', planId: 'drizzle-rollback',
      fromRevision: '0000_create', toRevision: 'base', reviewSql: 'DROP TABLE example;' } });
  });
  await page.route('**/api/projects/' + cloned.id + '/database-drizzle-apply', route => {
    const selection = route.request().postDataJSON();
    assert.deepEqual([selection.operation, selection.planId, selection.confirmName], ['rollback', 'drizzle-rollback', ownedTarget.name]);
    return route.fulfill({ json: { ...drizzleState, status: 'rolled-back', rollbackTargets: [],
      migrations: [{ state: 'pending', file: 'drizzle/0000_create.sql' }] } });
  });
  await drizzlePanel.getByRole('button', { name: '重新检测' }).click();
  await drizzlePanel.getByLabel('项目内的回滚 SQL 文件相对路径').fill('drizzle/revert.sql');
  await drizzlePanel.getByRole('button', { name: '预览回滚计划' }).click();
  await contains('.drizzle-preview .drizzle-sql-review', 'DROP TABLE example;');
  await contains('.drizzle-preview form', '0000_create → base');
  assert.equal(await drizzlePanel.getByRole('button', { name: '执行已审核的回滚' }).isDisabled(), true);
  await drizzlePanel.getByLabel('输入目标数据库名称以确认。').fill(ownedTarget.name);
  await drizzlePanel.getByRole('button', { name: '执行已审核的回滚' }).click();
  await contains('.drizzle-preview [role="status"]', '回滚已完成，数据库历史已验证。');
  drizzleMysqlStatus = 'pending';
  await drizzlePanel.getByRole('button', { name: '重新检测' }).click();
  await contains('.drizzle-preview form', 'MySQL 也可能已提交结构变更');
  assert.equal(await drizzlePanel.getByRole('button', { name: '应用 Drizzle 迁移' }).isDisabled(), true);
  await drizzlePanel.getByLabel('输入目标数据库名称以确认。').fill(ownedTarget.name);
  assert.equal(await drizzlePanel.getByRole('button', { name: '应用 Drizzle 迁移' }).isEnabled(), true);
  drizzleMysqlStatus = 'recovery-required';
  await drizzlePanel.getByRole('button', { name: '重新检测' }).click();
  await contains('.drizzle-preview [role="status"]', 'MySQL 可能已提交部分变更');
  assert.equal(await drizzlePanel.locator('form').isVisible(), false);
  await page.locator('#language').selectOption('en');
  await contains('.drizzle-preview [role="status"]', 'MySQL may have committed some changes');
  drizzleSqlite = true;
  await drizzlePanel.getByRole('button', { name: 'Check again' }).click();
  await contains('.drizzle-preview [role="status"]', 'Choose a SQLite database file inside the project');
  await drizzlePanel.getByLabel('SQLite file path inside the project').fill('data/app.sqlite');
  await drizzlePanel.getByRole('button', { name: 'Check again' }).click();
  await contains('.drizzle-preview form', 'Back up the SQLite file before applying');
  assert.equal(await drizzlePanel.getByRole('button', { name: 'Apply Drizzle migrations' }).isDisabled(), true);
  await drizzlePanel.getByLabel('Type the target database name to confirm.').fill('app.sqlite');
  assert.equal(await drizzlePanel.getByRole('button', { name: 'Apply Drizzle migrations' }).isEnabled(), true);
  await page.locator('#language').selectOption('zh-CN');
  await contains('.drizzle-preview form', '应用前请备份 SQLite 文件');
  await drizzlePanel.getByLabel('项目内的 SQLite 文件路径').fill('other.sqlite');
  assert.equal(await drizzlePanel.locator('form').isVisible(), false);
  await page.locator('#language').selectOption('en');
  const startup = page.locator('#project-startup');
  if (await startup.getAttribute('open') === null) await startup.locator('summary').click();
  await page.locator('#project-startup-add').click();
  const service = page.locator('#project-startup-services .startup-service').first();
  await service.locator('[name="name"]').fill('Cloned API');
  await service.locator('[name="directory"]').fill('.');
  await service.locator('[name="command"]').fill('node server.mjs');
  await exerciseRuntime('Cloned portal', 'api', true);
  const mysqlProject = join(root, 'mysql-fastapi');
  await mkdir(join(mysqlProject, 'app'), { recursive: true });
  await mkdir(join(mysqlProject, 'backend/src'), { recursive: true });
  await writeFile(join(mysqlProject, 'app/main.py'), 'from fastapi import Depends, FastAPI\napp = FastAPI()\n');
  await writeFile(join(mysqlProject, 'app/database.py'), 'from sqlalchemy import create_engine\nengine = create_engine(f"mysql+pymysql://{user}@localhost/service")\n');
  await writeFile(join(mysqlProject, 'backend/src/main.py'), 'import fastapi\nfrom src.config import settings\n' +
    'def make_app() -> fastapi.FastAPI:\n    return fastapi.FastAPI(**settings)\n\nbackend_app: fastapi.FastAPI = make_app()\n');
  await page.locator('#project-import-toggle').click();
  await page.locator('#project-import-path').fill(mysqlProject);
  await page.locator('#project-import-submit').click();
  await contains('#selected-project-name', 'mysql-fastapi');
  const { projects: knownProjects } = await (await fetch(origin + '/api/projects')).json();
  const mysql = knownProjects.find(item => item.path === mysqlProject);
  const { groups } = await (await fetch(origin + '/api/projects/' + mysql.id + '/startup-suggestions')).json();
  assert.deepEqual(groups.map(item => [item.directory, item.choices[0].command.split(' -m uvicorn ')[1]]),
    [['.', 'app.main:app --reload'], ['backend', 'src.main:backend_app --reload']]);
  await page.route(developmentRoute, async route => {
    if (route.request().method() === 'GET') return route.continue();
    const { name, port, targetId } = route.request().postDataJSON();
    assert.match(targetId, /^[a-f0-9]{64}$/);
    assert.equal(port, 53306);
    await route.fulfill({ json: { plan: 'mysql-preview', name, port, targetId, host: '127.0.0.1', image: 'mysql:8.4', engine: 'mysql' } });
  });
  const development = page.locator('#project-development-postgres');
  if (await development.getAttribute('open') === null) await development.locator('summary').click();
  await contains('#development-postgres-evidence', 'app/database.py');
  await page.locator('#development-postgres-preview').click();
  await contains('#development-postgres-dialog-title', 'Create project MySQL');
  await page.locator('#language').selectOption('zh-CN');
  await contains('#development-postgres-dialog-title', '创建项目专属 MySQL');
  await page.locator('#development-postgres-cancel').click();
  await page.unroute(developmentRoute);
  const sqlOption = { id: 'a'.repeat(64), directory: '.', engine: 'sqlserver', status: 'detected', canCreate: true,
    requirementIds: [], actions: [], evidence: ['appsettings.json'] };
  await page.route(developmentRoute, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { status: 'absent', sqlServerPort: 51433, options: [sqlOption] } });
    const { name, port, targetId, mode } = route.request().postDataJSON();
    assert.equal(mode, 'preview');
    assert.equal(targetId, sqlOption.id);
    assert.equal(port, 51433);
    return route.fulfill({ json: { plan: 'sql-preview', name, port, targetId, host: '127.0.0.1', directory: '.',
      engine: 'sqlserver', terms: 'https://www.microsoft.com/', image: 'mcr.microsoft.com/mssql/server:2022-latest' } });
  });
  await page.locator('#development-postgres-refresh').click();
  await contains('#development-postgres-evidence', 'appsettings.json');
  await page.locator('#development-postgres-preview').click();
  await contains('#development-postgres-dialog-title', '创建项目专属 SQL Server');
  await page.locator('#development-postgres-confirm').fill(await page.locator('#development-postgres-confirm-target').textContent());
  assert.equal(await page.locator('#development-postgres-apply').isDisabled(), true);
  await page.locator('#development-postgres-accept-terms').check();
  assert.equal(await page.locator('#development-postgres-apply').isEnabled(), true);
  await page.locator('#development-postgres-cancel').click();
  await page.unroute(developmentRoute);
  assert.deepEqual(errors, []);
  console.log('Verified bilingual startup, database setup, and Drizzle, Alembic, EF Core, Flyway and Liquibase migration previews in imported and cloned projects.');
} finally {
  try {
    await browser?.close();
    if (app) {
      await app.shutdownTasks();
      await new Promise(resolve => app.close(resolve));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
