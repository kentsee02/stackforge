# StackForge

面向反复初始化全栈项目的开发者。工具在本机运行，通过中文浏览器界面将前端、后端、数据库选择转换为一个独立目录。

第一版支持 Vue / React / 无前端，Spring Boot / Express / 无后端，MySQL / PostgreSQL / 无数据库。生成真实代码、API 代理、数据库驱动、Compose、随机本地凭据、Maven Wrapper、可选依赖安装和 Git 初始化。提供日志、错误与重试。

它只监听本机回环地址；不会安装系统级 Node、Java 或 Docker。使用者需自行具备对应运行环境。生成数据库配置，首次启动开发脚本才拉取 Docker 镜像。保存目标不可覆盖已有目录。

本项目使用 MIT 开源许可，第一版以无第三方运行时依赖的 Node.js 本地工具交付。
