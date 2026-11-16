import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/http/server.mjs';
import { run } from '../../src/platform/process.mjs';
import { cloneGithub } from '../../src/projects/project-clone.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-browser-')));
const project = join(root, 'portal');
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
  await writeFile(join(project, '.env'), 'DATABASE_URL=postgresql://demo:changeme@127.0.0.1:5432/example\n');
  await writeFile(join(project, 'server.mjs'), fixtureServer('Imported portal'));
  await mkdir(fixtureRepo);
  await writeFile(join(fixtureRepo, 'server.mjs'), fixtureServer('Cloned portal'));
  await writeFile(join(fixtureRepo, 'package.json'), JSON.stringify({ name: 'cloned-portal', dependencies: { express: '5.0.0' } }));
  const gitOptions = { cwd: fixtureRepo, timeout: 15000 };
  await run('git', ['init', '-b', 'main'], gitOptions);
  await run('git', ['add', 'package.json', 'server.mjs'], gitOptions);
  await run('git', ['-c', 'user.name=StackForge Test', '-c', 'user.email=stackforge-test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + join(root, 'disabled-hooks'), 'commit', '-m', 'Create isolated browser fixture'], gitOptions);
  app = createApp({ stateDir: false, clone: cloneFixture, localDatabase: { probe: async () => false, command: async () => { throw new Error('ENOENT'); } } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = 'http://127.0.0.1:' + app.address().port;
  browser = await chromium.launch({ channel: process.env.STACKFORGE_BROWSER_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const contains = (selector, text) => page.waitForFunction(({ selector, text }) =>
    document.querySelector(selector)?.textContent.includes(text), { selector, text });
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
  async function exerciseRuntime(name, kind) {
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
    await action.click();
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
  await page.getByRole('button', { name: 'Set up PostgreSQL' }).click();
  await contains('#postgres-setup-status', 'No server responded on this port.');
  assert.equal(await page.locator('#postgres-setup-guide').isVisible(), true);
  assert.equal(await page.locator('#postgres-setup-next').isVisible(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#postgres-setup-dialog').isVisible(), false);
  await page.locator('#language').selectOption('zh-CN');
  await contains('#database-requirements', '声明的依赖');
  await page.setViewportSize({ width: 390, height: 780 });
  await page.getByRole('button', { name: '设置 PostgreSQL' }).click();
  await contains('#postgres-setup-status', '此端口没有服务器响应');
  const box = await page.locator('#postgres-setup-dialog').boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 391);
  await page.keyboard.press('Escape');
  await page.locator('#language').selectOption('en');
  await writeFile(join(project, '.env.local'), 'DATABASE_URL=postgresql://other@127.0.0.1:5432/other\n');
  await page.locator('#database-discovery-refresh').click();
  await page.getByRole('button', { name: 'Set up PostgreSQL' }).click();
  await contains('#postgres-setup-status', 'Review .env, .env.local and rescan database configuration.');
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
  const startup = page.locator('#project-startup');
  if (await startup.getAttribute('open') === null) await startup.locator('summary').click();
  await page.locator('#project-startup-add').click();
  const service = page.locator('#project-startup-services .startup-service').first();
  await service.locator('[name="name"]').fill('Cloned API');
  await service.locator('[name="directory"]').fill('.');
  await service.locator('[name="command"]').fill('node server.mjs');
  await exerciseRuntime('Cloned portal', 'api');
  assert.deepEqual(errors, []);
  console.log('Verified browser import and clone, saved startup, ready links, retained logs and stop, localization, project tools, and PostgreSQL setup.');
} finally {
  try {
    await browser?.close();
    if (app) {
      await app.shutdownTasks();
      await new Promise(resolve => app.close(resolve));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
