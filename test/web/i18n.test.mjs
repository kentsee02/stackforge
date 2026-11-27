import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { translate, normalizeLocale } from '../../public/shared/i18n.js';
import { messages } from '../../public/shared/messages.js';
import { catalog } from '../../src/generation/catalog.mjs';
import { generatedReadme, frontendFiles, expressFiles, nestFiles, devScript } from '../../src/generation/templates.mjs';
import { createApp, identity } from '../../src/http/server.mjs';

test('English is the default; unsupported or missing language preferences fall back to English', () => {
  for (const value of [undefined, null, '', 'en', 'fr', 'zh-TW', '<script>']) assert.equal(normalizeLocale(value), 'en');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(translate('检查并创建项目'), 'Check and create project');
  assert.equal(translate('检查并创建项目', 'zh-CN'), '检查并创建项目');
});

test('workspace entry points show the server version and load their allowlisted assets', async t => {
  const server = createApp({ stateDir: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/', '/dashboard', '/environment', '/integrations', '/projects', '/tasks']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(`<span>v${identity.version}</span>`));
    for (const [, asset] of html.matchAll(/(?:src|href)="(\/[^"#]+\.(?:css|js))"/g)) {
      const result = await fetch(base + asset);
      assert.equal(result.status, 200, asset);
      assert.match(result.headers.get('content-type'), /text\/(?:javascript|css)/);
      await result.arrayBuffer();
    }
  }
  for (const route of ['/projects/database.js', '/projects/startup.js', '/projects/dependencies.js', '/projects/tools.js', '/projects/preflight.js', '/projects/development-postgres.js', '/projects/drizzle-preview.js',
    '/i18n.js', '/messages.js', '/template-store.js', '/plex-regular.ttf']) {
    const asset = await fetch(base + route);
    assert.equal(asset.status, 200, route);
    await asset.arrayBuffer();
  }
  const privateFile = await fetch(base + '/.stackforge/projects.json');
  assert.equal(privateFile.status, 404);
  await privateFile.arrayBuffer();
});

test('message catalog covers static copy and stack choices with matching runtime slots', async () => {
  const known = new Map(messages);
  assert.equal(known.size, messages.length, 'Chinese source keys must be unique');
  for (const [zh, en] of messages) {
    assert.equal(/\p{Script=Han}/u.test(en), false, en);
    assert.deepEqual([...zh.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), [...en.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort());
    if (!zh.includes('{')) assert.equal(translate(zh), en);
  }
  for (const page of ['create', 'dashboard', 'environment', 'integrations', 'projects', 'tasks']) {
    const html = await readFile(new URL(`../../public/${page}/index.html`, import.meta.url), 'utf8');
    assert.match(html, /<html lang="en">/);
    assert.match(html, /id="language"/);
    for (const match of html.matchAll(/data-i18n(?:-placeholder|-aria-label|-content)?="([^"]+)"/g)) assert.ok(known.has(match[1]), match[1]);
  }
  for (const items of Object.values(catalog)) for (const item of items) for (const field of ['name', 'detail']) assert.equal(/\p{Script=Han}/u.test(translate(item[field])), false);
});

test('runtime diagnostics and legacy task logs translate while retaining names, paths, and CLI output', () => {
  assert.equal(translate('已完成，跳过：安装 npm 依赖（可取消，失败后可继续）'), 'Already completed, skipping: Installing npm dependencies (cancellable and resumable)');
  assert.equal(translate('Completed steps retained: 4. Project files are preserved.', 'zh-CN'), '已保留 4 个完成步骤与项目文件。');
  assert.equal(translate('当前账号：octocat'), 'Current account: octocat');
  assert.equal(translate('已应用「创建项目」，GitHub 发布保持关闭。'), 'Applied “创建项目”. GitHub publishing is off.');
  assert.equal(translate('本地项目已保留。GitHub 发布未完成：找不到这个创建任务。'), 'Local project preserved. GitHub publishing failed: Cannot find this creation task.');
  assert.equal(translate('解析技术栈与依赖版本\nadded 42 packages\nC:\\开发\\my-app'), 'Resolving stack and dependency versions\nadded 42 packages\nC:\\开发\\my-app');
  assert.equal(translate('下载失败（HTTP 503）：registry.npmjs.org'), 'Download failed (HTTP 503): registry.npmjs.org');
  assert.equal(translate('octocat/demo 已存在'), 'octocat/demo already exists');
  assert.equal(translate('Declared dependency', 'zh-CN'), '声明的依赖');
  assert.equal(translate('Environment variable DATABASE_URL is missing', 'zh-CN'), '缺少环境变量 DATABASE_URL');
  assert.equal(translate('PostgreSQL · localhost:5432/portal · 共享数据库'), 'PostgreSQL · localhost:5432/portal · Shared database');
});

test('generated documentation, starter code and development messages are English', () => {
  for (const frontend of ['vue', 'react', 'none']) for (const backend of ['spring', 'express', 'nestjs', 'none']) for (const database of ['mysql', 'postgres', 'none']) {
    if (frontend === 'none' && backend === 'none' || backend === 'none' && database !== 'none') continue;
    const options = { name: 'english-starter', frontend, backend, database };
    const readme = generatedReadme(options);
    assert.match(readme, /## Start developing/);
    const starter = backend === 'nestjs' ? nestFiles(options, {}) : expressFiles(options, {});
    assert.equal(/\p{Script=Han}/u.test(readme + JSON.stringify(frontendFiles(options, {})) + JSON.stringify(starter) + devScript(options)), false);
    if (database !== 'none') assert.match(readme, /retaining the data volume/);
  }
});
