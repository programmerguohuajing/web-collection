<div align="center">

🌐 **[中文文档](https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk-react-native/README.zh-CN.md) · [English](https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk-react-native/README.md)**

# 📦 @web-collection/sdk-react-native

> Web Collection 的 React Native SDK：移动端宿主适配层 + 移动端指标采集（冷启动 / 帧率卡顿 / 崩溃 / 前后台会话 / 网络），**100% 复用 `@web-collection/sdk` 平台内核的上报链路**。

<p align="center">
  <a href="https://www.npmjs.com/package/@web-collection/sdk-react-native"><img src="https://img.shields.io/npm/v/@web-collection/sdk-react-native" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@web-collection/sdk-react-native"><img src="https://img.shields.io/npm/dt/%40web-collection%2Fsdk-react-native?label=downloads" alt="npm downloads" /></a>
  <a href="https://github.com/programmerguohuajing/web-collection/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/%40web-collection%2Fsdk-react-native" alt="License" /></a>
  <a href="https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk-react-native/index.d.ts"><img src="https://img.shields.io/badge/types-included-blue" alt="TypeScript" /></a>
</p>

</div>


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

## 🎬 会话回放双模式（复用 Flutter 播放器架构）

针对移动端原生 View 无 DOM 树的特点，SDK 提供了与 Flutter 完全对齐的双模式会话回放方案，生成的数据格式可**在管理端 Web 播放器中直接播放**：

| 方案 | 收集机制 | 性能开销 | 配置开关 | 推荐场景 |
| :--- | :--- | :--- | :--- | :--- |
| **方案二：手势轨迹 (`pointer_event`)** | 拦截 Touch 事件坐标与触控点 | 超轻量（零 CPU 开销，数 KB 流量） | `enablePointerReplay` (**默认 `true`**) | **推荐作为默认方案** |
| **方案一：画面快照 (`canvas_snapshot`)** | 截取 View 画面 Base64 图片分片 | 中度（基于 View 快照，按间隔采集） | `enableSnapshotReplay` (**默认 `false`**) | 精确还原画面现场 |

### 接入示例 (React Native App 根节点)

```jsx
import { EysProvider, EysPointerTouchListener, EysSnapshotBoundary } from '@web-collection/sdk-react-native/react'

export default function App() {
  return (
    <EysProvider options={{ appId: 'your-app-id' }}>
      {/* 方案二（默认推荐）：手势轨迹监听容器 */}
      <EysPointerTouchListener>
        {/* 方案一（可选开启）：画面快照容器 */}
        <EysSnapshotBoundary>
          <YourMainScreen />
        </EysSnapshotBoundary>
      </EysPointerTouchListener>
    </EysProvider>
  )
}
```

## React Hook

```js
import { EysProvider, useTrack, EysPointerTouchListener } from '@web-collection/sdk-react-native/react'
// 见 README.md 英文示例
```


## 构建与测试

```bash
pnpm --filter @web-collection/sdk-react-native build
pnpm --filter @web-collection/sdk-react-native test   # node --test，无需模拟器
```

Flutter 集成契约见 `docs/mobile/flutter-bridge-contract.md`（零 Dart 代码，部分条目标记 DEFERRED）。
