import { dockerEndpointKind, pinDockerEndpointEnvironment, resolveDockerEndpoint } from './docker-context.mjs';
import { inspectLocalTools } from './environment-inventory.mjs';
import { gitIdentity, githubAccount } from './git.mjs';
import { run } from './process.mjs';
import { meetsToolMinimum } from './tool-versions.mjs';

const integrationToolIds = ['git', 'gh', 'docker', 'docker-compose'];
const desktopActions = ['picker', 'folder', 'terminal', 'vscode'];
const dockerVersion = /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:[-+][a-z\d.+-]{1,30})?$/i;

async function localEngine(cli, { command, env, platform }) {
  if (cli.status === 'missing') return { status: 'tool-missing' };
  const options = { env, stdoutOnly: true, timeout: 4500, stdoutLimit: 2048 };
  let endpoint;
  try { endpoint = await resolveDockerEndpoint(args => command(cli.path, args, options), env); }
  catch { return { status: 'context-unverified' }; }
  const kind = dockerEndpointKind(endpoint, platform);
  if (kind === 'other') return { status: 'non-local' };
  if (kind === 'unverified') return { status: 'context-unverified' };
  let output;
  try {
    output = await command(cli.path, ['--host', endpoint, 'info', '--format', '[{{json .ServerVersion}},{{json .OSType}}]'],
      { ...options, env: pinDockerEndpointEnvironment(env) });
  } catch { return { status: 'unreachable' }; }
  let details;
  try { details = JSON.parse(output); } catch { return { status: 'unverified' }; }
  if (!Array.isArray(details)) return { status: 'unverified' };
  const [version, mode] = details;
  if (typeof version !== 'string' || !dockerVersion.test(version) || !['linux', 'windows'].includes(mode)) return { status: 'unverified' };
  const status = mode === 'windows' ? 'windows-mode' : meetsToolMinimum('docker-engine', version) ? 'ready' : 'outdated';
  return { status, version, mode };
}

const toolSummary = ({ status, version }) => ({ status, ...(version && { version }) });

export function createIntegrationChecks({ desktop, command = run, inspectTools = inspectLocalTools, env = process.env, platform = process.platform } = {}) {
  let localPending, githubPending;
  async function inspect() {
    const toolReport = inspectTools({ ids: integrationToolIds, env, platform, command });
    const desktopReport = Promise.resolve().then(() => desktop.capabilities())
      .then(values => Object.fromEntries(desktopActions.map(action => [action, values[action] === true])))
      .catch(() => null);
    const { tools } = await toolReport;
    const [git, gh, docker, compose] = integrationToolIds.map(id => tools.find(tool => tool.id === id) ?? { status: 'missing' });
    const [identity, engine, capabilities] = await Promise.all([
      git.path && ['available', 'outdated'].includes(git.status) ?
        gitIdentity({}, (_, args, options) => command(git.path, args, { ...options, env, stdoutOnly: true }))
          .then(({ name, email }) => name && email ? 'configured' : 'unconfirmed') : 'unverified',
      localEngine(docker, { command, env, platform }),
      desktopReport
    ]);
    return { checkedAt: new Date().toISOString(), git: { tool: toolSummary(git), identity }, github: { tool: toolSummary(gh) },
      docker: { cli: toolSummary(docker), compose: toolSummary(compose), engine }, desktop: capabilities };
  }
  async function verifyGithub() {
    const githubEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_TELEMETRY: 'false' };
    try {
      const account = await githubAccount((name, args, options) => command(name, args, { ...options, env: githubEnv, stdoutOnly: true }));
      return { status: 'verified', account };
    } catch (error) {
      return { status: /\bHTTP 401\b|please run:\s*gh auth login|set the GH_TOKEN environment variable/i.test(error.message) ? 'sign-in-required' : 'unverified' };
    }
  }
  return {
    inspect: () => localPending ??= inspect().finally(() => { localPending = undefined; }),
    verifyGithub: () => githubPending ??= verifyGithub().finally(() => { githubPending = undefined; })
  };
}
