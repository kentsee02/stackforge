# StackForge

一个本地运行的全栈项目生成器。选择前端、后端和数据库，一键创建可以继续开发的项目。

支持 **Vue / React + Spring Boot / Express + MySQL / PostgreSQL**，也可以只创建前端或后端。中文界面、真实目录预览、依赖自动安装、执行日志和 Git 初始化。

## 快速开始

先安装 [Node.js](https://nodejs.org/) 22.12+（推荐 24 LTS，自带 npm）和 Git，然后：

```sh
git clone https://github.com/kentsee02/stackforge.git
cd stackforge
npm start
```

打开 **http://127.0.0.1:4310**。生成器本身没有第三方运行时依赖，不需要先执行 npm install。

1. 填写项目名称与保存父目录。
2. 选择前端、后端、数据库，或使用侧栏预设。
3. 按需选择安装依赖、初始化 Git，然后点击「创建项目」。
4. 成功后进入生成目录，执行 `npm run dev`。

端口冲突时可用环境变量 `PORT` 修改监听端口。

Windows PowerShell：`$env:PORT=4311; npm start`。

## 生成内容

- Vue 3 或 React，搭配 Vite 与 TypeScript；前端 `/api` 代理到本机 8080。
- Spring Boot：从官方 Spring Initializr 下载稳定版本，包含 Java 21、Maven Wrapper、健康检查 API 和可选 JDBC 驱动。
- Express：健康检查 API，可选 mysql2 / pg 连接池和数据库检查接口。
- MySQL 8.4 或 PostgreSQL 17：Compose、持久化数据卷、健康检查，以及随机生成的本地密码。
- npm workspaces 管理前端与 Node 后端；统一开发脚本在需要时自动启动数据库。
- README、.gitignore、stackforge.json、可选 Git main 分支。
- npm 包在创建时解析当前版本并写入精确版本号；安装后由 lockfile 锁定。

数据库密码放在被 Git 忽略的 `.env` 中，`.env.example` 可安全分享。生成器不会自动替项目提交 Git 记录或推送远程仓库。

## 环境与网络

- 工具本身：Node.js 22.12+；推荐 Node.js 24 LTS。
- Spring Boot：Java 21+，无需全局安装 Maven。自动安装选项会通过 Wrapper 预下载 Java 依赖。
- 数据库：Docker Desktop 或 Docker Engine + Compose v2。创建时生成配置，首次 `npm run dev` 时拉取镜像并启动。
- Git 初始化：本机需要 Git。
- 生成时需要访问 npm registry；选择 Spring Boot 时还需访问 start.spring.io。Maven 和 Docker 在首次下载时也需要网络。

工具只监听 `127.0.0.1`，不要将它作为公网服务部署。写入 API 校验 Host、Origin 和每次启动随机生成的请求令牌。执行固定命令，不接受自定义 shell 命令。

创建过程使用临时目录，成功后才放到目标路径；遇到已存在的项目目录会拒绝覆盖。任务记录只保存在服务内存中；刷新同一浏览器标签可继续查看，重启服务后记录会清空。

## 开发

```sh
npm test
npm run check
npm start
```

代码分为 `src/generator.mjs`（创建流程）、`src/templates.mjs`（技术栈模板）、`src/server.mjs`（本机 API）及 `public/`（操作界面）。测试覆盖技术栈组合、配置校验、失败清理、ZIP 路径和本机 API 写入保护。测试使用 Node.js 自带测试运行器。

欢迎通过 Issue 或 PR 添加框架和模板。说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 当前范围

第一版提供 npm、Java 21 / Maven、Vue / React、Express / Spring Boot、MySQL / PostgreSQL。暂不提供全局运行环境安装、桌面安装包、更多包管理器或远程部署。生成的是开发骨架，业务功能、身份验证和生产部署配置需要按需求添加。

## 致谢与许可

使用 [Vite](https://vite.dev/guide/)、[Spring Initializr](https://docs.spring.io/initializr/docs/current/reference/html/) 的官方接口与配置约定。界面的 IBM Plex Sans 字体来自 [IBM Plex](https://github.com/IBM/plex)，遵循 SIL Open Font License，见 [public/OFL.txt](public/OFL.txt)。本项目按 [MIT](LICENSE) 开源。
