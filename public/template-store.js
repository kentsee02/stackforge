// Portable presets deliberately exclude paths, project names, commit identities
// and remote publication: applying a template never opts into sharing code.
const allowed = { frontend: ['vue', 'react', 'none'], backend: ['spring', 'express', 'none'], database: ['mysql', 'postgres', 'none'] };
export function normalizeTemplate(input) {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 40) throw new Error('模板名称需为 1–40 字。');
  const config = input.config;
  if (!config || typeof config !== 'object') throw new Error('模板缺少配置。');
  const output = {};
  for (const key of Object.keys(allowed)) {
    if (!allowed[key].includes(config[key])) throw new Error('模板包含不支持的技术栈。');
    output[key] = config[key];
  }
  if (output.frontend === 'none' && output.backend === 'none' || output.backend === 'none' && output.database !== 'none') throw new Error('模板的技术栈组合无效。');
  for (const key of ['install', 'git', 'commit']) { if (typeof config[key] !== 'boolean') throw new Error('模板中的初始化选项无效。'); output[key] = config[key]; }
  if (output.commit && !output.git) throw new Error('首次提交需要先初始化 Git。');
  if (typeof config.groupId !== 'string' || config.groupId.length > 150 || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(config.groupId)) throw new Error('模板的 Group ID 无效。');
  output.groupId = config.groupId;
  return { name: input.name.trim(), config: output };
}

export function parseTemplateFile(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 65536) throw new Error('模板文件不能超过 64 KB。');
  let file;
  try { file = JSON.parse(text); } catch { throw new Error('无法读取 JSON 模板文件。'); }
  if (file?.format !== 'stackforge-presets' || file.version !== 1 || !Array.isArray(file.templates) || file.templates.length > 20) throw new Error('模板文件格式不支持，或模板数量超过 20 个。');
  const templates = file.templates.map(normalizeTemplate);
  if (new Set(templates.map(item => item.name)).size !== templates.length) throw new Error('模板文件包含重名模板。');
  return templates;
}
