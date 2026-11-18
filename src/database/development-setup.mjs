import { databaseKey, discoverDatabases } from './discovery.mjs';
import { databaseResource } from './registry.mjs';

const relational = ['postgres', 'mysql'];

export async function developmentOptions(project, supported) {
  const { requirements, limited } = await discoverDatabases(project);
  const groups = new Map();
  for (const item of requirements) {
    if (!relational.includes(item.engine) && !relational.includes(item.declaredEngine)) continue;
    if (!groups.has(item.directory)) groups.set(item.directory, []);
    groups.get(item.directory).push(item);
  }
  const options = [];
  for (const [directory, rows] of groups) {
    const configured = rows.filter(item => item.kind !== 'compose' && (item.orm || item.status !== 'declared'));
    const evidence = configured.length ? configured : rows;
    const engines = new Set(evidence.flatMap(item => [item.engine, item.declaredEngine].filter(engine => relational.includes(engine))));
    const conflict = configured.length > 0 && (engines.size > 1 || configured.some(item => item.status === 'ambiguous' ||
      item.declaredEngine && item.declaredEngine !== item.engine));
    for (const engine of engines) {
      const matching = rows.filter(item => item.engine === engine);
      const variant = matching.find(item => item.variant)?.variant;
      const actions = [...new Map(matching.filter(item => item.kind === 'compose' ? directory === '.' && !item.variant : item.status === 'configured')
        .map(item => {
          const resource = databaseResource(project, item);
          return [resource?.instance.id, resource && { id: resource.binding.id, source: item.source, provider: resource.instance.provider }];
        }).filter(([, action]) => action)).values()];
      const status = conflict ? 'conflict' : evidence.every(item => item.status === 'declared' && !item.orm) ? 'review' : 'detected';
      const id = databaseKey(project.id, directory, engine, variant, limited, evidence.map(item => [item.id, item.status, item.declaredEngine,
        item.host, item.port, item.name, item.connectionFields, item.environmentEdit?.revision]));
      options.push({ id, directory, engine, variant, status, canCreate: !limited && !conflict && !variant && supported.includes(engine), actions,
        requirementIds: matching.map(item => item.id), evidence: [...new Set((conflict ? evidence : matching).map(item => item.source))] });
    }
  }
  return { options, limited };
}
