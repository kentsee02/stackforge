export async function resolveDockerEndpoint(probe, env = process.env) {
  const context = env.DOCKER_CONTEXT || (!env.DOCKER_HOST && (await probe(['context', 'show'])).trim());
  return context ? JSON.parse(await probe(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}', '--', context])) : env.DOCKER_HOST;
}

export function dockerEndpointKind(endpoint, platform = process.platform) {
  if (typeof endpoint !== 'string') return 'unverified';
  if (platform !== 'win32') return /^unix:\/\/\/[^\r\n]+$/.test(endpoint) ? 'local' : 'other';
  if (/^npipe:\/\/\/\/\.\/pipe\/(?:docker_engine|dockerDesktopLinuxEngine)$/i.test(endpoint)) return 'local';
  return /^npipe:\/\/\/\/\.\/pipe\/dockerDesktopWindowsEngine$/i.test(endpoint) ? 'windows' : 'other';
}

export function pinDockerEndpointEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^DOCKER_(CONTEXT|HOST|TLS|TLS_VERIFY|CERT_PATH)$/i.test(key)));
}
