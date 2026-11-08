# StackForge

[English](README.md) | 华文

一个本地运行的全栈项目生成器。选择前端、后端和数据库，一键创建可以继续开发的项目。

支持 **Vue / React + Spring Boot / Express / NestJS + MySQL / PostgreSQL**，也可以只创建前端或后端。英文 / 华文界面（默认英文）、真实目录预览、依赖自动安装、执行日志和 Git 初始化。

在项目管理页可以启停本地项目、管理数据库、运行构建和测试，以及查看 Git 状态。

默认英文，支持华文切换并记住偏好；切换不刷新页面，也不会中断任务。生成项目的 README 和初始提示使用英文。保留取消、恢复、Windows 双击启动、环境检测、个人模板和 GitHub 发布。

## 快速开始

1. 安装 [Node.js 22.12 或更高版本](https://nodejs.org/en/download)，包含 npm。
2. 打开 [最新发布](https://github.com/kentsee02/stackforge/releases/latest)，在 **Assets** 下载 **Source code (zip)** 并解压。
3. Windows 用户双击解压文件夹内的 **Start StackForge.cmd**。macOS 或 Linux 用户在该文件夹打开终端，运行 `npm run launch`。

启动器会打开浏览器，默认使用 4310 端口。使用时请保持终端打开。StackForge 本身无需运行 `npm install`。如需克隆仓库或使用 Git 功能，请安装 Git。

如需试用最新开发版，可通过 Git 克隆仓库后启动。

```sh
git clone https://github.com/kentsee02/stackforge.git
cd stackforge
npm run launch
```

也可以运行 `npm start`，然后打开 [http://127.0.0.1:4310](http://127.0.0.1:4310)。可通过 `PORT` 指定端口，例如在 PowerShell 运行 `$env:PORT=4311; npm start`。

如果解压到新文件夹升级，先关闭 StackForge，再把旧目录下的 `.stackforge/` 复制到新目录，以保留项目记录和设置。

### 创建项目

1. 填写项目名称，点击「选择文件夹…」选择保存父目录，也可以在「保存到」中填写绝对路径。
2. 选择前端、后端、数据库，或使用快速预设。
3. 查看「创建前检查」结果，按需选择安装依赖和 Git 操作，然后点击「检查并创建项目」。
4. 创建完成后，可以从结果区用 VS Code 打开项目、打开文件夹，或打开已进入项目目录的终端。也可以从任务历史重新打开已完成的项目。

默认保存父目录是**用户主目录下的 Projects**：Windows 例如 `C:\Users\你的用户名\Projects`，macOS 为 `/Users/你的用户名/Projects`，Linux 为 `/home/你的用户名/Projects`。项目 `my-app` 会保存在其下的 `my-app` 子目录中，独立于 StackForge 安装位置。只有实际创建项目时才会创建目录，仍会检查写入权限与目标目录冲突。

「记住这个位置」会在下次打开时恢复上次的保存目录，并提供最多五个最近目录。设置保存在本机。取消勾选可清除记录，点击「使用默认位置」可回到默认目录。如需更换默认值，请在启动前将 `STACKFORGE_PROJECTS_DIR` 设为绝对路径。

桌面操作使用本机安装的应用。Windows 的「打开终端」会在项目目录启动 PowerShell。Linux 的「选择文件夹…」需要 `zenity` 或 `kdialog`。你也可以直接从结果区复制项目路径。

端口冲突时可用环境变量 `PORT` 修改监听端口。

Windows PowerShell：`$env:PORT=4311; npm start`。

## 管理本地项目

打开「项目管理」，可以查看当前这份 StackForge 创建过的项目，包括早期版本生成的项目。选中项目后点击「启动项目」，工具会运行它已有的 `scripts/dev.mjs`，并实时显示进程状态和输出。如果创建时跳过了依赖安装，请先安装该项目的依赖。

- 前端检查通过后可「打开网页」，后端 `/api/health` 检查通过后可「打开 API」。
- 「开发端口」按项目保存前端、后端和数据库端口，下次启动时生效。前端代理会跟随后端端口。使用旧版固定端口启动脚本的项目继续沿用原来的端口。
- 「导入项目」可选择任意已有的本地项目文件夹。StackForge 会检查根目录、常见子目录及 `package.json` 声明的 npm 或 Yarn 工作区，依据依赖和构建配置识别框架。同一个 Monorepo 可以显示多个框架。未识别到框架时显示为「外部项目」。含有效 StackForge 配置和启动脚本的项目可使用启停、依赖安装、端口和数据库管理。其他项目可查看 Git 状态、运行已识别的 npm 检查，也可从列表移除登记。
- 「从 GitHub 克隆」接受仓库 HTTPS 地址和保存父目录，通过本机 Git 和已配置的凭据访问私有仓库。克隆和本地导入使用同一套框架检测。删除时输入完整项目名，StackForge 会核对克隆标记与记录的文件系统身份，再将整个文件夹移到系统回收站。缺少目录身份记录的旧版克隆支持从列表移除。
- 「启动配置」适用于没有 StackForge 启动器的本地导入和 GitHub 克隆项目，最多可同时启动六个服务。为每个服务填写名称、相对工作目录和可信的前台命令，例如 `npm run dev`，用 `.` 表示项目根目录。可选的 HTTP 端口会在启动前检查冲突，并通过 `PORT` 传给进程。需要命令行参数的框架，请在命令中明确指定端口。点击「启动项目」会运行已保存的命令，并显示带服务名称的日志和已就绪的访问链接。点击「停止项目」会停止整组服务。命令保存在本机项目设置中，凭据请放在项目的环境文件里。
- 启动时遇到常见的端口、依赖、Java 或 Docker 问题，页面会在日志旁显示处理提示。

「安装依赖」会按项目技术栈运行 npm、通过项目自带的 Maven Wrapper 下载 Maven 依赖，或执行两者。安装日志会显示进度和错误。取消后可以重新安装。

「数据库管理」会显示 Docker Compose 数据库的状态和最近 100 行容器日志。它使用项目已保存的数据库端口，可以单独启动和停止数据库。停止数据库会保留数据卷。

「下载备份」可导出正在运行的 StackForge 数据库，PostgreSQL 使用自定义归档，MySQL 使用 SQL 文件。删除确认框也提供下载备份入口。MySQL 导出表结构、数据、视图和触发器。「恢复备份」接受同一种数据库的可信文件，大小上限为 64 MiB。请先停止应用，启动空的项目数据库，再输入完整项目名确认。MySQL 恢复失败时可能留下部分已恢复的对象。

「构建、测试与代码检查」会列出项目根目录、前端或后端声明的 `build`、`test` 和 `lint` 命令。Spring Boot 项目还可通过 Maven Wrapper 运行 `package` 和 `test`。运行检查前请停止项目。面板会显示实时日志和最近一次结果，运行中可以取消。

「Git 状态」显示当前分支、未提交的改动，以及与跟踪的上游分支相比领先或落后的提交数。刷新时会读取本地仓库，并以上次 fetch 或 pull 留下的上游记录为准。

「停止项目」会停止从这个页面启动的开发进程。正常关闭 StackForge 时，也会停止这些进程。开发日志和安装日志保存在内存中，重启 StackForge 后会清空。

「删除项目」会显示完整路径，并要求输入完全一致的项目名。请先在 StackForge 停止项目。新生成的项目和新导入的受管项目在删除前会核对记录的文件系统身份。较早登记的受管项目继续使用项目配置文件核对。项目文件会移到系统回收站，可以恢复到原位。项目的本地 Docker 数据库容器和专属数据卷会永久删除。删除带数据库的项目时，Docker 必须运行。遇到无法核实归属的数据卷时，StackForge 会阻止删除，例如没有对应容器的旧版数据卷。Linux 上将文件移到系统回收站需要 `gio`，所在磁盘也须支持系统回收站。

## 生成内容

- Vue 3 或 React，搭配 Vite 与 TypeScript。前端 `/api` 会代理到后端，默认端口为 8080。
- Spring Boot：从官方 Spring Initializr 下载稳定版本，包含 Java 21、Maven Wrapper、健康检查 API 和可选 JDBC 驱动。
- Express：健康检查 API，可选 mysql2 / pg 连接池和数据库检查接口。
- NestJS 提供 TypeScript 模块、健康检查控制器、开发热重载和可选的 MySQL 或 PostgreSQL 连接。NestJS 全栈预设搭配 React 和 PostgreSQL。
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

远程发布在本地项目创建完成后执行。发布失败时，本地代码、提交和依赖会保留，可点击「重试 GitHub 发布」；重启服务后也可从任务记录中找回。已创建并记录的远程仓库在重试前会校验账号、仓库 ID 和可见性，不会重复创建。网络中断导致创建结果未记录时，请先检查 GitHub 仓库，工具不会擅自复用同名仓库。

## 取消与恢复

创建时点击「取消任务」，工具会中止下载和安装进程，并等待子进程停止。未完成的项目保存在所选父目录下的 `.stackforge-*` 临时目录；取消不会删除已有文件。

失败或取消后点击「继续未完成的步骤」，会沿用原任务配置，跳过完成的步骤，从未完成的步骤重试。已完成步骤生成的文件、已有 `.env` 密码和安装缓存会保留；正在生成但尚未完成的步骤可能重新写入其文件。若要更换技术栈、名称或保存位置，请新建任务。

任务记录保存在工具目录下被 Git 忽略的 `.stackforge/jobs/` 中，包含路径、配置、日志和进度，不复制 `.env` 密码或 GitHub 令牌。重启工具后，可在「任务记录」中选择并继续。恢复会验证临时目录归属；目录被移动、删除或标记不符时停止操作。不要将 `.stackforge/` 提交或分享，其中可能包含本机路径与提交身份。

## 环境与网络

- 工具本身：Node.js 22.12+；推荐 Node.js 24 LTS。
- Spring Boot：Java 21+，无需全局安装 Maven。自动安装选项会通过 Wrapper 预下载 Java 依赖。
- 数据库：Docker Desktop 或 Docker Engine + Compose v2。创建时生成配置，首次 `npm run dev` 时拉取镜像并启动。
- Git 初始化：本机需要 Git 2.28+；首次提交额外需要姓名和邮箱，GitHub 发布额外需要已认证的 GitHub CLI。
- 生成时需要访问 npm registry；选择 Spring Boot 时还需访问 start.spring.io。Maven 和 Docker 在首次下载时也需要网络。

工具只监听 `127.0.0.1`，不要将它作为公网服务部署。写入 API 校验 Host、Origin 和每次启动随机生成的请求令牌。执行固定命令，不接受自定义 shell 命令。

创建过程使用临时目录，成功后才放到目标路径；遇到已存在的项目目录会拒绝覆盖。工具不会自动清理取消任务的临时目录或测试数据库的数据卷。

## 开发

```sh
npm test
npm run check
npm start
```

代码分为 `src/generator.mjs`（创建流程）、`src/checkpoint.mjs`（步骤恢复）、`src/jobs.mjs` 与 `src/job-store.mjs`（任务和持久化）、`src/templates.mjs`（技术栈模板）、`src/environment.mjs`（环境检查）、`src/git.mjs`（Git 和 GitHub）、`src/server.mjs`（本机 API）及 `public/`（界面）。测试使用 Node.js 自带运行器，覆盖技术栈、环境诊断、模板过滤、真实本地提交、子进程取消、重启恢复、目录归属、启动器和 API 写入保护。`npm test` 中的 GitHub 发布测试使用模拟 API，不创建远程仓库。

真实联调可执行 `npm run test:integration`。需要 Node.js、Git、可用的 Docker 引擎及网络，并保持 5173 / 8080 端口空闲。Spring Boot 联调还需要 Java 21。脚本会在 `work/integration/` 生成 Vue + Express + PostgreSQL、React + Spring Boot + MySQL 和 React + NestJS + PostgreSQL，安装依赖并构建，启动开发服务，通过前端代理执行真实数据库查询，并保存 `report.json`。结束后会停止测试服务和容器，保留生成项目与数据库数据卷以便检查。

可选参数 `--only=node`、`--only=java` 或 `--only=nest` 可只验证一组。显式执行 `npm run test:integration -- --only=node --github --repo-name=你的测试仓库名` 会使用当前已认证的 GitHub 账号创建并推送**新的私有仓库**，校验远程提交；仓库会保留，不归档或删除。默认联调不操作 GitHub。

欢迎通过 Issue 或 PR 添加框架和模板。说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 当前范围

支持 npm、Java 21 / Maven、Vue / React、Express / Spring Boot / NestJS、MySQL / PostgreSQL。暂不提供全局运行环境安装、桌面安装包、更多包管理器或远程部署。生成的是开发骨架，业务功能、身份验证和生产部署配置需要按需求添加。

## 致谢与许可

使用 [Vite](https://vite.dev/guide/)、[Spring Initializr](https://docs.spring.io/initializr/docs/current/reference/html/) 的官方接口与配置约定。界面的 IBM Plex Sans 字体来自 [IBM Plex](https://github.com/IBM/plex)，遵循 SIL Open Font License，见 [public/OFL.txt](public/OFL.txt)。本项目按 [MIT](LICENSE) 开源。
