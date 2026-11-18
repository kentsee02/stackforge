function yamlImages(text) {
  const images = new Map();
  let inServices = false, serviceIndent, propertyIndent, service;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const indent = /^ */.exec(line)[0].length;
    const content = line.slice(indent);
    if (indent === 0) {
      inServices = /^services:\s*(?:#.*)?$/.test(content);
      serviceIndent = undefined;
      continue;
    }
    if (!inServices) continue;
    serviceIndent ??= indent;
    if (indent === serviceIndent) {
      const heading = /^(?:"([\w.-]{1,64})"|'([\w.-]{1,64})'|([\w.-]{1,64})):\s*(?:#.*)?$/.exec(content);
      service = heading?.[1] ?? heading?.[2] ?? heading?.[3];
      propertyIndent = undefined;
    } else if (service && indent > serviceIndent) {
      propertyIndent ??= indent;
      if (indent !== propertyIndent) continue;
      const image = /^image:[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s#]+))[ \t]*(?:#.*)?$/.exec(content);
      if (image) images.set(service, images.has(service) ? undefined : image[1] ?? image[2] ?? image[3]);
    }
  }
  return images;
}

export function composeImages(text) {
  try {
    const { services } = JSON.parse(text.replace(/^\uFEFF/, '')) ?? {};
    return Object.entries(services ?? {}).filter(([service]) => /^[\w.-]{1,64}$/.test(service))
      .map(([service, spec]) => [service, spec?.image]);
  } catch { return yamlImages(text); }
}

export function composeImageName(image) {
  if (typeof image !== 'string') return;
  const name = /^(mcr\.microsoft\.com\/mssql\/server|(?:(?:docker\.io\/)?library\/)?[\w-]+)(?=[:@]|$)/.exec(image)?.[1];
  return name === 'mcr.microsoft.com/mssql/server' ? 'mssql' : name?.split('/').at(-1);
}
