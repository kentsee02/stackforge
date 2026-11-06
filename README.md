# StackForge

一个本地运行的全栈项目生成器。选择前端、后端和数据库，一键创建可以继续开发的项目。

支持 **Vue / React + Spring Boot / Express + MySQL / PostgreSQL**，也可以只创建前端或后端。中文界面、真实目录预览、依赖自动安装、执行日志和 Git 初始化。

v0.2 增加创建前环境检测、自定义模板，以及分开的本地 Git 初始化、首次提交和 GitHub 发布操作。

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
3. 查看「创建前检查」结果，按需选择安装依赖和 Git 操作，然后点击「检查并创建项目」。
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

数据库密码放在被 Git 忽略的 `.env` 中，`.env.example` 可安全分享。首次提交和远程发布都是可选操作，默认关闭。

## 创建前环境检测

按当前选择检查 Node.js、npm、JDK、Git、提交身份、下载源连接、保存目录及开发端口；使用数据库时检查 Compose 与 Docker 引擎。勾选 GitHub 发布后才检查 GitHub CLI 的认证账号和仓库名称。

标红的问题会阻止创建，并附处理方法。JDK / npm 只有在勾选自动安装依赖时才必须立即可用；Docker 引擎未启动、开发端口占用等显示为启动提示，仍可先生成文件。每次实际创建都会重新检查，页面上的检测结果只代表检测时刻。

## 自定义模板

在「我的模板」中填写名称并保存当前技术栈。选择模板即可恢复配置；同名保存会更新该模板。支持导出 JSON 备份和导入，导入时跳过同名模板，最多保存 20 个。

模板保存在当前浏览器、当前地址的本地存储中。更换浏览器或端口时可通过导出 / 导入迁移，清除浏览器数据会删除本地模板。模板只包含技术栈、Group ID、依赖安装、本地 Git 和首次提交选项；不保存项目路径、提交者身份、凭据或 GitHub 发布授权。应用模板始终关闭远程发布。

## Git 与 GitHub

- **初始化本地 Git 仓库**：需要 Git 2.28+，不需要账号或登录。
- **创建首次提交**：需要 Git 姓名和邮箱，可以使用已有配置，或在界面中填写。界面填写的身份只写入新项目，不修改全局设置。
- **创建 GitHub 仓库并推送**：需要安装 [GitHub CLI](https://cli.github.com/)，先在终端执行 `gh auth login --hostname github.com`。工具使用该 CLI 当前账号创建新仓库，并推送 main 分支。此选项自动包含本地初始化和首次提交，默认创建私有仓库；可以明确选择公开。

工具不收集账号密码或令牌，也不会更改全局 Git 凭据配置。仅支持当前 GitHub 账号下的新仓库；同名仓库已存在时不会复用或覆盖。

远程发布在本地项目创建完成后执行。发布失败时，本地代码、提交和依赖会保留，可在当前服务会话点击「重试 GitHub 发布」。已创建并记录的远程仓库在重试前会校验账号、仓库 ID 和可见性，不会重复创建。重启服务后任务记录清空，可使用 Git / GitHub CLI 手动继续推送。网络中断导致创建结果未记录时，请先检查 GitHub 仓库，工具不会擅自复用同名仓库。

## 环境与网络

- 工具本身：Node.js 22.12+；推荐 Node.js 24 LTS。
- Spring Boot：Java 21+，无需全局安装 Maven。自动安装选项会通过 Wrapper 预下载 Java 依赖。
- 数据库：Docker Desktop 或 Docker Engine + Compose v2。创建时生成配置，首次 `npm run dev` 时拉取镜像并启动。
- Git 初始化：本机需要 Git 2.28+；首次提交额外需要姓名和邮箱，GitHub 发布额外需要已认证的 GitHub CLI。
- 生成时需要访问 npm registry；选择 Spring Boot 时还需访问 start.spring.io。Maven 和 Docker 在首次下载时也需要网络。

工具只监听 `127.0.0.1`，不要将它作为公网服务部署。写入 API 校验 Host、Origin 和每次启动随机生成的请求令牌。执行固定命令，不接受自定义 shell 命令。

创建过程使用临时目录，成功后才放到目标路径；遇到已存在的项目目录会拒绝覆盖。任务记录只保存在服务内存中；刷新同一浏览器标签可继续查看，重启服务后记录会清空。

## 开发

```sh
npm test
npm run check
npm start
```

代码分为 `src/generator.mjs`（创建流程）、`src/templates.mjs`（技术栈模板）、`src/environment.mjs`（环境检查）、`src/git.mjs`（Git 和 GitHub）、`src/server.mjs`（本机 API）及 `public/`（操作界面和浏览器模板存储）。测试覆盖技术栈组合、配置校验、失败清理、ZIP 路径、环境诊断、模板导入过滤、真实本地提交、远程发布恢复和本机 API 写入保护。远程发布测试使用模拟 API，不创建真实测试仓库。测试使用 Node.js 自带测试运行器。

欢迎通过 Issue 或 PR 添加框架和模板。说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 当前范围

第一版提供 npm、Java 21 / Maven、Vue / React、Express / Spring Boot、MySQL / PostgreSQL。暂不提供全局运行环境安装、桌面安装包、更多包管理器或远程部署。生成的是开发骨架，业务功能、身份验证和生产部署配置需要按需求添加。

## 致谢与许可

使用 [Vite](https://vite.dev/guide/)、[Spring Initializr](https://docs.spring.io/initializr/docs/current/reference/html/) 的官方接口与配置约定。界面的 IBM Plex Sans 字体来自 [IBM Plex](https://github.com/IBM/plex)，遵循 SIL Open Font License，见 [public/OFL.txt](public/OFL.txt)。本项目按 [MIT](LICENSE) 开源。
