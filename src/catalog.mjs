export const catalog = {
  frontend: [
    { id: 'vue', name: 'Vue', detail: 'Vue 3 · Vite · TypeScript' },
    { id: 'react', name: 'React', detail: 'React · Vite · TypeScript' },
    { id: 'none', name: '不需要前端', detail: '仅生成后端服务' }
  ],
  backend: [
    { id: 'spring', name: 'Spring Boot', detail: 'Java 21 · Maven Wrapper' },
    { id: 'express', name: 'Express', detail: 'Node.js · REST API' },
    { id: 'none', name: '不需要后端', detail: '仅生成前端应用' }
  ],
  database: [
    { id: 'mysql', name: 'MySQL', detail: 'Docker Compose · JDBC / mysql2' },
    { id: 'postgres', name: 'PostgreSQL', detail: 'Docker Compose · JDBC / pg' },
    { id: 'none', name: '不需要数据库', detail: '不生成数据库服务' }
  ]
};

export function validateOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('项目配置必须是对象。');
  const options = { name: input.name, parentDir: input.parentDir, frontend: input.frontend ?? 'vue', backend: input.backend ?? 'spring', database: input.database ?? 'mysql', groupId: input.groupId ?? 'com.example', install: input.install ?? true, git: input.git ?? true };
  if (typeof options.name !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(options.name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(options.name)) throw new Error('项目名需为 2–48 位小写字母、数字或短横线，以字母开头，并避开系统保留名称。');
  if (typeof options.parentDir !== 'string' || !options.parentDir.trim() || options.parentDir.includes('\0')) throw new Error('请选择有效的保存目录。');
  for (const key of ['frontend', 'backend', 'database']) if (!catalog[key].some(item => item.id === options[key])) throw new Error(`不支持的 ${key} 选项。`);
  if (options.frontend === 'none' && options.backend === 'none') throw new Error('至少选择一个前端或后端。');
  if (options.backend === 'none' && options.database !== 'none') throw new Error('数据库需要搭配后端，请选择后端或取消数据库。');
  if (typeof options.groupId !== 'string' || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(options.groupId) || options.groupId.split('.').some(p => ['class', 'package', 'import', 'int', 'public', 'private', 'static', 'void', 'new', 'if', 'else', 'for', 'while', 'return', 'var', 'record', 'enum', 'interface', 'default', 'switch', 'case', 'break', 'null', 'true', 'false', 'try', 'catch', 'finally', 'throw', 'throws', 'extends', 'implements', 'super', 'this', 'instanceof', 'abstract', 'boolean', 'byte', 'char', 'double', 'float', 'long', 'short', 'native', 'protected', 'final', 'synchronized', 'transient', 'volatile', 'assert', 'const', 'goto', 'do', 'continue', 'strictfp'].includes(p))) throw new Error('Java Group ID 需为合法包名，例如 com.example。');
  if (typeof options.install !== 'boolean' || typeof options.git !== 'boolean') throw new Error('安装依赖和 Git 选项必须为布尔值。');
  return options;
}
