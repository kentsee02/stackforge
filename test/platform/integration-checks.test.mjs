import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntegrationChecks } from '../../src/platform/integration-checks.mjs';
import { createApp } from '../../src/http/server.mjs';

const tools = [
  { id: 'git', path: '/tools/git', status: 'available', version: '2.50.0' },
  { id: 'gh', path: '/tools/gh', status: 'available', version: '2.85.0' },
  { id: 'docker', path: '/tools/docker', status: 'available', version: '29.0.1' },
  { id: 'docker-compose', path: '/tools/docker', status: 'available', version: '2.40.0' }
];

test('integration inspection verifies local Docker and capabilities without contacting GitHub or disclosing config', async () => {
  const calls = [];
  const checks = createIntegrationChecks({
    platform: 'linux',
    env: { DOCKER_HOST: 'ssh://private-host', DOCKER_CONTEXT: 'selected', DOCKER_CERT_PATH: '/private-cert' },
    inspectTools: async ({ ids }) => { assert.deepEqual(ids, tools.map(tool => tool.id)); return { tools }; },
    desktop: { capabilities: async () => ({ picker: true, folder: true, terminal: false, vscode: false, extra: 'private' }) },
    command: async (name, args, { env }) => {
      calls.push([name, ...args]);
      if (name.endsWith('/git')) return 'unreported-identity';
      if (args[0] === 'context') {
        assert.deepEqual(args.slice(-2), ['--', 'selected']);
        return '"unix:///var/run/docker.sock"';
      }
      assert.deepEqual(args.slice(0, 3), ['--host', 'unix:///var/run/docker.sock', 'info']);
      assert.equal(env.DOCKER_HOST, undefined);
      assert.equal(env.DOCKER_CONTEXT, undefined);
      assert.equal(env.DOCKER_CERT_PATH, undefined);
      return '["28.4.0","linux"]';
    }
  });
  const pending = checks.inspect();
  assert.equal(checks.inspect(), pending);
  const view = await pending;
  assert.deepEqual(view.docker.engine, { status: 'ready', version: '28.4.0', mode: 'linux' });
  assert.equal(view.git.identity, 'configured');
  assert.deepEqual(view.desktop, { picker: true, folder: true, terminal: false, vscode: false });
  assert.doesNotMatch(JSON.stringify(view), /private|\/tools\/|unreported|docker\.sock/);
  assert.equal(calls.some(([name]) => name === 'gh' || name.endsWith('/gh')), false);
});

test('local Docker checks distinguish different engine states and skip unsupported endpoints', async () => {
  const cases = [
    ['npipe:////./pipe/dockerDesktopWindowsEngine', '["29.0.1","windows"]', 'windows-mode'],
    ['npipe:////./pipe/dockerDesktopLinuxEngine', '["27.5.0","linux"]', 'outdated'],
    ['npipe:////./pipe/dockerDesktopLinuxEngine', new Error('cannot connect to private socket'), 'unreachable'],
    ['npipe:////./pipe/dockerDesktopLinuxEngine', 'unexpected private data', 'unverified'],
    ['ssh://private-host', null, 'non-local']
  ];
  for (const [endpoint, output, status] of cases) {
    let dockerCalls = 0;
    const checks = createIntegrationChecks({ platform: 'win32', env: { DOCKER_HOST: endpoint },
      inspectTools: async () => ({ tools: tools.slice(2) }),
      desktop: { capabilities: async () => { throw new Error('private-desktop-error'); } },
      command: async () => { dockerCalls++; if (output instanceof Error) throw output; return output; } });
    const report = await checks.inspect();
    assert.equal(report.docker.engine.status, status);
    assert.equal(dockerCalls, status === 'non-local' ? 0 : 1);
    assert.equal(report.desktop, null);
    assert.doesNotMatch(JSON.stringify(report), /private|npipe:\/\//);
  }
});

test('GitHub verification requires the local write token and exposes only the verified handle or a known status', async t => {
  let count = 0;
  const integrations = createIntegrationChecks({
    env: { GH_TOKEN: 'private-token' },
    command: async (name, args, { env }) => {
      assert.equal(name, 'gh');
      assert.deepEqual(args, ['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
      assert.equal(env.GH_PROMPT_DISABLED, '1');
      if (++count === 1) return 'octocat\n';
      throw new Error(count === 2 ? 'gh: Bad credentials (HTTP 401)' : 'private error and request data');
    }
  });
  const app = createApp({ stateDir: false, integrations });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const origin = 'http://127.0.0.1:' + app.address().port;
  const url = origin + '/api/integrations/github';
  const request = headers => fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...headers } });
  const unauthorized = await request();
  assert.equal(unauthorized.status, 403);
  assert.equal(count, 0);
  await unauthorized.text();
  const { token } = await (await fetch(origin + '/api/state')).json();
  const header = { 'x-stackforge-token': token };
  assert.deepEqual(await (await request(header)).json(), { status: 'verified', account: 'octocat' });
  assert.deepEqual(await (await request(header)).json(), { status: 'sign-in-required' });
  assert.deepEqual(await (await request(header)).json(), { status: 'unverified' });
});
