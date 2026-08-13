<div align="center">

🌐 **[English](./README.md) · [中文文档](./README.zh-CN.md)**

# 📦 Web Collection SDK

> Drop-in browser SDK for errors, performance, replay, tracing & behavior.

[![npm version](https://img.shields.io/npm/v/@web-collection/sdk)](https://www.npmjs.com/package/@web-collection/sdk) [![npm downloads](https://img.shields.io/npm/dt/%40web-collection%2Fsdk?label=downloads)](https://www.npmjs.com/package/@web-collection/sdk) [![License](https://img.shields.io/npm/l/%40web-collection%2Fsdk)](https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk/LICENSE) [![TypeScript](https://img.shields.io/badge/types-included-blue)](https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk/index.d.ts)

</div>

**Web Collection SDK** is the browser-side collector that powers the [Web Collection](https://github.com/programmerguohuajing/web-collection) console. It captures errors, performance, session replay, distributed tracing and behavior with a tiny, framework-agnostic core.

## 📑 Table of Contents

- [🚀 Getting Started](#getting-started)
- [🔒 Privacy & Data Protection](#privacy-data-protection)
- [🔗 Distributed Tracing and Call Topology](#distributed-tracing-and-call-topology)
- [🎯 Manual Tracking](#manual-tracking)
- [📊 Behavior Metrics](#behavior-metrics)
- [⚡ Performance Metrics](#performance-metrics)
- [🌐 Request Metrics](#request-metrics)
- [🐛 Error Metrics](#error-metrics)
- [💰 Sampling & Cost Control](#sampling-cost-control)
- [🎬 Session Replay](#session-replay)
- [📋 Common Fields](#common-fields)
- [📡 Queue, Transport & Reporting](#queue-transport-reporting)
- [📱 Mini Program and App Integration](#mini-program-and-app-integration)

## 🚀 Getting Started

```js
import { createEys } from '@web-collection/sdk'

const eys = createEys({
  endpoint: 'https://your-domain.com/api/collect',
  appId: 'mall-web',
  release: '1.0.0',
  userId: '10001',
  userName: 'Zhang San',
  userPhone: '13800000000'
})
```

Set user info after login:
```js
eys.setUser({ id: '10001', name: 'Zhang San', phone: '13800000000' })
```

Mark "page data ready" once the first-screen data has finished rendering:
```js
eys.markPageReady()
```

Disable modules:
```js
createEys({
  behavior: false,
  requests: false,
  exposure: false,
  replay: false
})
```

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

### React Integration

```jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { WebCollectionProvider, ErrorBoundary, useWebCollection } from '@web-collection/sdk/react'
import App from './App'

createRoot(document.getElementById('root')).render(
  <WebCollectionProvider options={{ endpoint: 'https://your-domain.com/api/collect', appId: 'web', release: '1.0.0' }}>
    <ErrorBoundary fallback={<p>Something went wrong.</p>}>
      <App />
    </ErrorBoundary>
  </WebCollectionProvider>
)
```

- `WebCollectionProvider` initializes the SDK once at the app root (in a `useEffect`, client-only — so it is SSR-safe for Next.js). It injects the instance through React Context.
- `ErrorBoundary` catches React render errors in its subtree and reports them automatically via `eys.error`. React has no global error hook like Vue's `app.config.errorHandler`, so render errors must be caught by an Error Boundary. Provide `fallback` for the fallback UI, or pass `eys` to use an instance created elsewhere.
- `useWebCollection()` returns the SDK instance from Context (returns `null` until initialization completes; use it inside event handlers / effects, not during the first render).

```jsx
function CheckoutButton() {
  const eys = useWebCollection()
  return <button onClick={() => eys?.track('checkout_clicked', { plan: 'pro' })}>Checkout</button>
}
```

React Router page views and route changes are collected automatically — the SDK hooks `history.pushState` / `replaceState` and `popstate` / `hashchange`, so no extra setup is required. Requires React 16.8+.

Enabling `console: true` captures `console.log/info/warn/error` and keeps the latest 20 console breadcrumbs (up to 500 characters each), used for search and reconstructing error context. This is disabled by default to avoid accidentally capturing sensitive data in application logs; use `consoleLevels` to limit the captured levels.

You can also record structured logs proactively:

```js
eys.log('info', 'order submitted', { orderId: 'SO10001' })
```

Request tracing is enabled by default; same-origin Fetch/XHR requests carry the standard `traceparent`. Cross-origin services must be explicitly added to a trusted list:

```js
createEys({
  collectKey: 'eys_xxx',
  traceOrigins: ['https://api.example.com']
})
```

TypeScript projects can import types directly:
```ts
import { createEys, type EysClient, type EysOptions } from '@web-collection/sdk'

const options: EysOptions = {
  endpoint: 'https://your-domain.com/api/collect',
  appId: 'mall-web',
  release: '1.0.0'
}

const eys: EysClient = createEys(options)
eys.track('submit_order', { orderId: 'SO202607100001' })
```

Collection governance and context:
```js
const eys = createEys({
  environment: 'production',
  consent: 'granted',
  categorySampleRates: { behavior: 0.5, replay: 0.1 },
  privacy: { redactKeys: ['orderToken'], requestAllowlist: ['https://api.example.com'] },
  beforeSend(event) {
    return event.context?.debug ? false : event
  }
})

eys.setContext({ module: 'checkout' })
eys.addBreadcrumb('checkout_started', { source: 'cart' })
eys.setConsent('denied')
eys.setEnabled(false)
```

`consent` defaults to `granted`; once denied, events are neither queued nor sent. Built-in redaction runs before `beforeSend`; do not restore sensitive data inside the callback. Device environment fingerprinting is on by default (`environmentInfo: true`); runtime version enrichment is off by default (`runtimeInfo: false`) — enable it to attach runtime/SDK versions to context.

## 🔒 Privacy & Data Protection

The SDK minimizes collected sensitive data by default. A unified sanitizer (`privacy.mode`) runs on every event **before** it is queued and **again after** `beforeSend`, so sensitive values are never transmitted even if a custom hook re-introduces them.

| Mode | Behavior | Use |
| --- | --- | --- |
| `off` | No privacy protection beyond the legacy `redactKeys` field redaction | Explicitly disabled, trusted internal networks |
| `balanced` (**default**) | Field-key redaction + value-level PII redaction + irreversible phone hash + sensitive URL-query stripping + header dropping + body sanitization | Production default, minimal collection |
| `strict` | Like `balanced`, plus: entire URL query dropped (hash kept), `<select>` keeps only index/count (no label hash) | Strong-compliance scenarios |

What `balanced` does automatically:

- **Field-key redaction**: keys matching `password`/`token`/`secret`/`authorization`/`cookie`/`apikey`… are replaced with `[REDACTED]`.
- **Value-level PII redaction**: emails, mainland-China phone numbers, ID cards (18-digit), bank cards (16–19 digit) and JWTs are redacted on string leaf values.
- **Irreversible user-phone hash**: under `balanced`/`strict`, `userPhone` becomes an `h_*` alias (FNV-1a + length); the server cannot reverse it.
- **Header dropping**: `Authorization`/`Cookie`/`Set-Cookie`/`Proxy-Authorization` are removed by default; extend via `dropHeaders`.
- **URL query stripping**: sensitive params (`token`/`code`/`phone`/`idcard`…) are stripped; `strict` drops the entire query.
- **Request/response body sanitization**: JSON bodies are recursively field-redacted, text bodies are PII-redacted; provide `requestResponseSanitizer` for custom rules.

```js
createEys({
  privacy: {
    mode: 'balanced',                 // default; can be declared explicitly
    redactKeys: ['mySecret'],         // merged onto the default sensitive-key list
    dropHeaders: ['x-api-secret'],
    textRedaction: true,              // default on
    consentCategories: { replay: true }, // explicit grant overrides GPC/DNT
    requestResponseSanitizer: (pair) => ({ ...pair, requestBody: 'REDACTED' })
  }
})
```

**Consent & GPC/DNT.** `consent` defaults to `granted`; when denied, only `essential` is collected. If the browser sends **GPC** (`navigator.globalPrivacyControl === true`) or **DNT** (`navigator.doNotTrack` in `1/yes/true`), un-granted `analytics`/`replay`/`diagnostics` categories are downgraded to denied. Inspect with `getPrivacyMode()` and `getConsentCategories()`.

Replay masking still honors `.eys-block` (never recorded) and `.eys-ignore` (input not recorded) in the DOM.

## 🔗 Distributed Tracing and Call Topology

The SDK can correlate page performance, Fetch and XHR events into one distributed call tree. The topology is not drawn in the SDK itself: the SDK reports `traceId`, `spanId` and `parentSpanId`, then the monitoring console groups nodes with the same `traceId` and connects each child to its parent.

### Quick start

```js
const eys = createEys({
  endpoint: 'https://monitor.example.com/api/collect',
  appId: 'checkout-web',
  release: '1.2.0',

  // Capture Fetch/XHR timing and status.
  requests: true,

  // Add trace IDs and inject traceparent into trusted requests.
  tracing: true,

  // Create the page root span and hierarchical request spans.
  distributedTracing: true,

  // Same-origin requests are trusted automatically. List every trusted
  // cross-origin API with its exact scheme, host and port.
  traceOrigins: [
    'https://api.example.com',
    'https://payment.example.com'
  ],

  // Static, non-sensitive business context propagated as the standard W3C `baggage` header.
  // Never put passwords, tokens, cookies, phone numbers or other secrets here.
  baggage: {
    tenant: 'shop',
    region: 'cn-east'
  },

  // Global SDK/session sampling rate. Use a lower value in high-volume production.
  sampleRate: 0.2
})
```

All tracing switches default to enabled. A complete automatic request topology requires `requests`, `tracing` and `distributedTracing` to remain enabled together.

| Option | Default | Purpose |
| --- | --- | --- |
| `requests` | `true` | Captures Fetch/XHR duration, method, status and failures. Disable it to stop automatic request nodes. |
| `tracing` | `true` | Adds trace identifiers to request metrics and injects `traceparent` into trusted requests. |
| `distributedTracing` | `true` | Creates a page root span and hierarchical child spans so `parentSpanId` relationships can be reconstructed. |
| `traceOrigins` | `[]` | Trusted cross-origin origins allowed to receive tracing headers, as exact strings, `RegExp`, or a `(origin) => boolean` matcher. Same-origin requests are always allowed. |
| `baggage` | `{}` | Static, non-sensitive business context forwarded as the single standard W3C `baggage` header. |
| `sampleRate` | `1` | Global session sampling rate from `0` to `1`; a session that is not sampled returns a no-op client. |
| `categorySampleRates` | `{}` | Optional per-category sampling override. It also contributes to tracing sample flags where applicable. |
| `spanExport` | `false` | When enabled, root/auto-request/custom Spans are exported in batches via the Processor/Exporter to `/api/spans` (0.2.0-beta can default on together with sampling). |

### How the topology is formed

With the settings above, the browser side produces a hierarchy similar to:

```text
page (root span)
├─ navigation performance
├─ fetch https://api.example.com/orders
│  └─ order-api server span
│     └─ database or downstream service span
└─ xhr https://payment.example.com/pay
   └─ payment-api server span
```

The IDs have distinct responsibilities:

| Field | Meaning |
| --- | --- |
| `traceId` | Shared by every node in the same end-to-end call. |
| `spanId` | Identifies one operation, such as the page, one Fetch/XHR request or one server operation. |
| `parentSpanId` | Points to the caller's `spanId` and creates the parent/child edge. |
| `traceFlags` | Carries the sampling decision in the W3C `traceparent` header. |

The SDK automatically creates the page root context and request child spans. To continue the tree beyond the browser, every backend service must:

1. Read the incoming W3C `traceparent` header.
2. Keep the incoming `traceId`.
3. Create a new server `spanId` and use the incoming `spanId` as its `parentSpanId`.
4. Forward the updated `traceparent` to downstream services.
5. Send its server-side spans to the same monitoring backend.

If a service generates a new `traceId`, drops `parentSpanId`, or does not report its span, the console can only display the browser node or a disconnected branch.

### Cross-origin and CORS requirements

Tracing headers are injected only when the target is same-origin or its exact origin appears in `traceOrigins`. Do not add wildcard or untrusted origins: tracing and baggage headers may reveal internal correlation metadata.

Cross-origin APIs must allow the headers during CORS preflight. Configure the server or gateway to allow at least `traceparent` and the `baggage` header. If the service returns `traceparent` or `traceresponse`, expose those response headers when the browser needs to read them.

```http
Access-Control-Allow-Headers: Content-Type, Authorization, traceparent, baggage
Access-Control-Expose-Headers: traceparent, traceresponse
```

Changing `traceOrigins` does not bypass `privacy.requestAllowlist`. A request must satisfy both the privacy allowlist and tracing-origin rules before the SDK injects tracing headers.

### Viewing and troubleshooting the distributed tree

Open the trace detail in the monitoring console and select the **Distributed Trace Tree** tab. A valid non-empty tree requires reported nodes with matching `traceId` values and valid `spanId`/`parentSpanId` relationships.

If the page shows summary counters but no topology, check the following in order:

1. `requests`, `tracing` and `distributedTracing` are not set to `false`.
2. `sampleRate` is greater than `0`, and the current session was sampled.
3. The request is not the SDK's own collection endpoint.
4. `privacy.requestAllowlist` permits the request URL when an allowlist is configured.
5. Cross-origin URLs use an exact `traceOrigins` match, including scheme and port.
6. Browser DevTools shows a valid `traceparent` request header in the form `00-<traceId>-<spanId>-<flags>`.
7. CORS allows the tracing and baggage headers.
8. Backend services preserve the incoming `traceId`, create a new `spanId`, retain `parentSpanId`, and report their spans.
9. The console is filtered to the correct application, release and time range.

For production traffic, start with a conservative `sampleRate`, monitor ingestion volume, and increase it only when the storage and query budgets allow. Keep `baggage` small and non-sensitive because it is sent with every traced request.

## 🎯 Manual Tracking

```js
eys.track('submit_order', {
  orderId: 'SO202607100001',
  amount: 99
})
```

Stored fields:
| Field | Description |
| --- | --- |
| `type` | `track` |
| `name` | Custom event name |
| `props` | Custom business parameters |

## 📊 Behavior Metrics

Enabled by default via `behavior: true`.
| Metric | Trigger | Main props |
| --- | --- | --- |
| `pv` | Page view after SDK init | `referrer` |
| `page_leave` | When the page is hidden | `stayTime` |
| `click` | Click on `data-track/button/a/input/textarea/select/[role=button]` | `elementLabel`, `elementType`, `elementId`, `elementText`, `elementHref` |
| `scroll` | About 500ms after scrolling stops | `depth`, `maxDepth` |
| `pushState` | SPA calls `history.pushState` | `from`, `to` |
| `replaceState` | SPA calls `history.replaceState` | `from`, `to` |
| `popstate` | Browser forward/back navigation | `from`, `to` |
| `hashchange` | Hash route change | `from`, `to` |
| `exposure` | Element enters viewport at 50% and stays ~1s | element `tag/id/className/text/data-track-*` |

Optional behaviors are disabled by default:
```js
createEys({
  formTracking: true,       // form submit / field focus-blur
  rageClick: true,          // rapid repeated clicks
  deadClick: true,          // click with no effect (needs data-track-dead-click)
  interactionTracking: true, // generic interaction events
  selectTracking: true,     // <select> option changes
  inputTracking: true,      // input focus / blur / change
  keyboardTracking: true,   // key presses (Enter / Escape by default)
  touchTracking: true       // touch start / end
})
```

Form values and clipboard content are never captured. `dead_click` requires `data-track-dead-click` on the element. `keyboardTrackingKeys` (default `['Enter', 'Escape']`) controls which keys are recorded when `keyboardTracking` is on.

Business transaction:
```js
const transaction = eys.startTransaction('checkout', { page: 'order' })
transaction.setData({ step: 'pay' })
transaction.finish({ status: 'success' })
```

Exposure usage:
```html
<section data-track-exposure data-track-name="home_banner">
  ...
</section>
```

Add business attributes to clickable elements:

```html
<button data-track data-track-action="save">Save</button>
```

## ⚡ Performance Metrics

Collected automatically by default. Every metric carries the [common fields](#common-fields) plus its own `props`. Metrics are grouped below.

### Page load & render

| Metric | Meaning | `value` source |
| --- | --- | --- |
| `navigation` | Full Navigation Timing breakdown | `nav.duration` |
| `ttfb` | Time to First Byte | `navigation.responseStart` |
| `fp` | First Paint | `startTime` |
| `fcp` | First Contentful Paint | `startTime` |
| `first_screen` | First-screen complete (= LCP timestamp) | `lcpEntry.startTime` |
| `data_ready` | Business data ready — emitted by `markPageReady()` | `performance.now()` |
| `js_boot` | SDK init → first paint latency | `now − sdkStartedAt` |
| `lcp` | Largest Contentful Paint | `startTime` |
| `tti` | Time to Interactive (long-task estimate) | estimate |
| `tbt` | Total Blocking Time (Σ durations > 50 ms) | accumulated |

`navigation` props: `dns`, `tcp`, `tls`, `request`, `download`, `ttfb`, `dom_ready`, `page_load`, `redirect`, `redirect_count`.

### Interaction, stability & health

| Metric | Meaning |
| --- | --- |
| `fid` | First Input Delay |
| `inp` | Interaction to Next Paint |
| `cls` | Cumulative Layout Shift (session-window max) |
| `longtask` | Long task (> 50 ms) with attribution (`name`, `attribution[]`) |
| `white_screen` | Blank-screen detection latency — time until content appears |
| `blank_screen_rate` | Blank-screen rate — `0` once content renders, `100` if `whiteScreenTimeout` exceeded |
| `memory` | JS heap snapshot (`usedJSHeapSize`/`totalJSHeapSize`/`jsHeapSizeLimit`), sampled every `memoryInterval` |
| `resource_failure_rate` | Resource load failure rate (`0` / `100`) |
| `cache_hit_rate` | Cache hit rate (`100` when `transferSize === 0 && decodedBodySize > 0`) |
| `route_render` | SPA route render latency (between route changes) |
| `service_worker_*` | Service Worker lifecycle state (`installing`/`activated`/…) |

White-screen detection is always on; tune it with `whiteScreenSelector` (default `'#app > *'`) and `whiteScreenTimeout` (default `5000` ms). `memory` requires Chrome's `performance.memory` and is sampled every `memoryInterval` (default `60000` ms); set `memoryInterval: 0` to disable periodic sampling.

### Resource & bundle

| Metric | Meaning | Key `props` |
| --- | --- | --- |
| `resource` | Static resource load time | `name`, `initiatorType`, `transferSize`, `ttfb` |
| `bundle_summary` | JS/CSS bundle size summary at unload (enable `bundleMonitoring: true`) | `jsTotalBytes`, `cssTotalBytes`, `jsCount`, `cssCount`, `chunks[]` |
| `fetch_body` / `xhr_body` | Sampled request/response body (enable `requestBodySampling > 0`) | request/response body (sanitized) |

Server-Timing from fetch/XHR responses is parsed and attached to the corresponding `fetch`/`xhr` metric `props` (W3C Server-Timing).

Custom performance metric:
```js
const start = performance.now()
await renderReport()
eys.metric('report_render', performance.now() - start, {
  page: 'dashboard'
})
```

## 🌐 Request Metrics

Enabled by default via `requests: true`; captures `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`. Enable request/response body sampling with `requestBodySampling: <0..1>` (default `0`); sampled bodies are emitted as `fetch_body` / `xhr_body` and always pass through the privacy sanitizer.
### Fetch

```js
await fetch('/api/orders')
```

| Field | Description |
| --- | --- |
| `metric` | `fetch` |
| `value` | Request duration |
| `props.url` | Request URL |
| `props.method` | HTTP method |
| `props.status` | Status code |
| `props.ok` | Whether 2xx |

`FetchError` is reported on failure.
### XHR

```js
const xhr = new XMLHttpRequest()
xhr.open('GET', '/api/profile')
xhr.send()
```

| Field | Description |
| --- | --- |
| `metric` | `xhr` |
| `value` | Request duration |
| `props.url` | Request URL |
| `props.method` | HTTP method |
| `props.status` | Status code |

### WebSocket

```js
const ws = new WebSocket('wss://example.com/socket')
ws.send(JSON.stringify({ type: 'ping' }))
```

| Phase | Description |
| --- | --- |
| `phase: open` | Connection setup time |
| `phase: close` | Connection duration, close code, message count, byte count |

`WebSocketError` is reported on failure.
### SSE

```js
const source = new EventSource('/api/stream')
source.addEventListener('message', event => {
  console.log(event.data)
})
```

| Phase | Description |
| --- | --- |
| `phase: open` | Connection setup time |
| `phase: close` | Connection duration, message count, byte count |

`SseError` is reported on failure.
## 🐛 Error Metrics

Collected automatically by default.
| Error | Trigger | Main props |
| --- | --- | --- |
| `Error` | JS runtime error | `source`, `line`, `column` |
| `ResourceError` | script/link/img resource load failure | `tag`, `elementPath` |
| `UnhandledRejection` | Uncaught Promise exception | `name` |
| `FetchError` | fetch request exception | `source` |
| `WebSocketError` | WebSocket exception | `source`, `readyState` |
| `SseError` | EventSource exception | `source`, `readyState` |

Web Worker errors and Service Worker lifecycle can be monitored with `workerMonitoring: true` and `serviceWorkerMonitoring: true` (both off by default).

Report errors manually:
```js
try {
  await submit()
} catch (err) {
  eys.error(err, { module: 'order' })
}
```

## 💰 Sampling & Cost Control

Sampling is **deterministic** and **explainable**: the same `traceId` or `sessionId` always yields the same keep/drop decision, so a distributed trace is never split across the keep/drop boundary and error-linked data is never lost to sampling.

| Option | Default | Purpose |
| --- | --- | --- |
| `sampleRate` | `1` | Base session/global sampling rate (`0`–`1`) |
| `traceRate` | `= sampleRate` | Trace (`traceId`)-level base rate |
| `categorySampleRates` | `{}` | Per-category rates (`error`/`performance`/`requests`/`behavior`/`exposure`/`replay`); narrows session-level only, never breaks a trace |
| `errorSampleRate` | unset | Deterministic sub-sampling of error links/events; unset ⇒ errors always retained |

Key guarantees:

- **Same ID, same decision**: `rate=1` always keeps, `rate=0` always drops, intermediate values are stable per key.
- **Errors are always retained by default**: an error marks its `traceId` as priority, so the error and its associated request spans are kept even when `sampleRate` is low. Set `errorSampleRate` only if you must cap error volume.
- **Explainable**: dropped events emit `onDiagnostic('dropped_by_sampling')` with `rule`/`rate`/`unit`/`key`; `getSamplingDecision()` returns the most recent decision.

```js
const eys = createEys({
  sampleRate: 0.2,
  categorySampleRates: { behavior: 0.5, replay: 0.1 }
})
// Inspect the latest sampling decision while debugging:
console.log(eys.getSamplingDecision())
```

## 🎬 Session Replay

Session Replay records the user's DOM via rrweb so you can replay the steps leading to an error. It is **opt-in by cost**: rrweb is **not** bundled into the core package. When `replay: false` (the default is `true`), neither the ESM nor the base IIFE build downloads, parses or compiles rrweb. When `replay: true`, rrweb is loaded on demand — ESM splits it into a separate `rrweb-*.js` chunk; the IIFE build expects rrweb to be provided externally via `window.rrweb` (or `replayLibUrl`).

```js
const eys = createEys({
  replay: true,
  replaySegmentByRoute: true,   // start a new segment on SPA route change
  replayMaxDuration: 60000,     // max recording per segment
  replayBufferSize: 1500,       // ring-buffer capacity (events)
  replayWindowMs: 30000,        // retention window — the 30s before an error
  replayCompression: true       // gzip (Worker → main thread → none fallback)
})
```

### Cost & performance controls (SDK-209 / SDK-210)

| Option | Default | Purpose |
| --- | --- | --- |
| `replay` | `true` | Enable replay; `false` ⇒ no rrweb download at all |
| `replayMaxDuration` | `60000` | Max recording duration per segment (ms); a new segment starts on route change or when this is exceeded |
| `replayLibUrl` | `''` | IIFE self-hosting: external rrweb script that exposes `window.rrweb` |
| `replayWorkerUrl` | `''` | Compression Worker URL; when set, gzip runs off the main thread |
| `replayCompression` | `true` | gzip the replay payload (`none` fallback if no `CompressionStream`) |
| `replayBufferSize` | `1500` | Ring-buffer capacity; bounds resident memory on long sessions |
| `replayWindowMs` | `30000` | Retention window; guarantees the 30s before an error is recoverable |
| `replayBatchSize` | `50` | Incremental-flush page size |

- **Bounded memory**: events live in a ring buffer (capacity + time window). Old events are evicted lazily; `replay_buffer_full` warns when the window is compressed.
- **Compression**: gzip in a Worker (preferred), else main-thread `CompressionStream`, else base64 UTF-8. `replay_compressed` reports payload bytes; `replay_worker_unavailable` warns once on fallback.

### Error-triggered up-sampling & quality (SDK-214)

| Option | Default | Purpose |
| --- | --- | --- |
| `replaySampleRate` | `1` | Steady-state incremental sampling rate to cut cost (`<1` drops high-frequency events) |
| `replayErrorTrigger` | `true` | On error, switch to full sampling and extend the retention window |
| `replayWindowMsError` | `60000` | Retention window during error boost (2× the steady-state `replayWindowMs`) |
| `replayPageSize` | `50` | Forced-flush page size; large segments are split into pages (`page`/`pageCount`) |
| `replayCanvas` | `false` | Opt-in Canvas recording (passes rrweb `recordCanvas`; full fidelity needs the `@rrweb/rrweb-plugin-canvas` plugin in `replayOptions.plugins`) |
| `replayIframe` | `false` | Opt-in cross-origin iframe recording (`recordCrossOriginIframes` + `inlineIframes`) |

When an error occurs, the SDK boosts replay to **full sampling** and extends the retention window to `replayWindowMsError` (default 60s), emitting `replay_error_triggered` so the console can prioritize that session. Canvas/iframe recording are **off by default** to avoid needless overhead — enable explicitly only where needed.

Replay quality is observable via `replay_quality` (buffered, evictedTotal ≈ dropped frames, sampledDrops, pages, compression, sampleRate, errorBoosted) and `replay_recorder_error` (internal rrweb errors, message truncated, no PII).

### Manual control

```js
await eys.startReplay()                       // async, fire-and-forget safe
eys.addReplayEvent('checkout_step', { step: 'pay' })
eys.takeReplaySnapshot()
await eys.stopReplay()                        // async
await eys.flushReplay(true)                   // force-flush the pre-error window
```

`startReplay`/`stopReplay`/`flushReplay` are async but do **not** require `await` (calls are queued, never dropped). If `destroy()` races an in-flight load, recording stops immediately to avoid leaks.

### Sensitive areas

```html
<div class="eys-block">This area will not be recorded</div>
<input class="eys-ignore" />
```

## 📋 Common Fields

Every event carries:
| Field | Description |
| --- | --- |
| `sdkVersion` | SDK version |
| `environment` | Runtime environment, e.g. production/test |
| `source` | `auto`, `manual` or `platform` |
| `context` | Redacted global/event context |
| `appId` | Application identifier |
| `release` | Release version |
| `userId/userName/userPhone` | User info |
| `sessionId` | Session ID |
| `deviceId` | Device ID |
| `traceId/spanId` | Request and business trace identifiers (optional) |
| `url/path/title/referrer` | Page info |
| `userAgent` | Browser UA |
| `ts` | Event timestamp |

## 📡 Queue, Transport & Reporting

Events are buffered in a memory **hot queue** that is mirrored to an **IndexedDB cold queue**, so they survive page refresh, crashes and offline periods and are recovered on the next session (`next_session_recovered` diagnostic). When the tab is hidden or the page is unloading, a **Beacon** exit channel flushes remaining events (UTF-8 byte-sliced, non-destructive — the server deduplicates by `eventId`).

| Config | Default | Description |
| --- | --- | --- |
| `batchSize` | `10` | Batch size for normal event reporting (also the per-transport-batch cap) |
| `flushInterval` | `60000` | Interval for scheduled reporting (ms) |
| `maxQueue` | `200` | Max local queue cache (oldest dropped + `queue_full` when exceeded) |
| `maxRetries` | `3` | Online-send retry attempts before permanent drop |
| `transportTimeout` | `10000` | Per online-send timeout (ms) |
| `beaconMaxBytes` | `61440` | Beacon per-batch UTF-8 byte cap |
| `sampleRate` | `1` | Session/global sampling rate (see Sampling & Cost Control) |
| `onDiagnostic` | `null` | Health-event callback (see Diagnostics) |

Sending is reliable: exponential backoff with equal jitter, `Retry-After` honored, `408/425/429/5xx` retried while `4xx` payload errors are dropped permanently. A cross-tab lock ensures at most one tab per origin actively sends.

Manual flush:
```js
eys.flush()
```

## 🩺 Diagnostics (`onDiagnostic`)

Pass `onDiagnostic` to observe non-sensitive SDK health events. The callback never throws and never carries business PII, so it is safe to leave enabled in production for monitoring transport and replay cost:

```js
createEys({
  onDiagnostic: (e) => {
    if (e.type === 'queue_full') console.warn('local queue overflow', e)
    if (e.type === 'replay_buffer_full') console.warn('replay window compressed', e)
  }
})
```

Transport events: `queue_full`, `rate_limited`, `timeout`, `invalid_payload`, `storage_quota`, `dropped_by_sampling`, `beacon_rejected`, `beacon_oversize`, `beacon_fallback`, `next_session_recovered`, `dropped_non_retryable`, `flush_success`, `flush_failed`, `retry`.

Replay events: `replay_buffer_full`, `replay_worker_unavailable`, `replay_compressed`, `replay_error_triggered`, `replay_recorder_error`, `replay_quality`.

## 📱 Mini Program and App Integration

For non-Web runtimes, use the standalone entry `@web-collection/sdk/platform`, which does not load DOM, rrweb, `window` or `localStorage`. The same build artifact can also be imported via the `miniapp`, `uni-app`, `taro` and `react-native` subpaths.

### WeChat, Alipay, Douyin and other Mini Programs

The SDK automatically detects `wx`, `my`, `tt`, `swan`, `qq`, `ks` and `jd`. Create the instance in `app.js` and wrap the original config with `instrumentApp` and `instrumentPage`:

```js
import { createMiniProgramEys } from '@web-collection/sdk/miniapp'

export const eys = createMiniProgramEys({
  endpoint: 'https://monitor.example.com/api/collect',
  appId: 'mall-miniapp',
  release: '1.0.0'
})

App(eys.instrumentApp({
  onLaunch() {}
}))

Page(eys.instrumentPage({
  onLoad() {},
  submitOrder() {
    eys.track('submit_order')
  }
}))

const request = eys.wrapRequest(wx.request.bind(wx))
request({ url: 'https://api.example.com/orders' })
```

Pass `my` for the Alipay mini program and `tt` for the Douyin mini program; for other compatible mini programs, explicitly pass the corresponding global API:

```js
const eys = createMiniProgramEys(options, my)
```

### uni-app

```ts
import { createUniAppEys } from '@web-collection/sdk/uni-app'

export const eys = createUniAppEys({
  endpoint: 'https://monitor.example.com/api/collect',
  appId: 'mall-uni-app',
  release: '1.0.0'
}, uni)

export const request = eys.wrapRequest(uni.request.bind(uni))

// Record page lifecycle in onShow/onHide
eys.pageView('/pages/order/list')
eys.pageLeave('/pages/order/list', 3200)
```

### Taro

```ts
import Taro from '@tarojs/taro'
import { createTaroEys } from '@web-collection/sdk/taro'

export const eys = createTaroEys({
  endpoint: 'https://monitor.example.com/api/collect',
  appId: 'mall-taro',
  release: '1.0.0'
}, Taro)

export const request = eys.wrapRequest(Taro.request.bind(Taro))
```

### React Native

The React Native persistence queue requires the project's existing AsyncStorage instance; the SDK does not force an additional storage dependency:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createReactNativeEys } from '@web-collection/sdk/react-native'

export const eys = createReactNativeEys({
  endpoint: 'https://monitor.example.com/api/collect',
  appId: 'mall-rn',
  release: '1.0.0'
}, {
  storage: AsyncStorage,
  getContext: () => ({ path: navigationRef.getCurrentRoute()?.name || '' })
})

global.fetch = eys.wrapFetch(global.fetch)
```

Cross-platform clients uniformly support `track`, `behavior`, `metric`, `error`, `pageView`, `pageLeave`, `setUser`, batch queue, retry on failure and persistence. Mini programs and native apps have no browser DOM, so rrweb screen recording is not provided; page traces, clicks and business operations should be reported via lifecycle hooks and `track`.

The platform side also supports `setConsent`, `setEnabled`, `setContext`, `addBreadcrumb` and `startTransaction`. Using `instrumentApp` records app launch, foreground/background switches and preserves the original lifecycle callbacks.

