# Flutter 桥接契约（E1 独占）

> 本文档定义 **Flutter 宿主** 如何复用 Web Collection 的移动端采集能力。
> **零 Dart 代码**——本文件只描述契约（事件形状、通道、字段口径），具体 Dart/JNI 桥接实现由宿主侧负责。
> 状态标注：**DONE**（已可实现）/ **DEFERRED**（需内核或桥接能力就绪）。

---

## 1. 范围与定位

- 复用对象：`@web-collection/sdk-react-native` 的**事件映射与内核上报链路**（type 白名单、`metric` 口径、batch/retry/consent）。
- 不新增事件 `type`：Flutter 端所有语义同样只能落在 `name` / `metric` / `props`（双栈 sanitize 校验 `apps/api/src/index.js:839` 与 `cloudflare/worker.js:2478`）。
- 目标：Flutter 端产出的事件与 RN 端**逐字段一致**，后端无需区分来源（仅 `platform` 维度不同）。

## 2. 接入形态（DEFERRED）

Flutter 不运行 JS，无法直接使用本 JS 包。两种可选桥接：

1. **MethodChannel → 共享原生模块**：原生侧（Kotlin/Swift）集成 `@web-collection/sdk-react-native`，Flutter 经 `MethodChannel` 把事件 JSON 转发给原生模块，由原生模块调用 `eys.track/metric/behavior/error`。
2. **直接 HTTP**：Flutter 侧自行 POST 到 `/api/collect`，事件体必须与本文档 §4 完全一致（含 `x-app-key` 头）。

本文件以方案 1 为主描述，方案 2 字段相同。

## 3. 初始化参数（DONE）

Flutter 侧需向原生桥接传递：

| 参数 | 类型 | 说明 |
|------|------|------|
| `appId` | string | 应用 ID |
| `release` | string | App 版本（维度下钻主键） |
| `collectKey` | string | 采集密钥（经 `x-app-key` 下发） |
| `endpoint` | string | 默认 `/api/collect` |
| `sessionTimeoutMs` | number | 后台超阈值切分会话，默认 30000 |
| `deviceInfo` | object | `{ brand, model, systemName, systemVersion, appVersion, bundleId }` |

原生模块据此构造 `createReactNativeEys(options, runtime)`，`runtime` 由原生侧提供（fetch / storage / appState / errorUtils / netInfo）。

## 4. 事件字段契约（DONE，逐行对齐 §4）

所有事件基础结构：

```jsonc
{
  "type": "<track|perf|behavior|error|replay|log|trace>",
  "name": "<behavior/error 时必填，≤160>",
  "metric": "<perf 时必填，≤32>",
  "value": "<perf 时数值>",
  "props": { "<≤80 键，每值 ≤1000 字符>" },
  "sessionId": "<由原生桥接维护，经 beforeSend 覆盖>",
  "ts": "<毫秒时间戳>"
}
```

| 语义 | type | metric / name | props 关键字段 |
|------|------|---------------|----------------|
| 冷启动 | perf | `app_cold_start` | `phase`(cold/warm), `appReadyMs`, `markSource`(app-ready/first-frame/timeout) |
| 帧率卡顿 | perf | `frame_stats` | `fps`, `droppedFrames`, `longTaskMs`, `sampleWindowMs`, `fpsTarget` |
| 网络请求 | perf | `fetch` | `url`, `method`, `status`, `statusClass`, `responseSize`, `errorType` |
| JS 崩溃 | error | `name=err.name` | `fatal:true`, `isFatal`, `source`(global/unhandledrejection) |
| 原生崩溃 | error | `name=NativeCrash` | `kind:'native_crash'`, `fatal:true`, `nativeStack`, `fingerprint` |
| 切前台 | behavior | `app_foreground` | `elapsedMs`, `newSession` |
| 切后台 | behavior | `app_background` | `elapsedMs` |
| 会话起点 | behavior | `app_start` | `cold` |
| 页面进入 | behavior | `pv` | `path` |
| 页面离开 | behavior | `page_leave` | `path`, `stayTime` |
| 网络变化 | behavior | `network_change` | `network`(wifi/cellular/none) |
| 业务埋点 | track | `name` | 任意 |

## 5. 会话 ID 覆盖（DONE）

原生桥接自维护 `sessionId`，在 `beforeSend` 最后写入 `item.sessionId`（与 RN 层同契约）。**迁移条件**：内核暴露 `setSessionId` API 后改用内核 API。

## 6. 设备维度（DONE）

经内核 `setContext` 写入（顶层 6 键，≤50 键约束）：

```jsonc
{
  "platform": "flutter",
  "sdk": { "name": "react-native", "version": "<RN 包版本>" },
  "app": { "version": "<release>", "bundleId": "<bundleId>" },
  "os": { "name": "<systemName>", "version": "<systemVersion>" },
  "device": { "brand": "<brand>", "model": "<model>" },
  "network": { "type": "<networkType>" }
}
```

> 注：`platform` 在 Flutter 场景建议由桥接改为 `"flutter"` 以便后端区分；`js` 崩溃通道对 Flutter 不适用（用原生崩溃通道）。

## 7. 崩溃通道（DEFERRED）

- **JS 崩溃**：Flutter/Dart 无 JS 引擎，不适用；忽略。
- **原生崩溃**：复用 `reportNativeCrash(payload)` 占位通道，需 `crash.native=true` 且原生桥接提供 `getPending/clear`。**默认关闭**。

## 8. 网络采集（DEFERRED）

复用内核 `wrapFetch` 产出 `metric=fetch`。Flutter 侧需在原生桥接层包装 `HttpClient` 请求并转发；`autoWrapGlobalFetch` 默认 false（需显式开启）。

## 9. 同意与配额（DONE）

- `consent:'denied'` → 内核清空队列且不再采集（由原生桥接透传）。
- 指标口径与 Web/RN 完全一致，复用服务端 `eventCategory` 分类（fetch → requests）。

## 10. 验收清单（DONE）

- [ ] Flutter 事件经桥接进入内核队列，字段与 §4 逐行一致。
- [ ] `type` 全部命中双栈白名单（无新增 type）。
- [ ] 后台超 `sessionTimeoutMs` 回前台产生新 `app_start` + `app_foreground(newSession:true)`。
- [ ] 原生崩溃仅在 `crash.native=true` 且桥接就绪时上报。
- [ ] `consent:'denied'` 后零事件入队。

---

**状态汇总**：§1–§5、§9–§10 为 DONE（字段与 RN 端一致，可直接实现）；§6 JS 崩溃、§7 原生崩溃通道、§8 网络采集为 DEFERRED（依赖原生桥接与能力开关）。
