import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateProject } from '../src/generator.mjs';
import { validateOptions } from '../src/catalog.mjs';
import { extractZip } from '../src/zip.mjs';
import { createApp } from '../src/server.mjs';
import { request } from 'node:http';

function zip(entries) {
  const locals = [], directory = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const n = Buffer.from(name), data = Buffer.from(value);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(header, n, data); directory.push(central, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const springZip = zip({ 'mvnw': '#!/bin/sh\n', 'mvnw.cmd': '@echo off\n', 'pom.xml': '<project><dependencies></dependencies></project>', 'src/main/java/com/example/app/Application.java': 'package com.example.app;' });
const services = {
  fetchImpl: async url => {
    if (url.includes('/starter.zip')) assert.equal(new URL(url).searchParams.get('bootVersion'), '3.5.0');
    return new Response(url.includes('/starter.zip') ? springZip : JSON.stringify(url.includes('metadata/client') ? { bootVersion: { default: '4.0.0-SNAPSHOT', values: [{ id: '4.0.0-SNAPSHOT' }, { id: '3.5.0.RELEASE' }] }, javaVersion: { values: [{ id: '21' }] } } : { version: '1.2.3' }));
  },
  run: async () => '', npm: async () => ''
};
const base = { name: 'sample-app', frontend: 'vue', backend: 'spring', database: 'mysql', install: false, git: false };

test('all 29 supported stack combinations produce connected, parseable projects', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'stackforge-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  let count = 0;
  let nestOnlyInstalls = 0;
  const databaseIds = new Set();
  for (const frontend of ['vue', 'react', 'none']) for (const backend of ['spring', 'express', 'nestjs', 'none']) for (const database of ['mysql', 'postgres', 'none']) {
    if (frontend === 'none' && backend === 'none' || backend === 'none' && database !== 'none') continue;
    const name = `project-${count++}`;
    const install = frontend === 'none' && backend === 'nestjs';
    const result = await generateProject({ ...base, parentDir: parent, name, frontend, backend, database, install }, () => {}, {
      ...services, npm: async args => { assert.equal(args[0], 'install'); nestOnlyInstalls++; }
    });
    const pkg = JSON.parse(await readFile(join(result.path, 'package.json'), 'utf8'));
    assert.equal(pkg.name, name);
    const manifest = JSON.parse(await readFile(join(result.path, 'stackforge.json'), 'utf8'));
    assert.equal(manifest.options.parentDir, undefined);
    if (backend === 'spring') assert.equal(manifest.versions.springBoot, '3.5.0');
    if (backend === 'express') {
      const express = JSON.parse(await readFile(join(result.path, 'backend/package.json'), 'utf8'));
      assert.match(express.scripts.dev, /tsx watch src\/server\.ts/);
      assert.match(express.scripts.test, /node --test/);
      assert.equal(express.devDependencies.typescript, manifest.versions.typescript);
      assert.equal(Boolean(express.devDependencies['@types/pg']), database === 'postgres');
      assert.match(await readFile(join(result.path, 'backend/src/app.ts'), 'utf8'), /\/api\/health/);
      assert.match(await readFile(join(result.path, 'backend/test/health.test.mjs'), 'utf8'), /\/api\/health/);
    }
    if (backend === 'nestjs') {
      assert.ok(pkg.workspaces.includes('backend'));
      assert.match(pkg.scripts.build, /--workspace backend/);
      const nest = JSON.parse(await readFile(join(result.path, 'backend/package.json'), 'utf8'));
      assert.equal(nest.dependencies['@nestjs/common'], nest.dependencies['@nestjs/core']);
      assert.equal(nest.dependencies['@nestjs/platform-express'], nest.dependencies['@nestjs/core']);
      assert.equal(nest.devDependencies.typescript, manifest.versions.typescript);
      assert.match(nest.scripts.test, /node --test/);
      assert.equal(Boolean(nest.dependencies.pg), database === 'postgres');
      assert.equal(Boolean(nest.dependencies.mysql2), database === 'mysql');
      assert.equal(Boolean(nest.devDependencies['@types/pg']), database === 'postgres');
      assert.match(await readFile(join(result.path, 'scripts/dev.mjs'), 'utf8'), /launch\(process\.execPath, \[npmCli, 'run', 'dev'\], join\(root, 'backend'\)\)/);
      const controller = await readFile(join(result.path, 'backend/src/health.controller.ts'), 'utf8');
      assert.equal(controller.includes("@Get('db')"), database !== 'none');
      if (database !== 'none') assert.match(await readFile(join(result.path, 'backend/src/database.service.ts'), 'utf8'), /SELECT 1/);
    }
    if (database !== 'none') {
      const env = await readFile(join(result.path, '.env'), 'utf8');
      assert.match(env, /DB_PASSWORD=[0-9a-f]{48}/);
      const compose = await readFile(join(result.path, 'compose.yaml'), 'utf8');
      assert.match(compose, /127.0.0.1:\$\{DB_PORT/);
      assert.match(manifest.databaseId, /^[a-f0-9]{24}$/);
      assert.match(env, new RegExp(`^COMPOSE_PROJECT_NAME=${name}-${manifest.databaseId}$`, 'm'));
      assert.match(compose, new RegExp(`io.stackforge.database-id: "${manifest.databaseId}"`));
      assert.equal(databaseIds.has(manifest.databaseId), false);
      databaseIds.add(manifest.databaseId);
      assert.match(await readFile(join(result.path, '.gitignore'), 'utf8'), /^\.env$/m);
    }
    if (frontend !== 'none') {
      const config = await readFile(join(result.path, 'frontend/vite.config.ts'), 'utf8');
      assert.equal(config.includes('proxy:'), backend !== 'none');
      const frontendPackage = JSON.parse(await readFile(join(result.path, 'frontend/package.json'), 'utf8'));
      assert.equal(frontendPackage.scripts.test, 'vitest run');
      assert.match(await readFile(join(result.path, 'frontend/src/App.test.' + (frontend === 'vue' ? 'ts' : 'tsx')), 'utf8'), /renders the project heading/);
    }
    if (pkg.workspaces) assert.match(pkg.scripts.test, /--workspaces/);
  }
  assert.equal(count, 29);
  assert.equal(nestOnlyInstalls, 3);
});

test('rejects unsafe project inputs and invalid combinations', () => {
  for (const name of ['../escape', 'con', 'nul', 'hello;whoami', 'Hello', 'a', 'a/b']) assert.throws(() => validateOptions({ ...base, name, parentDir: tmpdir() }));
  assert.throws(() => validateOptions({ ...base, parentDir: tmpdir(), backend: 'none' }), /数据库/);
  assert.throws(() => validateOptions({ ...base, parentDir: tmpdir(), groupId: 'com.class' }), /包名/);
  assert.throws(() => validateOptions({ ...base, parentDir: tmpdir(), install: 'true' }), /布尔/);
});

test('does not overwrite existing files; failed creation cleans only its staging folder', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'stackforge-failure-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, base.name));
  await writeFile(join(parent, base.name, 'keep.txt'), 'user data');
  await assert.rejects(generateProject({ ...base, parentDir: parent }, () => {}, services), /已经存在/);
  assert.equal(await readFile(join(parent, base.name, 'keep.txt'), 'utf8'), 'user data');
  await assert.rejects(generateProject({ ...base, name: 'failed-app', parentDir: parent }, () => {}, { ...services, fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
  assert.deepEqual(await readdir(parent), [base.name]);
});

test('ZIP extraction rejects traversal, symlink-like drives, duplicate paths and invalid content', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'stackforge-zip-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const name of ['../escape.txt', 'C:/escape.txt', 'nested/../../escape.txt']) await assert.rejects(extractZip(zip({ [name]: 'bad' }), parent), /不安全/);
  await assert.rejects(extractZip(Buffer.from('not a zip'), parent), /ZIP/);
  await assert.rejects(extractZip(zip({ 'File.txt': '1', 'file.txt': '2' }), parent), /不安全/);
});

test('HTTP API restricts hosts and cross-origin writes, serializes generation and exposes completion', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const server = createApp({ stateDir: false, check: async () => ({ canCreate: true, checks: [] }), generate: async (input, report) => { report({ type: 'step', message: 'working', progress: 50 }); await gate; return { path: 'project', commands: ['npm run dev'] }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(origin + '/api/state')).json();
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = request(origin + '/api/state', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHostStatus, 403);
  const body = JSON.stringify({ ...base, parentDir: tmpdir() });
  const headers = { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token };
  assert.equal((await fetch(origin + '/api/projects', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body })).status, 403);
  assert.equal((await fetch(origin + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  const response = await fetch(origin + '/api/projects', { method: 'POST', headers, body });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.equal((await fetch(origin + '/api/projects', { method: 'POST', headers, body })).status, 409);
  assert.equal((await (await fetch(origin + `/api/jobs/${id}`)).json()).progress, 50);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await (await fetch(origin + `/api/jobs/${id}`)).json()).status, 'complete');
});
