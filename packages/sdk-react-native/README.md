<div align="center">

🌐 **[English](./README.md) · [中文文档](./README.zh-CN.md)**

# 📦 @web-collection/sdk-react-native

> React Native SDK for [Web Collection](https://github.com/programmerhuohuajing/web-collection): a mobile host adapter layer + mobile metrics collection (cold start / frame jank / crash / foreground-background session / network), reusing **100% of the `@web-collection/sdk` platform kernel's reporting pipeline**.

[![npm version](https://img.shields.io/npm/v/@web-collection/sdk-react-native)](https://www.npmjs.com/package/@web-collection/sdk-react-native) [![npm downloads](https://img.shields.io/npm/dt/%40web-collection%2Fsdk-react-native?label=downloads)](https://www.npmjs.com/package/@web-collection/sdk-react-native) [![License](https://img.shields.io/npm/l/%40web-collection%2Fsdk-react-native)](https://github.com/programmerguohuajing/web-collection/blob/main/LICENSE) [![TypeScript](https://img.shields.io/badge/types-included-blue)](https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk-react-native/index.d.ts)

</div>


> This package is an **extension, not a replacement** of the Web SDK platform kernel. It only adds the RN host adapter and RN-specific collection modules; ingestion, batching, retry, sampling, and consent are all handled by the kernel.

## Requirements

- `@web-collection/sdk` >= 0.4.0 (peer)
- `react-native` >= 0.72.0 (peer, optional)
- `react` >= 16.8.0 (peer, optional)
- `@react-native-async-storage/async-storage` >= 1.17.0 (peer, optional)
- `@react-native-community/netinfo` >= 9.0.0 (peer, optional)

All host modules are injected via `runtime` — none are pulled into the dependency graph, so the runtime `dependencies` is always empty.

## Minimal setup (5 lines)

```js
import { createReactNativeEys } from '@web-collection/sdk-react-native'

const eys = createReactNativeEys(
  { appId: 'your-app-id', release: '1.0.0' },
  { fetch, storage: AsyncStorage, appState: AppState }
)
eys.start()
```

## Full setup (storage + lifecycle + crash + wrapFetch)

```js
import { createReactNativeEys } from '@web-collection/sdk-react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState, ErrorUtils } from 'react-native'
import NetInfo from '@react-native-community/netinfo'

const eys = createReactNativeEys(
  {
    appId: 'your-app-id',
    release: '1.0.0',
    onDiagnostic: (e) => console.warn('[eys]', e.name, e)
  },
  {
    fetch: globalThis.fetch,
    storage: AsyncStorage,
    appState: AppState,
    errorUtils: ErrorUtils,
    netInfo: NetInfo,
    deviceInfo: { brand: 'Apple', model: 'iPhone', systemName: 'iOS', systemVersion: '17.0' }
  }
)

eys.start()
// 显式校正冷启动终点（优先于首帧 / 超时兜底）
eys.markAppReady()
// 可选：包装业务 fetch，复用内核 perf/fetch 口径
const wrappedFetch = eys.wrapFetch(myFetch)
```

## Collected metrics

| Semantic | type | metric / name | Category |
|----------|------|---------------|----------|
| Cold start | `perf` | `app_cold_start` | performance |
| Frame jank | `perf` | `frame_stats` | performance |
| Network request | `perf` | `fetch` (reuses kernel `wrapFetch`) | requests |
| JS crash / unhandled | `error` | `name = err.name` | error |
| Native crash (placeholder) | `error` | `NativeCrash` | error |
| Foreground | `behavior` | `app_foreground` | behavior |
| Background | `behavior` | `app_background` | behavior |
| App start / session | `behavior` | `app_start` | behavior |
| Screen view | `behavior` | `pv` | behavior |
| Screen leave | `behavior` | `page_leave` | behavior |
| Network type change | `behavior` | `network_change` | behavior |

**Hard constraints**

- No new event `type` is introduced — all metrics reuse the kernel's closed whitelist (`track/perf/behavior/error/...`). Mobile semantics live entirely in `name` / `metric` / `props`.
- **JS crash only.** Native crash (`reportNativeCrash`) is a placeholder channel, **off by default** (`crash.native: false`); enable it only after a native bridge is wired.
- The RN adapter never throws to the host: all public APIs and collection callbacks are failure-safe (an unhandled exception would otherwise crash the host app).

## React Hook

```js
import { EysProvider, useTrack, useWebCollection } from '@web-collection/sdk-react-native/react'

function App() {
  return (
    <EysProvider options={{ appId: 'your-app-id' }} runtime={{ fetch, storage: AsyncStorage, appState: AppState }}>
      <Checkout />
    </EysProvider>
  )
}

function Checkout() {
  const track = useTrack()
  return <Button onPress={() => track('checkout', { sku: 'A1' })}>Pay</Button>
}
```

## Build & test

```bash
pnpm --filter @web-collection/sdk-react-native build   # dist/sdk-react-native.js(.cjs) + .react.js(.cjs)
pnpm --filter @web-collection/sdk-react-native test    # node --test (no emulator required)
```

See `docs/mobile/flutter-bridge-contract.md` for the Flutter integration contract (zero Dart code; some items marked DEFERRED).
