import assert from 'node:assert/strict';
import test from 'node:test';
import { installMavenDependencies } from '../../src/platform/process.mjs';

const distributionFailure = new Error('./mvnw exited 1\nwget: Failed to fetch https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.10.4/apache-maven-3.10.4-bin.zip');

test('Maven dependency prefetch retries Wrapper distribution failures and preserves ordinary build errors', async () => {
  let calls = 0;
  const log = [];
  const result = await installMavenDependencies({ log: entry => log.push(entry) }, async () => {
    if (++calls === 1) throw distributionFailure;
    return 'dependencies ready';
  });
  assert.equal(result, 'dependencies ready');
  assert.equal(calls, 2);
  assert.match(log.join(''), /Retrying/);
  calls = 0;
  await assert.rejects(installMavenDependencies({}, async () => { calls++; throw new Error('invalid pom.xml'); }), /invalid pom/);
  assert.equal(calls, 1);
});

test('cancellation during the Maven Wrapper retry wait prevents a second invocation', async () => {
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(installMavenDependencies({ signal: controller.signal, log: () => controller.abort() },
    async () => { calls++; throw distributionFailure; }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
