import { readFile } from 'node:fs/promises';
import metadata from '../../package.json' with { type: 'json' };

const assets = new Map([
  ['/', 'create/index.html'],
  ['/projects', 'projects/index.html'],
  ['/app.js', 'create/page.js'],
  ['/projects.js', 'projects/page.js'],
  ['/projects/database.js', 'projects/database.js'],
  ['/projects/startup.js', 'projects/startup.js'],
  ['/projects/preflight.js', 'projects/preflight.js'],
  ['/projects/dependencies.js', 'projects/dependencies.js'],
  ['/projects/tools.js', 'projects/tools.js'],
  ['/projects/activity.js', 'projects/activity.js'],
  ['/projects/postgres-setup.js', 'projects/postgres-setup.js'],
  ['/projects/drizzle-preview.js', 'projects/drizzle-preview.js'],
  ['/projects/alembic-preview.js', 'projects/alembic-preview.js'],
  ['/projects/ef-core-preview.js', 'projects/ef-core-preview.js'],
  ['/projects/flyway-preview.js', 'projects/flyway-preview.js'],
  ['/projects/liquibase-preview.js', 'projects/liquibase-preview.js'],
  ['/projects/migration-source-preview.js', 'projects/migration-source-preview.js'],
  ['/projects/migration-history.js', 'projects/migration-history.js'],
  ['/projects/native-migration.js', 'projects/native-migration.js'],
  ['/projects/development-postgres.js', 'projects/development-postgres.js'],
  ['/i18n.js', 'shared/i18n.js'],
  ['/messages.js', 'shared/messages.js'],
  ['/template-store.js', 'create/template-store.js'],
  ['/style.css', 'shared/base.css'],
  ['/projects/styles.css', 'projects/styles.css'],
  ['/plex-regular.ttf', 'fonts/plex-regular.ttf'],
  ['/plex-semibold.ttf', 'fonts/plex-semibold.ttf']
]);
const contentTypes = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  ttf: 'font/ttf'
};

export async function serveAsset(res, pathname) {
  const asset = assets.get(pathname);
  if (!asset) return false;
  const extension = asset.split('.').at(-1);
  const file = new URL('../../public/' + asset, import.meta.url);
  const content = extension === 'html' ? (await readFile(file, 'utf8')).replace('{{version}}', metadata.version) : await readFile(file);
  res.writeHead(200, { 'Content-Type': contentTypes[extension], 'Cache-Control': 'no-cache' });
  res.end(content);
  return true;
}
