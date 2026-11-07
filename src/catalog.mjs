export const catalog = {
  frontend: [
    { id: 'vue', name: 'Vue', detail: 'Vue 3 · Vite · TypeScript' },
    { id: 'react', name: 'React', detail: 'React · Vite · TypeScript' },
    { id: 'none', name: '不需要前端', detail: '仅生成后端服务' }
  ],
  backend: [
    { id: 'spring', name: 'Spring Boot', detail: 'Java 21 · Maven Wrapper' },
    { id: 'express', name: 'Express', detail: 'Node.js · REST API' },
    { id: 'nestjs', name: 'NestJS', detail: 'Node.js · TypeScript · Modules' },
    { id: 'none', name: '不需要后端', detail: '仅生成前端应用' }
  ],
  database: [
    { id: 'mysql', name: 'MySQL', detail: 'Docker Compose · JDBC / mysql2' },
    { id: 'postgres', name: 'PostgreSQL', detail: 'Docker Compose · JDBC / pg' },
    { id: 'none', name: '不需要数据库', detail: '不生成数据库服务' }
  ]
};

export const hasNodeBackend = backend => backend === 'express' || backend === 'nestjs';

export function validateOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('项目配置必须是对象。');
  const options = { name: input.name, parentDir: input.parentDir, frontend: input.frontend ?? 'vue', backend: input.backend ?? 'spring', database: input.database ?? 'mysql', groupId: input.groupId ?? 'com.example', install: input.install ?? true, git: input.git ?? true, commit: input.commit ?? false, publish: input.publish ?? false, authorName: input.authorName ?? '', authorEmail: input.authorEmail ?? '', repoName: input.repoName || input.name, visibility: input.visibility ?? 'private' };
  if (typeof options.name !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(options.name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(options.name)) throw new Error('项目名需为 2–48 位小写字母、数字或短横线，以字母开头，并避开系统保留名称。');
  if (typeof options.parentDir !== 'string' || !options.parentDir.trim() || options.parentDir.includes('\0')) throw new Error('请选择有效的保存目录。');
  for (const key of ['frontend', 'backend', 'database']) if (!catalog[key].some(item => item.id === options[key])) throw new Error(`不支持的 ${key} 选项。`);
  if (options.frontend === 'none' && options.backend === 'none') throw new Error('至少选择一个前端或后端。');
  if (options.backend === 'none' && options.database !== 'none') throw new Error('数据库需要搭配后端，请选择后端或取消数据库。');
  if (typeof options.groupId !== 'string' || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(options.groupId) || options.groupId.split('.').some(p => ['class', 'package', 'import', 'int', 'public', 'private', 'static', 'void', 'new', 'if', 'else', 'for', 'while', 'return', 'var', 'record', 'enum', 'interface', 'default', 'switch', 'case', 'break', 'null', 'true', 'false', 'try', 'catch', 'finally', 'throw', 'throws', 'extends', 'implements', 'super', 'this', 'instanceof', 'abstract', 'boolean', 'byte', 'char', 'double', 'float', 'long', 'short', 'native', 'protected', 'final', 'synchronized', 'transient', 'volatile', 'assert', 'const', 'goto', 'do', 'continue', 'strictfp'].includes(p))) throw new Error('Java Group ID 需为合法包名，例如 com.example。');
  for (const key of ['install', 'git', 'commit', 'publish']) if (typeof options[key] !== 'boolean') throw new Error('安装依赖和 Git 选项必须为布尔值。');
  if (options.commit && !options.git) throw new Error('首次提交需要先初始化 Git。');
  if (options.publish && (!options.git || !options.commit)) throw new Error('发布到 GitHub 需要初始化 Git 并创建首次提交。');
  if (typeof options.authorName !== 'string' || options.authorName.length > 100 || /[\x00-\x1f\x7f<>]/.test(options.authorName)) throw new Error('提交者姓名不可包含控制字符或尖括号，最多 100 字。');
  if (typeof options.authorEmail !== 'string' || options.authorEmail.length > 254 || (options.authorEmail && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(options.authorEmail))) throw new Error('请填写有效的提交者邮箱。');
  if (typeof options.repoName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(options.repoName) || options.repoName.toLowerCase().endsWith('.git')) throw new Error('GitHub 仓库名称需为 1–100 位字母、数字、短横线、下划线或点，且不能以 .git 结尾。');
  if (!['private', 'public'].includes(options.visibility)) throw new Error('仓库可见性必须为 private 或 public。');
  return options;
}
