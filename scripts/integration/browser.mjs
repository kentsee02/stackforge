import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/http/server.mjs';

const root = await realpath(await mkdtemp(join(tmpdir(), 'stackforge-browser-')));
const project = join(root, 'portal');
let app, browser;
try {
  await mkdir(join(project, 'prisma'), { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ dependencies: { pg: '8.0.0' } }));
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
  assert.deepEqual(errors, []);
  console.log('Verified English defaults, persistent locale, live database row translation, and the PostgreSQL dialog on desktop and mobile.');
} finally {
  try {
    await browser?.close();
    if (app) {
      await app.shutdownTasks();
      await new Promise(resolve => app.close(resolve));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
