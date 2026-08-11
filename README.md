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
- `packages/sdk/src/performance`: performance collection, including `fetch.js`, `xhr.js`, `websocket.js`, `sse.js`, `tti.js`, `memory.js`, `bundle.js`, `body-sampler.js`, `server-timing.js`
- `packages/sdk/src/behavior`: PV, click, input, keyboard, touch, route, scroll, form, rage-click, dead-click, copy/paste/download
- `packages/sdk/src/exposure`: element exposure collection
- `packages/sdk/src/replay`: rrweb session replay collection
- `packages/sdk/src/error`: JS, Promise, resource, and Web Worker error collection
- `packages/sdk/src/runtime`: Service Worker state monitoring
- `packages/sdk/src/utils/environment.js`: device & environment fingerprint
- `packages/sdk/src/utils/runtime.js`: build-time runtime info

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

### Advanced Behavior Tracking (opt-in)

```js
createEys({
  formTracking: true,       // form submit events
  rageClick: true,          // 3+ clicks on same element within 1s
  deadClick: true,          // click on elements with data-track-dead-click
  interactionTracking: true, // copy, paste, download events
  inputTracking: true,      // input focus/blur/change events
  selectTracking: true,     // <select> change events
  keyboardTracking: true,   // Enter/Escape key events
  touchTracking: true       // touch tap/swipe on mobile
})
```

### Environment Fingerprint (enabled by default)

`environmentInfo: true` attaches screen, viewport, language, timezone, platform, network (connection type, effective type, downlink, RTT), battery status and feature support flags to every event's `context`.

### Runtime Info

```js
// Auto-detect window.__WEB_COLLECTION_VERSION__ etc.
createEys({ runtimeInfo: true })

// Or pass manually:
createEys({ runtimeInfo: { buildId: 'abc123', buildTime: '2025-01-01', commit: 'def456', branch: 'main' } })
```

### Memory Monitoring (Chrome)

```js
createEys({ memoryMonitoring: true, memoryInterval: 60000 })
```

Reports `performance.memory` (usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit) on page hide and periodically.

### Bundle Size Monitoring

```js
createEys({ bundleMonitoring: true })
```

Reports aggregated JS/CSS bundle sizes (decodedBodySize) on page hide.

### Request/Response Body Sampling

```js
createEys({ requestBodySampling: 0.1 }) // 10% of successful requests + all errors
```

Appends truncated request/response bodies to fetch/xhr metric events. Binary responses are skipped. Content is still redacted by the privacy pipeline.

### Server-Timing Collection

Automatically parses `Server-Timing` response headers and appends them to fetch/xhr metric events as `serverTiming` arrays.

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

Session Replay records the user's DOM via rrweb to replay the steps leading to an error. It is **opt-in by cost**: rrweb is **not** bundled into the core package. When `replay: false` (default `true`), neither the ESM nor the base IIFE build downloads, parses or compiles rrweb. When `replay: true`, rrweb is loaded on demand (ESM splits it into a separate `rrweb-*.js` chunk; the IIFE build expects it via `window.rrweb` or `replayLibUrl`). Form inputs are redacted; `.eys-block` is never recorded and `.eys-ignore` inputs are skipped. On each SPA route change the current recording stops and a new one starts; a single segment records for up to `replayMaxDuration` (default 60s).

```html
<div class="eys-block">Sensitive area that will not be recorded</div>
<input class="eys-ignore" />
```

```js
const eys = createEys({
  replay: true,
  replayBufferSize: 1500,    // ring-buffer capacity (bounded memory)
  replayWindowMs: 30000,     // 30s before an error is always recoverable
  replayCompression: true    // gzip (Worker → main thread → none fallback)
})
```

On error, replay auto **boosts to full sampling** and extends the retention window to `replayWindowMsError` (default 60s), emitting `replay_error_triggered` so the console prioritizes that session. Canvas/iframe recording are **off by default** (`replayCanvas` / `replayIframe`).

Manual control (async, fire-and-forget safe):

```js
await eys.startReplay()
eys.addReplayEvent('checkout_step', { step: 'pay' })
eys.takeReplaySnapshot()
await eys.stopReplay()
```

Disable replay:

```js
createEys({ replay: false })   // no rrweb download at all
```

Custom rrweb options (e.g. Canvas plugin, masking):

```js
createEys({
  replayMaxDuration: 60000,
  replayCanvas: true,          // must enable before recordCanvas takes effect
  replayOptions: {
    checkoutEveryNms: 30000,
    blockSelector: '.privacy',
    ignoreSelector: '.no-record'
    // full Canvas fidelity needs @rrweb/rrweb-plugin-canvas in replayOptions.plugins
  }
})
```

### Web Worker Error Monitoring

```js
createEys({ workerMonitoring: true })
```

Captures runtime errors and message errors from Web Workers.

### Service Worker Monitoring

```js
createEys({ serviceWorkerMonitoring: true })
```

Reports `service_worker_registered`, `service_worker_updated`, and `service_worker_error` events.

## Console Pages

The web console includes the following pages:

| Page | Description |
| --- | --- |
| **Overview** | Error count, affected users, P95 load time, active sessions, health score, trend chart, activity feed |
| **Errors** | Issue list with status workflow (open → acknowledged → resolved), error event details, source map resolution |
| **Performance** | Web Vitals cards (FCP/LCP/FID/INP/CLS/TBT), slow API, slow resources, performance event stream |
| **Behavior** | Behavior ranking panel, behavior/tracking event detail table |
| **Replays** | rrweb-player replay panel, session list |
| **Logs** | Structured log table with level filtering, trace link |
| **Traces** | Trace list with span detail drawer |
| **Analytics** | Event trends, user sessions, user paths, funnel analysis, custom dashboards |
| **Alerts** | Alert rule list, trigger records, processing status, notification channels, alert trend chart |
| **Live** | Real-time event stream via WebSocket with polling fallback |
| **Sessions** | User session list with drawer timeline showing full event history per session |
| **Releases** | Version list, version comparison (errors, affected users, LCP), rollback recommendations |
| **SourceMap** | SourceMap upload and management |
| **Governance** | Application management, release management, alert channels, collection key rotation, data retention, CSV export |

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
  replayBufferSize: 1500,     // ring-buffer capacity (bounded memory)
  replayWindowMs: 30000,      // retention window — 30s before an error
  replayCompression: true,    // gzip payload (none fallback)
  replayWorkerUrl: '',        // off-main-thread gzip worker
  replayLibUrl: '',           // IIFE self-hosting: external rrweb script
  replayPageSize: 50,         // forced-flush page size (pagination)
  replaySampleRate: 1,        // steady-state incremental sampling
  replayErrorTrigger: true,   // on error → full sampling + longer window
  replayWindowMsError: 60000, // error-boost retention window
  replayCanvas: false,        // opt-in Canvas recording
  replayIframe: false,        // opt-in cross-origin iframe recording
  replayOptions: {},
  // The first valid content node of the homepage, used to compute white-screen time and white-screen rate
  whiteScreenSelector: '#app > *',
  // If no valid content appears within this time, it is recorded as a white screen
  whiteScreenTimeout: 5000,
  // Reliable transport (IndexedDB cold queue + Beacon exit channel)
  maxBatch: 50,
  transportTimeout: 10000,
  beaconMaxBytes: 61440,
  onDiagnostic: null,
  // Deterministic sampling (same ID → same decision; errors always retained)
  traceRate: null,            // = sampleRate when null
  categorySampleRates: {},
  errorSampleRate: null,      // unset ⇒ errors always retained
  // Privacy (default balanced: PII redaction + irreversible phone hash)
  privacy: { mode: 'balanced' },
  // Advanced behavior options (all default false / opt-in)
  formTracking: false,
  rageClick: false,
  deadClick: false,
  interactionTracking: false,
  inputTracking: false,
  selectTracking: false,
  keyboardTracking: false,
  keyboardTrackingKeys: ['Enter', 'Escape'],
  touchTracking: false,
  // Environment fingerprint (default true)
  environmentInfo: true,
  // Runtime build info (default false)
  runtimeInfo: false,
  // Memory monitoring (Chrome only, default false)
  memoryInterval: 60000,
  // Request/response body sampling (0-1, default 0 = off)
  requestBodySampling: 0,
  // Bundle size monitoring (default false)
  bundleMonitoring: false,
  // Web Worker error monitoring (default false)
  workerMonitoring: false,
  // Service Worker state monitoring (default false)
  serviceWorkerMonitoring: false
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

