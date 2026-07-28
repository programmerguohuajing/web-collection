> English documentation. [中文文档](./README.zh-CN.md)

# Web Collection

[![GitHub stars](https://img.shields.io/github/stars/programmerguohuajing/web-collection?style=social)](https://github.com/programmerguohuajing/web-collection)
[![npm downloads](https://img.shields.io/npm/dm/@web-collection/sdk)](https://www.npmjs.com/package/@web-collection/sdk)
[![npm version](https://img.shields.io/npm/v/@web-collection/sdk)](https://www.npmjs.com/package/@web-collection/sdk)
[![Live Demo](https://img.shields.io/badge/demo-online-brightgreen)](https://web-collection.jingguohua.cc.cd/overview)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Web Collection is a pnpm monorepo frontend monitoring system, consisting of a Vue3 + Element Plus web console, a Node API service, and a browser SDK.

Use the console to locate errors, performance, replays, traces and custom-tracking issues. See the [User Manual](docs/user-manual.md).

## Table of Contents

- `apps/web`: frontend monitoring console
- `apps/api`: Node backend service
- `packages/sdk`: browser monitoring SDK
- `packages/sdk/src/error`: JS, Promise and resource error collection
- `packages/sdk/src/performance`: performance collection, including `fetch.js`, `xhr.js`, `websocket.js`, `sse.js`
- `packages/sdk/src/behavior`: PV, click, route, dwell time and scroll behavior collection
- `packages/sdk/src/exposure`: element exposure collection
- `packages/sdk/src/replay`: rrweb session replay collection

## Quick Start

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

## SDK Integration

### NPM Integration

```js
import { createEys } from '@web-collection/sdk'

const eys = createEys({
  endpoint: 'https://your-domain.com/api/collect',
  appId: 'web',
  release: '1.0.0',
  userId: 'u_10001',
  userName: 'Zhang San',
  userPhone: '13800138000'
})

eys.setUser({ id: 'u_10002', name: 'Li Si', phone: '13900139000' })
```

The SDK is published on npm: [@web-collection/sdk](https://www.npmjs.com/package/@web-collection/sdk). See the [SDK documentation](packages/sdk/README.md) for the full API reference (also available in [中文](packages/sdk/README.zh-CN.md)).

### Script Integration

```html
<script src="https://your-domain.com/sdk/web-collection-sdk.iife.js"></script>
<script>
  window.WebCollection.createEys({
    endpoint: 'https://your-domain.com/api/collect',
    appId: 'web',
    release: '1.0.0'
  })
</script>
```

### Vue3 Plugin Integration

```js
import { createApp } from 'vue'
import WebCollection from '@web-collection/sdk'
import App from './App.vue'

createApp(App).use(WebCollection, {
  endpoint: 'https://your-domain.com/api/collect',
  appId: 'web',
  release: '1.0.0'
}).mount('#app')
```

## Capabilities

### Behavior Tracking

Automatically collects PV, clicks, route changes, page dwell time and scroll depth.

```html
<button data-track data-track-name="buy_click" data-track-sku="A001">
  Buy
</button>
```

```js
eys.track('checkout_submit', {
  sku: 'A001',
  amount: 199
})
```

Disable behavior collection:

```js
createEys({ behavior: false })
```

### Error Monitoring

Automatically collects JS errors, unhandled Promise exceptions, and image/CSS/JS resource load failures. The Vue plugin mode additionally hooks into `app.config.errorHandler`.

```js
try {
  await submitOrder()
} catch (err) {
  eys.error(err, {
    source: 'checkout',
    orderId: 'O10001'
  })
}
```

Error events carry the latest behavior breadcrumbs, making it easy to replay the user's action path in the backend.

### Performance Monitoring

Automatically collects FCP, LCP, FID, INP, CLS, TTFB, longtask and resource.

```js
const start = performance.now()
await renderReport()
eys.metric('report_render', performance.now() - start, {
  page: 'dashboard'
})
```

### Fetch / XHR / WebSocket / SSE

The SDK hijacks the browser-native `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource` to collect interface duration, status code, success status, connection setup time and connection duration. The reporting endpoint itself is automatically filtered to avoid loop reporting.

```js
await fetch('/api/orders')

const xhr = new XMLHttpRequest()
xhr.open('GET', '/api/profile')
xhr.send()

const ws = new WebSocket('wss://example.com/socket')
const source = new EventSource('/api/stream')
```

Disable request collection:

```js
createEys({ requests: false })
```

### Exposure Collection

An element is reported as an exposure once it enters the viewport at 50% and stays for about 1 second.

```html
<section data-track-exposure data-track-name="home_banner" data-track-banner-id="B001">
  ...
</section>
```

Disable exposure collection:

```js
createEys({ exposure: false })
```

### rrweb Replay

rrweb session recording is enabled by default; form inputs are redacted. On each SPA route change the current recording is stopped and a new one starts after entering the new page; a single page records for up to 60 seconds by default to avoid generating large replay data from long stays.

```html
<div class="eys-block">Sensitive area that will not be recorded</div>
<input class="eys-ignore" />
```

```js
const eys = createEys({ replay: false })

eys.startReplay()
eys.addReplayEvent('checkout_step', { step: 'pay' })
eys.takeReplaySnapshot()
eys.stopReplay()
```

Custom rrweb options:

```js
createEys({
  replayMaxDuration: 60000,
  replayOptions: {
    checkoutEveryNms: 30000,
    recordCanvas: true,
    blockSelector: '.privacy',
    ignoreSelector: '.no-record'
  }
})
```

Disable replay:

```js
createEys({ replay: false })
```

## SourceMap

The backend console can upload SourceMaps, or you can call the API:

```bash
curl -X POST http://127.0.0.1:8787/api/sourcemaps \
  -H "x-api-key: dev-admin-key" \
  -H "content-type: application/json" \
  -d '{"release":"1.0.0","file":"app.js","map":{}}'
```

The `app.js:line:column` in the error stack is automatically resolved back to the source location by the same `release + file`.

## Full Configuration

```js
createEys({
  endpoint: 'https://your-domain.com/api/collect',
  appId: 'web',
  release: '1.0.0',
  userId: '',
  userName: '',
  userPhone: '',
  batchSize: 10,
  flushInterval: 5000,
  maxQueue: 200,
  maxRetries: 3,
  sampleRate: 1,
  behavior: true,
  console: true,
  consoleLevels: ['log', 'info', 'warn', 'error'],
  collectKey: '',
  tracing: true,
  traceOrigins: [],
  requests: true,
  exposure: true,
  replay: true,
  replaySegmentByRoute: true,
  replayMaxDuration: 60000,
  replayBatchSize: 50,
  replayOptions: {},
  // The first valid content node of the homepage, used to compute white-screen time and white-screen rate
  whiteScreenSelector: '#app > *',
  // If no valid content appears within this time, it is recorded as a white screen
  whiteScreenTimeout: 5000
})
```

After the homepage's key data has finished rendering, you can proactively mark the "page data ready" time:

```js
const eys = createEys({
  endpoint: '/api/collect',
  appId: 'web'
})

await loadHomeData()
eys.markPageReady()
```

## Script Reference

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

