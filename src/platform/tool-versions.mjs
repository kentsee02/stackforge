export const toolMinimums = { node: [22, 12], java: [21], git: [2, 28], 'docker-compose': [2], 'docker-engine': [28] };

export function meetsToolMinimum(id, output) {
  const minimum = toolMinimums[id];
  if (!minimum) return true;
  const version = /(?:^|[^\d])([0-9]+)(?:\.([0-9]+))?/.exec(output);
  if (!version) return false;
  const major = Number(version[1]), minor = Number(version[2] ?? 0);
  return major > minimum[0] || major === minimum[0] && minor >= (minimum[1] ?? 0);
}
