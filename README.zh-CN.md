<div align="center">

🌐 **[中文文档](./README.zh-CN.md) · [English](./README.md)**

# 🛰️ Web Collection

> 前端监控、会话回放与产品分析 —— 一个 SDK，一个控制台。

<p align="center">
  <a href="https://github.com/programmerguohuajing/web-collection"><img src="https://img.shields.io/github/stars/programmerguohuajing/web-collection" alt="GitHub stars" /></a>
  <a href="https://www.npmjs.com/package/@web-collection/sdk"><img src="https://img.shields.io/npm/dm/@web-collection/sdk" alt="npm downloads" /></a>
  <a href="https://www.npmjs.com/package/@web-collection/sdk"><img src="https://img.shields.io/npm/v/@web-collection/sdk" alt="npm version" /></a>
  <a href="https://web-collection.jingguohua.cc.cd/overview"><img src="https://img.shields.io/badge/demo-online-brightgreen" alt="Live Demo" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

</div>

Web Collection 是 **pnpm monorepo** 前端监控系统：Vue 3 + Element Plus 控制台、Node/Cloudflare D1 API、浏览器 SDK —— 并提供 **MCP 服务** 与 **内置 AI 能力**（智能诊断、基线异常检测、知识中枢），让人和智能体都能通过标准协议查询与处置遥测数据。用控制台定位 **错误、性能、回放、链路与埋点** 问题。

👉 [阅读用户手册](docs/user-manual.zh-CN.md)

<table>
  <tr>
    <td align="center">🐛<br><b>错误监控</b><br>JS · Promise · 资源 · Worker</td>
    <td align="center">⚡<br><b>性能监控</b><br>Web Vitals · 长任务</td>
    <td align="center">🎬<br><b>会话回放</b><br>rrweb · Canvas · iframe</td>
  </tr>
  <tr>
    <td align="center">🔗<br><b>分布式链路</b><br>traceparent · 拓扑</td>
    <td align="center">📊<br><b>行为与曝光</b><br>PV · 点击 · 漏斗</td>
    <td align="center">🔒<br><b>隐私与治理</b><br>采样 · 脱敏</td>
  </tr>
</table>

## 🌟 0.5.0 新特性

- **SDK 心跳探针** —— 检测采集黑洞（客户端已发、服务端零入库），通过 `onStatus` / `eys.monitoring()` 暴露 `server-blackhole` 等级。
- **留存 / 同期群分析** —— 新增洞察页，按首次访问同期群观测留存曲线。
- **智能基线异常检测** —— Node 与 Cloudflare 双后端基线偏离告警。
- **知识中枢** —— Article 模型 + 治理台 / 帮助中心。
- **独立 MCP 服务** —— 基于 REST 数据平面的 13 个工具，并预留 D1 直连。
- **OTLP 导出** —— 可开启的 `otlp`（http/json）导出到 OpenTelemetry Collector。
- **多端 SDK 首发** —— 首发 `@web-collection/sdk-react-native` 与 `@web-collection/sdk-electron`（各自 0.1.0）。

完整变更见 [CHANGELOG](./CHANGELOG.md)。

## 🤖 AI 与 MCP

Web Collection 不只是控制台——它内置**智能能力**并提供**面向智能体的标准接口**，让人和 AI 工具都能查询与处置遥测数据。

- **MCP 服务**（`apps/mcp`）：独立部署的 [Model Context Protocol](https://modelcontextprotocol.io) 服务，在 REST 数据平面之上暴露 **13 个工具**（并预留 D1 直连），Claude / Cursor / 任意 MCP 客户端可经标准协议拉取错误、Trace、回放、会话与分析数据。→ [MCP 服务文档](apps/mcp/README.md)
- **AI 诊断与助手**：控制台内的 AI 诊断助手，以 Markdown 渲染根因 / 影响 / 修复建议。→ [用户手册 §15](docs/user-manual.zh-CN.md)
- **智能基线异常检测**：Node 与 Cloudflare 双后端自动基线偏离告警，无需手工阈值。→ [用户手册 §13](docs/user-manual.zh-CN.md)
- **知识中枢**：治理台 + 控制台内帮助中心，沉淀 runbook / playbook。→ [用户手册 §14](docs/user-manual.zh-CN.md)
- **OTLP 导出**（可选）：将事件流式导出到任意 OpenTelemetry Collector。→ [SDK 文档 · OTLP](packages/sdk/README.zh-CN.md)

## 📑 目录

- [🌟 0.5.0 新特性](#050-新特性)
- [🤖 AI 与 MCP](#ai-与-mcp)
- [🚀 快速开始](#快速开始)
- [🐳 Docker 与 K8s 容器化部署](#docker--k8s-容器化部署)
- [🔌 SDK 接入](#sdk-接入)
- [📚 使用文档](#使用文档)
- [📂 项目结构](#项目结构)
- [📜 脚本一览](#脚本一览)

## 📚 使用文档

本仓库 README 只做**项目介绍**。具体的接入与使用说明请看以下文档：

- **[用户手册（中文）](docs/user-manual.zh-CN.md)**（[English](docs/user-manual.md)）：控制台功能、部署、告警、SourceMap、产品分析等完整使用说明。
- **[SDK 文档（中文）](packages/sdk/README.zh-CN.md)**（[English](packages/sdk/README.md)）：SDK 接入、全部能力、配置项与 API 参考。

## 📂 项目结构

- `apps/web`: 前端监控控制台
- `apps/api`: Node 后端服务
- `packages/sdk`: 浏览器监控 SDK
- `packages/sdk/src/error`: JS、Promise、资源错误采集
- `packages/sdk/src/performance`: 性能采集，包含 `fetch.js`、`xhr.js`、`websocket.js`、`sse.js`
- `packages/sdk/src/behavior`: PV、点击、路由、停留、滚动行为采集
- `packages/sdk/src/exposure`: 元素曝光采集
- `packages/sdk/src/replay`: rrweb 会话回放采集

## 🚀 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 10
- PostgreSQL >= 12

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

在项目根目录创建 `.env` 文件，或通过系统环境变量配置：

```bash
PORT=8787
DATABASE_URL=postgresql://user:pass@localhost:5432/web_collection
ADMIN_API_KEY=your-secret-key
COLLECT_TOKEN=
CORS_ORIGIN=http://127.0.0.1:5173
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/your-token
ALERT_SECRET_MASTER_KEY=replace-with-a-long-random-value
ALERT_PUBLIC_BASE_URL=https://monitor.example.com
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
```

也可以拆分 PostgreSQL 配置：

```bash
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=postgres
DB_NAME=web_collection
```

Windows PowerShell 示例：

```powershell
$env:ADMIN_API_KEY="change-me"
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/web_collection"
```

### 3. 初始化数据库

```bash
pnpm --filter @web-collection/api db:init
```

会创建事件、错误、回放、SourceMap、应用版本、采集策略和告警审计所需的数据表。

### 4. 开发模式

开发模式需要同时运行 API 服务和前端控制台。

终端 1：启动 API 服务，默认端口 `8787`。

```bash
pnpm dev
```

终端 2：启动前端控制台，默认端口 `5173`。

```bash
pnpm dev:web
```

访问 `http://127.0.0.1:5173` 或 `http://你的局域网IP:5173`，输入 `ADMIN_API_KEY` 后查看数据。Vite 默认监听 `0.0.0.0`，因此局域网内其他设备也可以访问。

### 5. 生产模式

先构建前端控制台和 SDK：

```bash
pnpm build
```

构建产物：

- 前端控制台：`apps/web/dist`
- SDK：`packages/sdk/dist`
- 统一产物目录：`dist/`

API 服务会托管 Web 控制台和 SDK：

- 控制台：`http://127.0.0.1:8787/`
- IIFE SDK：`http://127.0.0.1:8787/sdk/web-collection-sdk.iife.js`
- ES Module SDK：`http://127.0.0.1:8787/sdk/web-collection-sdk.es.js`
- 兼容入口：`http://127.0.0.1:8787/web-collection-sdk.iife.js`
- 兼容入口：`http://127.0.0.1:8787/web-collection-sdk.es.js`

启动生产服务：

```bash
pnpm --filter @web-collection/api start
```

等价于：

```bash
pm2 start ecosystem.config.cjs --only web-collection-api --env production
```

常用 PM2 命令：

```bash
pm2 status
pm2 logs web-collection-api
pm2 restart web-collection-api --update-env
pm2 stop web-collection-api
```

## 🐳 Docker 与 K8s 容器化部署

本项目提供了完整的 **All-in-One 容器化支持**，单容器内打入了 Web 控制台、API 服务、AI 诊断引擎、MCP 协议网关以及内嵌的 PostgreSQL 数据库服务。

### 1. Docker 极速运行 (开箱即用)

在本地或服务器直接运行单容器（内置 PostgreSQL 数据库，零前置配置）：

```bash
# 1. 自动构建本地镜像并打标签
pnpm docker:build

# 2. 运行单容器（映射 8787 端口）
docker run -d -p 8787:8787 --name web-collection web-collection:latest
```

启动后在浏览器访问 `http://localhost:8787` 即可体验全量控制台、AI 诊断与 MCP 网关服务（端点 `http://localhost:8787/mcp`）。

> 💡 **Docker Desktop GUI 用户**：可在 Docker Desktop 中找到 `web-collection:latest` 镜像点击 **Run**，在 `Optional settings` -> `Host port` 输入 `8787` 即可一键启动。

### 2. Docker Compose 自托管部署

使用 Docker Compose 一键启动 API + PostgreSQL 服务组：

```bash
cd deploy/self-hosted
docker compose up -d
```

### 3. Kubernetes (K8s) 集群部署

项目在 `deploy/k8s/` 提供了全套生产级 Kubernetes 清单（Deployment, Service, ConfigMap, Secret, Ingress, Kustomization）：

```bash
# 一键应用全量 K8s 清单
kubectl apply -k deploy/k8s
```

详细操作指南与环境变量配置参见 **[Kubernetes & Docker 部署指南](deploy/k8s/README.md)**。

### GitHub Actions 自托管 Runner 部署

仓库内的 `.github/workflows/deploy.yml` 会在 `main` 分支更新后构建、测试并部署到带有 `web-collection` 标签的 Linux 自托管 Runner。

Runner 主机需预装 Node.js、PM2、curl，并准备部署目录：

```bash
sudo mkdir -p /opt/web-collection/{shared,releases}
sudo chown -R "$USER":"$USER" /opt/web-collection
cp .env /opt/web-collection/shared/.env
npm install -g pm2
```

在 GitHub 仓库的 `Settings > Actions > Runners` 注册 Runner，并添加 `web-collection` 标签。可选仓库变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEPLOY_ROOT` | `/opt/web-collection` | 稳定部署目录 |
| `HEALTH_URL` | `http://127.0.0.1:8787/health` | 发布后的健康检查地址 |

工作流保留最近 5 个版本；新版本启动或健康检查失败时自动切回上一个版本。

### 私有化交付（白标）

```bash
cp deploy/self-hosted/.env.example .env   # 填写 BRAND_* 与数据库配置
./deploy/self-hosted/start.sh
```

- **品牌出厂预置**：改 `.env` 的 `BRAND_NAME` / `BRAND_PRIMARY_COLOR` 等 → 启动即生效（无需进系统）。
- **品牌运行时配置**：进入控制台「系统设置 → 品牌与白标」改后保存 + 刷新即生效，无需重新构建前端。
  优先级：界面保存值 > env `BRAND_*` > 内置默认 `Web Collection` / `#4f46e5`。
- **自定义域名**：控制台域名在 nginx 侧反代（见 `deploy/self-hosted/nginx.conf.example`）并同步 `CORS_ORIGIN`；
  采集域名由接入方 SDK `init({ endpoint: 'https://collect.example.com/api/collect' })` 指定，平台不修改采集协议。
- **Cloudflare Worker 部署**：白标默认关闭，需 `wrangler secret put WHITE_LABEL_ENABLED` 设为 `1`；
  自定义域在 `wrangler.jsonc` 的 `routes[].pattern` 配置。**`/brand.js` 必须在 `assets.run_worker_first` 中**（已在配置内）。

### SourceMap 自动上传

在业务构建完成后执行：

```bash
pnpm sourcemaps:upload -- --dir apps/web/dist --app-id web --release 1.0.0 \
  --endpoint https://monitor.example.com --key "$WEB_COLLECTION_ADMIN_KEY"
```

控制台的“采集治理”页面可以管理应用、版本、事件/回放采样率、数据保留周期、告警阈值、邮件、短信、飞书、企业微信、钉钉、Webhook 渠道及 CSV 报表导出。生产试点步骤见 [docs/production-pilot.md](docs/production-pilot.md)。

### 多渠道告警

渠道密钥在数据库中使用 AES-GCM 加密，`ALERT_SECRET_MASTER_KEY` 只允许通过服务端环境变量或 Worker Secret 配置。启用 QStash 后，告警投递会异步执行并重试 5 次；未配置 QStash 时自动回退为后台直接发送。

Cloudflare 部署需要先执行迁移并配置密钥：

```bash
pnpm exec wrangler d1 migrations apply web-collection --remote
pnpm exec wrangler secret put ALERT_SECRET_MASTER_KEY
pnpm exec wrangler secret put ALERT_PUBLIC_BASE_URL
pnpm exec wrangler secret put QSTASH_TOKEN
pnpm exec wrangler secret put QSTASH_CURRENT_SIGNING_KEY
pnpm exec wrangler secret put QSTASH_NEXT_SIGNING_KEY
```

`ALERT_PUBLIC_BASE_URL` 填写控制台公开地址，例如 `https://monitor.example.com`。旧的 `FEISHU_WEBHOOK_URL` 在没有配置新渠道时继续作为兼容回退。

### 产品分析 V2

Node/PostgreSQL 部署支持事件趋势、用户/会话去重、事件属性过滤与拆分、同会话漏斗、交互式用户路径、保存分析及仪表盘引用。用户统计优先使用 `userId`，缺失时回退 `deviceId`。

Cloudflare Worker 保留原有产品分析能力，控制台会通过 `/api/capabilities` 自动隐藏 V2 入口。

## 🔌 SDK 接入

Web Collection SDK 通过 npm 包 [`@web-collection/sdk`](https://www.npmjs.com/package/@web-collection/sdk) 提供，支持 **NPM、Script（IIFE 无构建）、Vue3 插件、React、小程序 / 跨端 App、React Native 以及 Electron** 等多种接入方式。React Native 与 Electron 适配作为独立包 [`@web-collection/sdk-react-native`](https://www.npmjs.com/package/@web-collection/sdk-react-native) 与 [`@web-collection/sdk-electron`](https://www.npmjs.com/package/@web-collection/sdk-electron) 发布（均为 `0.1.0`，随 `0.5.0` 首发）。

> 安装：`npm install @web-collection/sdk`

完整接入教程、全部配置项与 API 参考请直接查阅 **[SDK 文档（中文）](packages/sdk/README.zh-CN.md)**（[English](packages/sdk/README.md)）。

其余使用说明（控制台功能、部署、告警、SourceMap、产品分析等）见 **[用户手册（中文）](docs/user-manual.zh-CN.md)**（[English](docs/user-manual.md)）。

## 📜 脚本一览

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 安装全部依赖 |
| `pnpm dev` | 启动 API 开发服务，端口 `8787` |
| `pnpm dev:web` | 启动前端控制台开发服务，端口 `5173` |
| `pnpm build` | 构建前端控制台和 SDK，并汇总产物到根目录 `dist/` |
| `pnpm start` | 生产模式启动 API，同时托管前端静态文件 |
| `pnpm test` | 运行测试 |
| `pnpm --filter @web-collection/api db:init` | 初始化 PostgreSQL 表结构 |
| `pnpm --filter @web-collection/sdk build` | 单独构建 SDK |
| `pnpm --filter @web-collection/web build` | 单独构建前端控制台 |


## 🐳 容器化部署

仓库已提供完整容器部署资产：根目录多阶段 `Dockerfile`、`deploy/self-hosted/docker-compose.yml`，以及 `deploy/k8s` Kubernetes 清单。

### Docker 镜像

```bash
docker build -t web-collection:v0.5.0 -t web-collection:latest .
docker run -d --name web-collection --restart unless-stopped \
  -p 8787:8787 \
  -e DATABASE_URL='postgresql://user:pass@db-host:5432/web_collection' \
  -e ADMIN_API_KEY='replace-with-a-strong-secret' \
  -e CORS_ORIGIN='https://monitor.example.com' \
  web-collection:v0.5.0
```

镜像基于 `node:20-alpine` 两阶段构建，构建 Web 控制台与 SDK；运行阶段执行 `node apps/api/src/index.js`，监听 `8787`，并通过 `/health` 做容器健康检查。

首次部署需初始化数据库：

```bash
docker exec web-collection pnpm --filter @web-collection/api db:init
curl http://127.0.0.1:8787/health
```
### Docker Compose（单机私有化推荐）

```bash
cd deploy/self-hosted
docker compose up -d --build
docker compose ps
docker compose logs -f api
```

Compose 会启动 PostgreSQL 16 与 Web Collection，并使用 `pgdata` 命名卷持久化数据库。正式环境必须修改默认数据库密码、`ADMIN_API_KEY`、`CORS_ORIGIN` 及其他密钥；不要原样使用示例配置暴露到公网。除非明确要删除数据库，否则不要执行 `docker compose down -v`。

### Kubernetes

`deploy/k8s` 已提供 `ConfigMap`、`Secret`、`Deployment`、`Service`、`Ingress` 与 `Kustomize`。默认 Deployment 为 2 副本，readiness/liveness 均检查 `/health`。

```bash
docker tag web-collection:latest your-registry.example.com/web-collection:v0.5.0
docker push your-registry.example.com/web-collection:v0.5.0
# 更新 deployment.yaml 镜像、secret.yaml 密钥、ingress.yaml 域名/TLS
kubectl apply -k deploy/k8s
kubectl get pods -l app.kubernetes.io/name=web-collection
kubectl logs -l app.kubernetes.io/name=web-collection --tail=100 -f
```

生产环境不要把真实密钥提交到 `deploy/k8s/secret.yaml`，应使用集群 Secret 管理方案。详细说明见 `deploy/k8s/README.md` 与 `deploy/self-hosted/README.md`。
