import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/http/server.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-browser-')));
const project = join(root, 'portal');
let app, browser;
try {
  await mkdir(join(project, 'prisma'), { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({
    name: 'portal', packageManager: 'npm@11.0.0',
    scripts: { dev: 'node server.mjs', test: 'node --test' }, dependencies: { pg: '8.0.0', express: '5.0.0' }
  }));
  await writeFile(join(project, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }');
  await writeFile(join(project, 'prisma.config.ts'), 'import "dotenv/config";\nexport default { datasource: { url: env("DATABASE_URL") } };');
  app = createApp({ stateDir: false, localDatabase: { probe: async () => false, command: async () => { throw new Error('ENOENT'); } } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = 'http://127.0.0.1:' + app.address().port;
  const { token } = await (await fetch(origin + '/api/state')).json();
  const imported = await fetch(origin + '/api/projects/import', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': token }, body: JSON.stringify({ path: project }) });
  assert.equal(imported.status, 201);

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
  assert.deepEqual(errors, []);
  console.log('Verified locale switching, dependency plans, startup and check configuration, Git status, PostgreSQL setup, and exact-name project removal.');
} finally {
  try {
    await browser?.close();
    if (app) {
      await app.shutdownTasks();
      await new Promise(resolve => app.close(resolve));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
