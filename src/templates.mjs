import { hasNodeBackend } from './catalog.mjs';

export const json = value => JSON.stringify(value, null, 2) + '\n';

export function frontendFiles(options, versions) {
  const vue = options.frontend === 'vue';
  const extension = vue ? 'vue' : 'tsx';
  const hasBackend = options.backend !== 'none';
  const message = hasBackend ? 'Connecting to the backend…' : 'Your frontend is ready';
  const request = hasBackend ? "fetch('/api/health').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(data => setMessage(data.message)).catch(() => setMessage('The backend is not running. Run npm run dev in the project root.'));" : '';
  const app = vue
    ? `<script setup lang="ts">\nimport { ref, onMounted } from 'vue';\nconst message = ref(${JSON.stringify(message)});\nconst setMessage = (value: string) => { message.value = value; };\nonMounted(() => { ${request} });\n</script>\n<template><main><p>Created with StackForge</p><h1>${options.name}</h1><p>{{ message }}</p></main></template>\n`
    : `import { useEffect, useState } from 'react';\nexport default function App() {\n  const [message, setMessage] = useState(${JSON.stringify(message)});\n  useEffect(() => { ${request} }, []);\n  return <main><p>Created with StackForge</p><h1>${options.name}</h1><p>{message}</p></main>;\n}\n`;
  return {
    'frontend/package.json': json({ name: `${options.name}-web`, private: true, version: '0.1.0', type: 'module', scripts: { dev: 'vite --host 127.0.0.1', build: 'vite build', preview: 'vite preview --host 127.0.0.1' }, dependencies: vue ? { vue: versions.vue } : { react: versions.react, 'react-dom': versions['react-dom'] }, devDependencies: { vite: versions.vite, typescript: versions.typescript, [vue ? '@vitejs/plugin-vue' : '@vitejs/plugin-react']: versions[vue ? '@vitejs/plugin-vue' : '@vitejs/plugin-react'], ...(!vue && { '@types/react': versions['@types/react'], '@types/react-dom': versions['@types/react-dom'] }) } }),
    'frontend/index.html': `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${options.name}</title></head><body><div id="app"></div><script type="module" src="/src/main.${vue ? 'ts' : 'tsx'}"></script></body></html>\n`,
    'frontend/vite.config.ts': `import { defineConfig, loadEnv } from 'vite';\nimport ${vue ? 'vue' : 'react'} from '${vue ? '@vitejs/plugin-vue' : '@vitejs/plugin-react'}';\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, '.', 'STACKFORGE_');\n  return { plugins: [${vue ? 'vue' : 'react'}()], server: { port: Number(env.STACKFORGE_FRONTEND_PORT || 5173), strictPort: true${hasBackend ? ", proxy: { '/api': 'http://127.0.0.1:' + Number(env.STACKFORGE_BACKEND_PORT || 8080) }" : ''} } };\n});\n`,
    [`frontend/src/main.${vue ? 'ts' : 'tsx'}`]: vue ? `import { createApp } from 'vue';\nimport App from './App.vue';\nimport './style.css';\ncreateApp(App).mount('#app');\n` : `import { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './style.css';\ncreateRoot(document.getElementById('app')!).render(<App />);\n`,
    [`frontend/src/App.${extension}`]: app,
    'frontend/src/vite-env.d.ts': '/// <reference types="vite/client" />\n',
    'frontend/tsconfig.json': json({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, isolatedModules: true, noEmit: true }, include: ['src', 'vite.config.ts'] }),
    'frontend/src/style.css': 'body{margin:0;background:#f5f8f9;color:#16262b;font-family:system-ui,sans-serif}main{max-width:720px;margin:15vh auto;padding:32px}h1{font-size:clamp(32px,6vw,64px);letter-spacing:-.04em;overflow-wrap:anywhere}p{line-height:1.7}::selection{background:#c5e3e9}\n'
  };
}

function nodeDatabase(database) {
  if (database === 'none') return;
  const mysql = database === 'mysql';
  const driver = mysql ? 'mysql2' : 'pg';
  const source = mysql ? "import mysql from 'mysql2/promise';" : "import pg from 'pg';";
  const factory = mysql ? 'mysql.createPool' : 'new pg.Pool';
  const pool = `${factory}({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || ${mysql ? 3306 : 5432}),
  user: process.env.DB_USER || 'app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'app',
})`;
  return { driver, source, pool };
}

export function expressFiles(options, versions) {
  const db = options.database;
  const database = nodeDatabase(db);
  const databaseCode = database ? `${database.source}\nconst pool = ${database.pool};\n` : '';
  return {
    'backend/package.json': json({ name: `${options.name}-api`, private: true, version: '0.1.0', type: 'module', scripts: { dev: 'node --watch src/server.js', start: 'node src/server.js' }, dependencies: { express: versions.express, ...(database && { [database.driver]: versions[database.driver] }) } }),
    'backend/src/server.js': `import express from 'express';\n${databaseCode}\nconst app = express();\napp.use(express.json());\napp.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'Hello, ${options.name}! The frontend and backend are connected.' }));\n${db === 'none' ? '' : `app.get('/api/db', async (req, res) => {\n  try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: '${db}' }); }\n  catch { res.status(503).json({ status: 'unavailable', message: 'Check the database container and environment variables.' }); }\n});\n`}const port = Number(process.env.STACKFORGE_BACKEND_PORT || 8080);\nconst server = app.listen(port, '127.0.0.1', () => console.log('API: http://127.0.0.1:' + port + '/api/health'));\nasync function shutdown() { server.close(); ${db === 'none' ? '' : 'await pool.end();'} process.exit(0); }\nprocess.on('SIGINT', shutdown);\nprocess.on('SIGTERM', shutdown);\n`
  };
}

export function nestFiles(options, versions) {
  const database = nodeDatabase(options.database);
  const dependencies = ['@nestjs/common', '@nestjs/core', '@nestjs/platform-express', 'reflect-metadata', 'rxjs'];
  const devDependencies = ['@nestjs/cli', '@types/node', 'typescript'];
  if (database) dependencies.push(database.driver);
  if (options.database === 'postgres') devDependencies.push('@types/pg');
  const resolved = names => Object.fromEntries(names.map(name => [name, versions[name]]));

  return {
    'backend/package.json': json({
      name: `${options.name}-api`, private: true, version: '0.1.0', type: 'module',
      scripts: { dev: 'nest start --watch', build: 'nest build', start: 'node dist/main.js' },
      dependencies: resolved(dependencies), devDependencies: resolved(devDependencies)
    }),
    'backend/nest-cli.json': json({ sourceRoot: 'src', compilerOptions: { tsConfigPath: 'tsconfig.json', deleteOutDir: true } }),
    'backend/tsconfig.json': json({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', rootDir: 'src', outDir: 'dist', types: ['node'],
        experimentalDecorators: true, emitDecoratorMetadata: true, strict: true, skipLibCheck: true, sourceMap: true
      },
      include: ['src/**/*.ts']
    }),
    'backend/src/main.ts': `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number(process.env.STACKFORGE_BACKEND_PORT || 8080);
  await app.listen(port, '127.0.0.1');
  console.log('API: http://127.0.0.1:' + port + '/api/health');
}

void bootstrap();
`,
    'backend/src/app.module.ts': `import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
${database ? "import { DatabaseService } from './database.service.js';\n" : ''}
@Module({
  controllers: [HealthController],${database ? '\n  providers: [DatabaseService],' : ''}
})
export class AppModule {}
`,
    'backend/src/health.controller.ts': `import { Controller, Get${database ? ', ServiceUnavailableException' : ''} } from '@nestjs/common';
${database ? "import { DatabaseService } from './database.service.js';\n" : ''}
@Controller('api')
export class HealthController {
${database ? '  constructor(private readonly database: DatabaseService) {}\n\n' : ''}  @Get('health')
  health() {
    return { status: 'ok', message: 'Hello, ${options.name}! The frontend and backend are connected.' };
  }${database ? `

  @Get('db')
  async databaseHealth() {
    try {
      await this.database.check();
      return { status: 'ok', database: '${options.database}' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        message: 'Check the database container and environment variables.',
      });
    }
  }` : ''}
}
`,
    ...(database && { 'backend/src/database.service.ts': `import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
${database.source}

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool = ${database.pool.replaceAll('\n', '\n  ')};
${options.database === 'postgres' ? `
  constructor() {
    this.pool.on('error', error => console.error('Idle database connection failed:', error.message));
  }
` : ''}

  async check() {
    await this.pool.query('SELECT 1');
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
` })
  };
}

export function databaseFiles(options, password, rootPassword, databaseId) {
  const mysql = options.database === 'mysql';
  const port = mysql ? 3306 : 5432;
  const composeName = `${options.name.slice(0, 35)}-${databaseId}`;
  const volume = `\nvolumes:\n  db_data:\n    labels:\n      io.stackforge.database-id: "${databaseId}"\n`;
  return {
    '.env': `COMPOSE_PROJECT_NAME=${composeName}\nDB_HOST=127.0.0.1\nDB_PORT=${port}\nDB_NAME=app\nDB_USER=app\nDB_PASSWORD=${password}\n${mysql ? `DB_ROOT_PASSWORD=${rootPassword}\n` : ''}`,
    '.env.example': `# COMPOSE_PROJECT_NAME=unique-local-project-name\nDB_HOST=127.0.0.1\nDB_PORT=${port}\nDB_NAME=app\nDB_USER=app\nDB_PASSWORD=replace-with-a-local-password\n${mysql ? 'DB_ROOT_PASSWORD=replace-with-a-root-password\n' : ''}`,
    'compose.yaml': mysql ? `services:\n  db:\n    image: mysql:8.4\n    environment:\n      MYSQL_DATABASE: \${DB_NAME:?DB_NAME required}\n      MYSQL_USER: \${DB_USER:?DB_USER required}\n      MYSQL_PASSWORD: \${DB_PASSWORD:?DB_PASSWORD required}\n      MYSQL_ROOT_PASSWORD: \${DB_ROOT_PASSWORD:?DB_ROOT_PASSWORD required}\n    ports:\n      - "127.0.0.1:\${DB_PORT:-3306}:3306"\n    volumes:\n      - db_data:/var/lib/mysql\n    healthcheck:\n      test: ["CMD-SHELL", "MYSQL_PWD=$$MYSQL_ROOT_PASSWORD mysqladmin ping -h 127.0.0.1 -u root --silent"]\n      interval: 5s\n      timeout: 5s\n      retries: 30${volume}` : `services:\n  db:\n    image: postgres:17\n    environment:\n      POSTGRES_DB: \${DB_NAME:?DB_NAME required}\n      POSTGRES_USER: \${DB_USER:?DB_USER required}\n      POSTGRES_PASSWORD: \${DB_PASSWORD:?DB_PASSWORD required}\n    ports:\n      - "127.0.0.1:\${DB_PORT:-5432}:5432"\n    volumes:\n      - db_data:/var/lib/postgresql/data\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]\n      interval: 5s\n      timeout: 5s\n      retries: 20${volume}`
  };
}

export function devScript(options) {
  return `import { spawn } from 'node:child_process';\nimport { readFileSync, existsSync } from 'node:fs';\nimport { parseEnv } from 'node:util';\nimport { fileURLToPath } from 'node:url';\nimport { dirname, join } from 'node:path';\nconst root = dirname(dirname(fileURLToPath(import.meta.url)));\nconst managedPorts = Object.fromEntries(['STACKFORGE_FRONTEND_PORT', 'STACKFORGE_BACKEND_PORT', 'STACKFORGE_DATABASE_PORT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));\nif (existsSync(join(root, '.env'))) Object.assign(process.env, parseEnv(readFileSync(join(root, '.env'), 'utf8')), managedPorts);\nif (process.env.STACKFORGE_DATABASE_PORT) process.env.DB_PORT = process.env.STACKFORGE_DATABASE_PORT;\nconst npmCli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].find(p => p?.endsWith('npm-cli.js') && existsSync(p));\nif (!npmCli) throw new Error('Start with npm run dev, or install the official Node.js distribution including npm.');\nconst children = [];\nlet stopping = false;\nfunction stop(code = 0) {\n  if (stopping) return; stopping = true;\n  for (const child of children) { if (!child.pid) continue; if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } }\n  setTimeout(() => process.exit(code), 500);\n}\nfunction launch(command, args, folder = root) {\n  const child = spawn(command, args, { cwd: folder, env: process.env, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });\n  children.push(child);\n  child.on('error', error => { console.error(error.message); stop(1); });\n  child.on('exit', code => { if (!stopping) stop(code ?? 1); });\n  return child;\n}\nprocess.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());\n${options.database === 'none' ? '' : `console.log('Starting the database and waiting until it is ready…');\nawait new Promise((resolve, reject) => { const child = spawn('docker', ['compose', 'up', '-d', '--wait'], { cwd: root, stdio: 'inherit', windowsHide: true }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Database startup failed. Ensure Docker Desktop is running, then check .env and ports.'))); });\n`}${options.frontend === 'none' ? '' : `launch(process.execPath, [npmCli, 'run', 'dev'], join(root, 'frontend'));\n`}${hasNodeBackend(options.backend) ? `launch(process.execPath, [npmCli, 'run', 'dev'], join(root, 'backend'));\n` : options.backend === 'spring' ? `if (process.platform === 'win32') launch(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'mvnw.cmd spring-boot:run'], join(root, 'backend'));\nelse launch('./mvnw', ['spring-boot:run'], join(root, 'backend'));\n` : ''}`;
}

export function generatedReadme(options) {
  const lines = [
    `# ${options.name}`, '', 'Generated with [StackForge](https://github.com/kentsee02/stackforge).', '',
    `Stack: ${options.frontend} / ${options.backend} / ${options.database}. Resolved versions are recorded in package.json and stackforge.json; npm installation creates a package-lock.json.`, '',
    '## Requirements', '', '- Node.js 22.12 or later, including npm (Node.js 24 LTS recommended)',
    ...(options.backend === 'spring' ? ['- Java 21 or later; Maven Wrapper is included, so no global Maven installation is required'] : []),
    ...(options.database !== 'none' ? ['- Docker Desktop or Docker Engine with Compose v2'] : []), '',
    '## Start developing', '', 'Run from the project root:', '', '```sh', 'npm install', 'npm run dev', '```', '',
    ...(options.database !== 'none' ? ['The launcher reads .env, starts the database container, and waits for it to become ready. The first run downloads the database image.', ''] : []),
    ...(options.frontend !== 'none' ? ['- Frontend: http://127.0.0.1:5173'] : []),
    ...(options.backend !== 'none' ? ['- Health endpoint: http://127.0.0.1:8080/api/health'] : []),
    ...(options.database !== 'none' ? ['- Database check: http://127.0.0.1:8080/api/db'] : []), '',
    'Press Ctrl+C to stop the frontend and backend.' + (options.database !== 'none' ? ' The database keeps running. Use npm run db:down to stop its container while retaining the data volume.' : ''), '',
    ...(options.database !== 'none' ? ['## Local configuration', '', 'Unique random passwords are stored in .env, which Git ignores. When sharing this project, copy .env.example to .env and set new passwords. Database ports bind only to the local loopback address. Change DB_PORT to avoid local port conflicts; the development launcher and backend use this configuration.', ''] : []),
    '## Structure', '',
    ...(options.frontend !== 'none' ? ['- frontend/: Vite and TypeScript frontend'] : []),
    ...(options.backend !== 'none' ? ['- backend/: Backend service'] : []),
    ...(options.database !== 'none' ? ['- compose.yaml: Database service and persistent data volume'] : []),
    '- scripts/dev.mjs: Cross-platform development launcher', '- stackforge.json: Generator options and resolved versions', '',
    '## Next steps', '',
    ...(options.backend === 'nestjs' ? [`Run npm run build to build the NestJS backend${options.frontend === 'none' ? '' : ' and the frontend'}.`, ''] :
      options.frontend !== 'none' ? ['Run npm run build to check the frontend production build.', ''] : []),
    ...(options.backend === 'spring' ? ['Run ./mvnw test in backend/ (mvnw.cmd test on Windows) to test the backend.', ''] : []),
    'This is a development starter. Add business logic, authentication, and deployment configuration for your project.', ''
  ];
  return lines.join('\n');
}
