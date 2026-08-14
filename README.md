<div align="center">

🌐 **[English](./README.md) · [中文文档](./README.zh-CN.md)**

# 🛰️ Web Collection

> Frontend monitoring, session replay & product analytics — one SDK, one console.

[![GitHub stars](https://img.shields.io/github/stars/programmerguohuajing/web-collection?style=social)](https://github.com/programmerguohuajing/web-collection) [![npm downloads](https://img.shields.io/npm/dm/@web-collection/sdk)](https://www.npmjs.com/package/@web-collection/sdk) [![npm version](https://img.shields.io/npm/v/@web-collection/sdk)](https://www.npmjs.com/package/@web-collection/sdk) [![Live Demo](https://img.shields.io/badge/demo-online-brightgreen)](https://web-collection.jingguohua.cc.cd/overview) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

Web Collection is a **pnpm monorepo** frontend monitoring system: a Vue 3 + Element Plus web console, a Node API service, and a browser SDK. Use the console to locate **errors, performance, replays, traces and custom-tracking** issues.

👉 [Read the User Manual](docs/user-manual.md)

<table>
  <tr>
    <td align="center">🐛<br><b>Error Monitoring</b><br>JS · Promise · Resource · Worker</td>
    <td align="center">⚡<br><b>Performance</b><br>Web Vitals · Long Tasks</td>
    <td align="center">🎬<br><b>Session Replay</b><br>rrweb · Canvas · iframe</td>
  </tr>
  <tr>
    <td align="center">🔗<br><b>Distributed Tracing</b><br>traceparent · Topology</td>
    <td align="center">📊<br><b>Behavior & Exposure</b><br>PV · Click · Funnel</td>
    <td align="center">🔒<br><b>Privacy & Governance</b><br>Sampling · Redaction</td>
  </tr>
</table>

## 📑 Table of Contents

- [🚀 Quick Start](#quick-start)
- [🔌 SDK Integration](#sdk-integration)
- [📚 Documentation](#documentation)
- [📂 Project Structure](#project-structure)
- [📜 Script Reference](#script-reference)

## 📚 Documentation

This README is a **project introduction** only. For usage and integration details, see:

- **[User Manual (中文)](docs/user-manual.zh-CN.md)** ([English](docs/user-manual.md)): console features, deployment, alerts, SourceMap, product analytics, and more.
- **[SDK Documentation (中文)](packages/sdk/README.zh-CN.md)** ([English](packages/sdk/README.md)): SDK integration, all capabilities, configuration options, and the API reference.

## 📂 Project Structure

- `apps/web`: frontend monitoring console
- `apps/api`: Node backend service
- `packages/sdk`: browser monitoring SDK
- `packages/sdk/src/error`: JS, Promise and resource error collection
- `packages/sdk/src/performance`: performance collection, including `fetch.js`, `xhr.js`, `websocket.js`, `sse.js`, `tti.js`, `memory.js`, `bundle.js`, `body-sampler.js`, `server-timing.js`
- `packages/sdk/src/behavior`: PV, click, input, keyboard, touch, route, scroll, form, rage-click, dead-click, copy/paste/download
- `packages/sdk/src/exposure`: element exposure collection
- `packages/sdk/src/replay`: rrweb session replay collection
- `packages/sdk/src/error`: JS, Promise, resource, and Web Worker error collection
- `packages/sdk/src/runtime`: Service Worker state monitoring
- `packages/sdk/src/utils/environment.js`: device & environment fingerprint
- `packages/sdk/src/utils/runtime.js`: build-time runtime info

## 🚀 Quick Start

### Requirements

- Node.js >= 18
- pnpm >= 10
- PostgreSQL >= 12

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Create a `.env` file in the project root, or configure via system environment variables:

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

You can also split the PostgreSQL config:

```bash
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=postgres
DB_NAME=web_collection
```

Windows PowerShell example:

```powershell
$env:ADMIN_API_KEY="change-me"
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/web_collection"
```

### 3. Initialize the database

```bash
pnpm --filter @web-collection/api db:init
```

This creates the tables needed for events, errors, replays, SourceMaps, app versions, collection policies and alert auditing.

### 4. Development mode

Development mode requires running both the API service and the frontend console.

Terminal 1: Start the API service (default port `8787`):

```bash
pnpm dev
```

Terminal 2: Start the frontend console (default port `5173`):

```bash
pnpm dev:web
```

Open `http://127.0.0.1:5173` or `http://your-lan-ip:5173`, enter the `ADMIN_API_KEY` and view the data. Vite listens on `0.0.0.0` by default, so other devices on the LAN can also access it.

### 5. Production mode

First build the frontend console and the SDK:

```bash
pnpm build
```

Build artifacts:

- Frontend console: `apps/web/dist`
- SDK: `packages/sdk/dist`
- Unified artifact directory: `dist/`

The API service hosts both the web console and the SDK:

- Console: `http://127.0.0.1:8787/`
- IIFE SDK: `http://127.0.0.1:8787/sdk/web-collection-sdk.iife.js`
- ES Module SDK: `http://127.0.0.1:8787/sdk/web-collection-sdk.es.js`
- Compatibility entry: `http://127.0.0.1:8787/web-collection-sdk.iife.js`
- Compatibility entry: `http://127.0.0.1:8787/web-collection-sdk.es.js`

Start the production service:

```bash
pnpm --filter @web-collection/api start
```

Equivalent to:

```bash
pm2 start ecosystem.config.cjs --only web-collection-api --env production
```

Common PM2 commands:

```bash
pm2 status
pm2 logs web-collection-api
pm2 restart web-collection-api --update-env
pm2 stop web-collection-api
```

### GitHub Actions self-hosted Runner deployment

The in-repo `.github/workflows/deploy.yml` builds, tests and deploys to a Linux self-hosted Runner tagged `web-collection` whenever the `main` branch is updated.

The runner host must have Node.js, PM2 and curl pre-installed, and a deployment directory prepared:

```bash
sudo mkdir -p /opt/web-collection/{shared,releases}
sudo chown -R "$USER":"$USER" /opt/web-collection
cp .env /opt/web-collection/shared/.env
npm install -g pm2
```

Register the Runner in `Settings > Actions > Runners` of the GitHub repo and add the `web-collection` tag. Optional repo variables:

| Variable | Default | Description |
| --- | --- | --- |
| `DEPLOY_ROOT` | `/opt/web-collection` | Stable deployment directory |
| `HEALTH_URL` | `http://127.0.0.1:8787/health` | Health check URL after release |

The workflow keeps the last 5 releases; if a new release fails to start or health check, it automatically rolls back to the previous one.

### SourceMap auto-upload

After your application build completes, run:

```bash
pnpm sourcemaps:upload -- --dir apps/web/dist --app-id web --release 1.0.0 \
  --endpoint https://monitor.example.com --key "$WEB_COLLECTION_ADMIN_KEY"
```

The console's "Collection Governance" page manages applications, versions, event/replay sample rates, data retention period, alert thresholds, email, SMS, Feishu, WeCom (Enterprise WeChat), DingTalk, Webhook channels and CSV report export. See [docs/production-pilot.md](docs/production-pilot.md) for the production pilot steps.

### Multi-channel alerts

Channel secrets are AES-GCM encrypted in the database; `ALERT_SECRET_MASTER_KEY` may only be configured via a server-side environment variable or Worker Secret. When QStash is enabled, alert delivery runs asynchronously and retries up to 5 times; without QStash it automatically falls back to direct background delivery.

Cloudflare deployment requires running the migration and configuring secrets first:

```bash
pnpm exec wrangler d1 migrations apply web-collection --remote
pnpm exec wrangler secret put ALERT_SECRET_MASTER_KEY
pnpm exec wrangler secret put ALERT_PUBLIC_BASE_URL
pnpm exec wrangler secret put QSTASH_TOKEN
pnpm exec wrangler secret put QSTASH_CURRENT_SIGNING_KEY
pnpm exec wrangler secret put QSTASH_NEXT_SIGNING_KEY
```

`ALERT_PUBLIC_BASE_URL` is the public console address, e.g. `https://monitor.example.com`. The old `FEISHU_WEBHOOK_URL` continues to work as a compatible fallback when the new channels are not configured.

### Product Analytics V2

The Node/PostgreSQL deployment supports event trends, user/session de-duplication, event property filtering and breakdown, same-session funnels, interactive user paths, saved analyses and dashboard references. User statistics prefer `userId`, falling back to `deviceId` when missing.

The Cloudflare Worker retains the original product analytics capability; the console automatically hides the V2 entry via `/api/capabilities`.

## 🔌 SDK Integration

The Web Collection SDK is published as the [`@web-collection/sdk`](https://www.npmjs.com/package/@web-collection/sdk) npm package and supports **NPM, Script (IIFE, no build), the Vue3 plugin, React, and Mini Program / cross-platform App** integrations.

> Install: `npm install @web-collection/sdk`

For the full integration tutorial, all configuration options, and the API reference, see the **[SDK documentation](packages/sdk/README.md)** (also in [中文](packages/sdk/README.zh-CN.md)).

## 📜 Script Reference

| Command | Description |
| --- | --- |
| `pnpm install` | Install all dependencies |
| `pnpm dev` | Start the API dev service on port `8787` |
| `pnpm dev:web` | Start the frontend console dev service on port `5173` |
| `pnpm build` | Build the frontend console and SDK, and aggregate artifacts into the root `dist/` |
| `pnpm start` | Start the API in production mode, also hosting the frontend static files |
| `pnpm test` | Run tests |
| `pnpm --filter @web-collection/api db:init` | Initialize the PostgreSQL table structure |
| `pnpm --filter @web-collection/sdk build` | Build the SDK only |
| `pnpm --filter @web-collection/web build` | Build the frontend console only |

