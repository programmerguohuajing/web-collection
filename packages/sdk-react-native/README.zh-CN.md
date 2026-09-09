# @web-collection/sdk-react-native

Web Collection 的 React Native SDK：移动端宿主适配层 + 移动端指标采集（冷启动 / 帧率卡顿 / 崩溃 / 前后台会话 / 网络），**100% 复用 `@web-collection/sdk` 平台内核的上报链路**。

> 本包是对 Web SDK 平台内核的**扩展而非替换**：只新增 RN 宿主适配器与 RN 专属采集模块；入库、分批、重试、采样、同意门控全部由内核完成。

## 环境要求

- `@web-collection/sdk` >= 0.4.0（peer）
- `react-native` >= 0.72.0（peer，可选）
- `react` >= 16.8.0（peer，可选）
- `@react-native-async-storage/async-storage` >= 1.17.0（peer，可选）
- `@react-native-community/netinfo` >= 9.0.0（peer，可选）

所有宿主模块均经 `runtime` 注入，不进依赖图，因此运行时 `dependencies` 恒为空。

## 最小接入（5 行）

```js
import { createReactNativeEys } from '@web-collection/sdk-react-native'

const eys = createReactNativeEys(
  { appId: 'your-app-id', release: '1.0.0' },
  { fetch, storage: AsyncStorage, appState: AppState }
)
eys.start()
```

## 完整接入（存储 + 生命周期 + 崩溃 + wrapFetch）

```js
import { createReactNativeEys } from '@web-collection/sdk-react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState, ErrorUtils } from 'react-native'
import NetInfo from '@react-native-community/netinfo'

const eys = createReactNativeEys(
  { appId: 'your-app-id', release: '1.0.0', onDiagnostic: (e) => console.warn('[eys]', e.name, e) },
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
eys.markAppReady()                 // 显式校正冷启动终点
const wrappedFetch = eys.wrapFetch(myFetch)  // 复用内核 perf/fetch 口径
```

## 采集指标

| 语义 | type | metric / name | 分类 |
|------|------|---------------|------|
| 冷启动 | `perf` | `app_cold_start` | performance |
| 帧率卡顿 | `perf` | `frame_stats` | performance |
| 网络请求 | `perf` | `fetch`（复用内核 `wrapFetch`） | requests |
| JS 崩溃 / 未处理 | `error` | `name = err.name` | error |
| 原生崩溃（占位） | `error` | `NativeCrash` | error |
| 切前台 | `behavior` | `app_foreground` | behavior |
| 切后台 | `behavior` | `app_background` | behavior |
| 会话起点 | `behavior` | `app_start` | behavior |
| 页面进入 | `behavior` | `pv` | behavior |
| 页面离开 | `behavior` | `page_leave` | behavior |
| 网络类型变化 | `behavior` | `network_change` | behavior |

**硬约束**

- 不新增事件 `type`，全部复用内核封闭白名单（`track/perf/behavior/error/...`），移动端语义 100% 落在 `name` / `metric` / `props`。
- **仅 JS 崩溃**。原生崩溃（`reportNativeCrash`）为占位通道，**默认关闭**（`crash.native: false`），仅在宿主桥接就绪后显式开启。
- RN 适配器绝不向宿主抛异常：所有公开 API 与采集回调均失效安全（未捕获异常会令宿主 App 红屏）。

## React Hook

```js
import { EysProvider, useTrack } from '@web-collection/sdk-react-native/react'
// 见 README.md 英文示例
```

## 构建与测试

```bash
pnpm --filter @web-collection/sdk-react-native build
pnpm --filter @web-collection/sdk-react-native test   # node --test，无需模拟器
```

Flutter 集成契约见 `docs/mobile/flutter-bridge-contract.md`（零 Dart 代码，部分条目标记 DEFERRED）。
