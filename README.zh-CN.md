<div align="center">

🌐 **[中文文档](./README.zh-CN.md) · [English](./README.md)**

# 🛰️ Web Collection

> 前端监控、会话回放与产品分析 —— 一个 SDK，一个控制台。

[![GitHub stars](https://img.shields.io/github/stars/programmerguohuajing/web-collection?style=social)](https://github.com/programmerguohuajing/web-collection) [![npm downloads](https://img.shields.io/npm/dm/@web-collection/sdk)](https://www.npmjs.com/package/@web-collection/sdk) [![npm version](https://img.shields.io/npm/v/@web-collection/sdk)](https://www.npmjs.com/package/@web-collection/sdk) [![Live Demo](https://img.shields.io/badge/demo-online-brightgreen)](https://web-collection.jingguohua.cc.cd/overview) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

Web Collection 是 **pnpm monorepo** 前端监控系统：Vue 3 + Element Plus 控制台、Node API 服务与浏览器 SDK。用控制台定位 **错误、性能、回放、链路与埋点** 问题。

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

## 📑 目录

- [🚀 快速开始](#快速开始)
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

Web Collection SDK 通过 npm 包 [`@web-collection/sdk`](https://www.npmjs.com/package/@web-collection/sdk) 提供，支持 **NPM、Script（IIFE 无构建）、Vue3 插件、React 以及小程序 / 跨端 App** 等多种接入方式。

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

