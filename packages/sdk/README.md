> English documentation. [中文文档](https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk/README.zh-CN.md)

# Web Collection SDK

## Getting Started

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

`consent` defaults to `granted`; once denied, events are neither queued nor sent. Built-in redaction runs before `beforeSend`; do not restore sensitive data inside the callback.

## Manual Tracking

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

## Behavior Metrics

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

Optional high-noise behaviors are disabled by default:
```js
createEys({ formTracking: true, rageClick: true, deadClick: true, interactionTracking: true })
```

`dead_click` requires adding `data-track-dead-click` to the element; form values and clipboard content are never captured.

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

## Performance Metrics

Collected automatically by default.
| Metric | Meaning | value |
| --- | --- | --- |
| `ttfb` | Time to First Byte | `navigation.responseStart` |
| `fp` | First Paint | `startTime` |
| `fcp` | First Contentful Paint | `startTime` |
| `lcp` | Largest Contentful Paint | `startTime` |
| `fid` | First Input Delay | `processingStart - startTime` |
| `inp` | Interaction to Next Paint | `duration` |
| `cls` | Cumulative Layout Shift | max CLS in the session window |
| `longtask` | Long task | `duration` |
| `resource` | Static resource load time | `duration` |

`resource` props:
| Field | Description |
| --- | --- |
| `name` | Resource URL |
| `initiatorType` | Resource type, e.g. `img/script/css/fetch` |
| `transferSize` | Transfer size |
| `ttfb` | Resource response start time |

Custom performance metric:
```js
const start = performance.now()
await renderReport()
eys.metric('report_render', performance.now() - start, {
  page: 'dashboard'
})
```

## Request Metrics

Enabled by default via `requests: true`; captures `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`.
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
## Error Metrics

Collected automatically by default.
| Error | Trigger | Main props |
| --- | --- | --- |
| `Error` | JS runtime error | `source`, `line`, `column` |
| `ResourceError` | script/link/img resource load failure | `tag`, `elementPath` |
| `UnhandledRejection` | Uncaught Promise exception | `name` |
| `FetchError` | fetch request exception | `source` |
| `WebSocketError` | WebSocket exception | `source`, `readyState` |
| `SseError` | EventSource exception | `source`, `readyState` |

Report errors manually:
```js
try {
  await submit()
} catch (err) {
  eys.error(err, { module: 'order' })
}
```

## Session Replay

Enabled by default via `replay: true`, based on rrweb.
```js
const eys = createEys({
  replay: true,
  replaySegmentByRoute: true,
  replayMaxDuration: 60000,
  replayBatchSize: 50
})
```

| Config | Description |
| --- | --- |
| `replaySegmentByRoute` | End the current recording and start a new one on route change |
| `replayMaxDuration` | Maximum recording duration per segment |
| `replayBatchSize` | Replay event batch upload size |
| `replayOptions` | Pass-through to rrweb `record()` options |

Sensitive areas:
```html
<div class="eys-block">This area will not be recorded</div>
<input class="eys-ignore" />
```

Manual control:
```js
eys.startReplay()
eys.addReplayEvent('checkout_step', { step: 'pay' })
eys.takeReplaySnapshot()
eys.stopReplay()
```

## Common Fields

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

## Queue and Reporting
| Config | Default | Description |
| --- | --- | --- |
| `batchSize` | `10` | Batch size for normal event reporting |
| `flushInterval` | `5000` | Interval for scheduled reporting |
| `maxQueue` | `200` | Max local queue cache |
| `maxRetries` | `3` | Retry count on failure |
| `sampleRate` | `1` | Sample rate |

Manual flush:
```js
eys.flush()
```

## Mini Program and App Integration

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

