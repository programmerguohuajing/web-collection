# Web Collection 能力扩展开发规划

> 本文档面向 SDK 和 Web 平台的后续迭代，列出当前缺失的采集能力与平台功能，并按优先级、模块、接口设计和验收标准给出可执行方案。

---

## 目录

- [1. 总体原则](#1-总体原则)
- [2. SDK 端能力扩展](#2-sdk-端能力扩展)
  - [2.1 性能监控增强](#21-性能监控增强)
  - [2.2 环境信息采集](#22-环境信息采集)
  - [2.3 网络请求增强](#23-网络请求增强)
  - [2.4 细粒度行为采集](#24-细粒度行为采集)
  - [2.5 运行时能力增强](#25-运行时能力增强)
- [3. Web 平台端能力扩展](#3-web-平台端能力扩展)
  - [3.1 告警中心页面](#31-告警中心页面)
  - [3.2 实时监控页面](#32-实时监控页面)
  - [3.3 用户会话页面](#33-用户会话页面)
  - [3.4 发布管理页面](#34-发布管理页面)
  - [3.5 可视化分析增强](#35-可视化分析增强)
- [4. 优先级与里程碑](#4-优先级与里程碑)
- [5. 附录：现有模块开发规范](#5-附录现有模块开发规范)

---

## 1. 总体原则

### 1.1 采集原则

- 所有新模块遵循现有 `setupXxxMonitor(opts)` → 返回 `dispose()` 的模块注册模式
- 新采集能力默认**不开启**，通过配置项显式启用
- 所有事件经过统一 `push()` 管线：采样 → `beforeSend` → 脱敏 → 去重 → 入队 → 批量上报
- SDK bundle 增量控制在合理范围内，避免引入大型依赖

### 1.2 平台原则

- 新增页面遵循现有 Vue 3 + Element Plus + Pinia 的技术栈
- 数据查询复用 `apps/api/src/` 中的 repository/service 层
- 新增 API 端点统一挂载到 `apps/api/src/index.js`

### 1.3 类型定义

- 所有新配置项同步更新 `packages/sdk/index.d.ts`
- 新增事件类型统一注册到 `EventType` 联合类型

---

## 2. SDK 端能力扩展

### 2.1 性能监控增强

#### 2.1.1 TTI（Time to Interactive，可交互时间）

**现状**：当前 SDK 已采集 LCP、INP、TBT，但缺少 TTI。

**目标**：通过 `PerformanceObserver` + `longtask` 推算 TTI，作为页面可交互时间的补充指标。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/performance/tti.js` |
| 依赖 | 无（纯 PerformanceObserver） |
| 配置项 | 无独立开关，默认在 `setupPerformanceMonitor` 中集成 |
| 上报时机 | 页面隐藏 / 卸载时 finalize |
| 事件名 | `tti` |
| Props | `{ value, cpuBusyTime, method }` |

**实现逻辑**：

1. 持续监听 `longtask` 条目，记录主线程阻塞时间
2. 在页面卸载时，查找最后一个 Web Vitals 中较早的指标作为参考起点
3. 估算方式：LCP 时间点之后，若连续 5s 内无超过 50ms 的 longtask，且 FID/INP 已完成，则 TTI ≈ LCP + 后续阻塞时间
4. 如浏览器不支持 `longtask`，降级为记录但不上报

**最终化逻辑**（在 `setupPerformanceMonitor` 返回的 cleanup 中）：

```js
// 在 finalizePerformance 中追加
if (ttiValue !== null) metric('tti', ttiValue, { method: 'longtask-estimate' })
```

**验收标准**：

- [ ] 在性能事件流中能看到 `tti` 事件
- [ ] TTI 值 ≥ LCP（理论上可交互时间不会早于最大内容绘制）
- [ ] 长任务密集的页面 TTI 明显高于正常页面

---

#### 2.1.2 Bundle 大小监控

**现状**：当前 SDK 只采集 resource 的 `transferSize` / `decodedBodySize`，缺少构建产物的 bundle 级别分析。

**目标**：在 `resource` 事件基础上，增加 bundle 维度的聚合信息，帮助发现构建产物过大导致的性能回归。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/performance/bundle.js` |
| 依赖 | 无 |
| 配置项 | `bundleMonitoring: boolean`，默认 `false` |
| 上报时机 | 页面隐藏 / 卸载时批量上报 |
| 事件名 | `bundle_summary` |

**实现逻辑**：

1. 监听 `resource` 条目，按 `initiatorType` 过滤 `script` / `link`（stylesheet）
2. 将同源的 JS 文件按包名聚合（从 URL 中提取 chunk 命名规律）
3. 在 finalize 时上报聚合结果

**Props**：

```js
{
  jsTotalBytes: number,         // 所有 JS 资源 decodedBodySize 总和
  cssTotalBytes: number,        // 所有 CSS 资源 decodedBodySize 总和
  jsCount: number,              // JS 资源数量
  cssCount: number,             // CSS 资源数量
  chunks: [{ name, size, type }] // 按 chunk 名聚合（可选，采样上报）
}
```

**配置项（`EysOptions`）**：

```ts
bundleMonitoring?: boolean    // 默认 false
```

**验收标准**：

- [ ] 开启后在性能事件流中能看到 `bundle_summary` 事件
- [ ] JS + CSS 总量与实际 Network 面板数据一致
- [ ] 关闭时不产生 bundle 相关事件，不增加额外开销

---

#### 2.1.3 内存使用监控

**现状**：当前无内存指标采集。

**目标**：采集 Chrome 提供的 `performance.memory` 数据，监控 JS 堆内存使用情况。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/performance/memory.js` |
| 依赖 | 无 |
| 配置项 | `memoryMonitoring: boolean`，默认 `false` |
| 上报时机 | 页面隐藏 / 卸载时 + 周期性采样（60s） |
| 事件名 | `memory` |

**实现逻辑**：

1. 检测 `performance.memory` 是否存在（Chrome 专有 API）
2. 不支持时静默跳过，不报错
3. 页面卸载时上报最终值
4. 周期性采样上报当前值（检测内存泄漏趋势）

**Props**：

```js
{
  usedJSHeapSize: number,       // 已用 JS 堆大小（字节）
  totalJSHeapSize: number,      // JS 堆总大小（字节）
  jsHeapSizeLimit: number,      // JS 堆大小限制（字节）
  phase: 'periodic' | 'final'   // 采样时机
}
```

**配置项（`EysOptions`）**：

```ts
memoryMonitoring?: boolean    // 默认 false
memoryInterval?: number       // 采样间隔 ms，默认 60000
```

**验收标准**：

- [ ] Chrome 环境下能看到 `memory` 事件
- [ ] 非 Chrome 环境不报错，静默跳过
- [ ] 数据量与 Chrome DevTools Memory 面板趋势一致

---

### 2.2 环境信息采集

#### 2.2.1 设备与环境指纹

**现状**：当前 SDK 的 `withBase()` 仅上报 `url`、`userAgent`、`sessionId`、`deviceId`，缺少系统级的设备环境信息。

**目标**：在首次上报时补充设备环境上下文，使每条事件携带更丰富的环境维度。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/utils/environment.js` |
| 依赖 | 无 |
| 配置项 | `environmentInfo: boolean`，默认 `true` |
| 影响 | 所有事件 `context` 字段 |

**新增环境字段**：

```js
{
  // 屏幕
  screenWidth: number,
  screenHeight: number,
  devicePixelRatio: number,
  colorDepth: number,

  // 视口
  viewportWidth: number,
  viewportHeight: number,

  // 语言与区域
  language: string,
  languages: string[],
  timezone: string,
  timezoneOffset: number,

  // 平台
  platform: string,
  vendor: string,
  cookieEnabled: boolean,
  doNotTrack: string,

  // 网络（Navigator Network Information API）
  connectionType: string,       // 'wifi' | 'cellular' | 'ethernet' | ...
  effectiveType: string,        // '4g' | '3g' | '2g' | 'slow-2g'
  downlink: number,             // Mbps
  rtt: number,                  // ms

  // 电池（Battery Status API，可选）
  batteryLevel: number,         // 0~1
  batteryCharging: boolean,

  // 特性支持
  features: {
    serviceWorker: boolean,
    webWorker: boolean,
    sharedArrayBuffer: boolean,
    webAssembly: boolean,
    intersectionObserver: boolean,
    performanceObserver: boolean
  }
}
```

**实现要点**：

- 在 `createEys()` 初始化时采集一次，存储到 `globalContext` 中
- 对敏感信息（如完整语言列表）进行截断
- Battery API 和 Network Information API 需要 try-catch 包裹，部分浏览器不支持
- 视口尺寸变化时通过 `resize` 事件更新（200ms 防抖）

**配置项（`EysOptions`）**：

```ts
environmentInfo?: boolean    // 默认 true
```

**验收标准**：

- [ ] 所有事件的 `context` 字段包含 `environment` 对象
- [ ] 不支持的 API 静默跳过，不产生异常
- [ ] 数据量可控，单个事件增量 < 500 字节

---

#### 2.2.2 运行时版本信息

**现状**：当前无法区分同一应用的不同构建版本（除 `release` 字段外）。

**目标**：采集构建时注入的版本信息和运行时关键信息，辅助快速定位问题版本。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/utils/runtime.js` |
| 依赖 | 无 |
| 配置项 | `runtimeInfo: boolean`，默认 `false` |
| 影响 | 所有事件 `context` 字段 |

**支持两种注入方式**：

1. **自动读取**：检测 `window.__WEB_COLLECTION_VERSION__`、`window.__BUILD_TIME__` 等约定字段
2. **手动配置**：通过 `runtimeInfo: { buildId, buildTime, commit, branch }` 传入

**Props（context 中）**：

```js
{
  runtime: {
    buildId: string,            // 构建 ID
    buildTime: string,          // 构建时间 ISO
    commit: string,             // Git commit hash
    branch: string,             // Git branch
    sdkVersion: string          // SDK 版本（已有，保持同步）
  }
}
```

**配置项（`EysOptions`）**：

```ts
runtimeInfo?: boolean | {
  buildId?: string
  buildTime?: string
  commit?: string
  branch?: string
}
```

**验收标准**：

- [ ] 自动模式下能读取到 `window.__WEB_COLLECTION_VERSION__` 等字段
- [ ] 手动配置优先级高于自动读取
- [ ] 事件 context 中包含 runtime 对象

---

### 2.3 网络请求增强

#### 2.3.1 请求/响应 Body 采样

**现状**：当前 fetch/XHR 监控只采集了状态码、耗时和 `content-length`，不采集 body 内容。

**目标**：对错误请求和特定采样率下的成功请求，采集请求/响应 body 摘要（截断后），辅助调试。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/performance/body-sampler.js` |
| 依赖 | 无 |
| 配置项 | `requestBodySampling: number`，默认 `0`（0~1） |
| 影响 | fetch / XHR 性能事件 |

**实现逻辑**：

1. 对非 2xx 请求，无论采样率均采集 body 摘要（用于错误排查）
2. 对 2xx 请求，按 `requestBodySampling` 概率决定是否采集
3. 仅采集文本类响应（`Content-Type` 包含 `json`、`text`、`xml`、`form`）
4. Body 截断到 2KB，超出标记 `[TRUNCATED]`

**新增 Props（fetch/xhr metric 事件）**：

```js
{
  requestBody: string,          // 请求体摘要
  responseBody: string,         // 响应体摘要
  bodySampled: boolean          // 是否为采样采集
}
```

**配置项（`EysOptions`）**：

```ts
requestBodySampling?: number    // 默认 0，范围 0~1
```

**隐私考量**：

- body 采集仍经过 `sanitizeEvent` 的脱敏流程
- 建议配合 `privacy.redactKeys` 使用
- 二进制响应（图片、文件）不采集

**验收标准**：

- [ ] 错误请求的 body 摘要出现在 metric props 中
- [ ] 成功请求按配置的采样率采集
- [ ] 二进制响应不采集 body
- [ ] 脱敏规则仍对 body 生效

---

#### 2.3.2 Server-Timing 采集

**现状**：当前网络监控缺少 CDN/缓存/上游服务的细粒度时序信息。

**目标**：采集 `Server-Timing` response header，获取 CDN 缓存、网关、上游服务等层面的性能拆解。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/performance/server-timing.js` |
| 依赖 | 无 |
| 配置项 | 无独立开关，跟随 `requests: true` |
| 影响 | fetch / XHR 性能事件 |

**实现逻辑**：

1. 在 fetch 拦截中读取 `response.headers.get('server-timing')`
2. 在 XHR 拦截中读取 `xhr.getResponseHeader('server-timing')`
3. 解析为标准格式附加到对应请求的 metric props 中

**新增 Props（fetch/xhr metric 事件）**：

```js
{
  serverTiming: [
    { name: string, duration: number, description: string }
  ]
}
```

**验收标准**：

- [ ] 返回 `Server-Timing` header 的请求，其 metric 事件包含 `serverTiming` 数组
- [ ] 无 `Server-Timing` header 的请求不包含该字段
- [ ] 数据不增加额外上报（附加在已有 fetch/xhr metric 中）

---

### 2.4 细粒度行为采集

#### 2.4.1 输入行为追踪

**现状**：当前行为采集覆盖了 copy/paste/download，但缺少输入框的核心交互事件。

**目标**：采集输入框聚焦、失焦、输入量变化事件，用于分析用户输入行为和识别异常。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/behavior/input.js` |
| 依赖 | 无 |
| 配置项 | `inputTracking: boolean`，默认 `false` |
| 事件名 | `input_focus` / `input_blur` / `input_change` |

**事件定义**：

| 事件名 | 触发条件 | Props |
|--------|----------|-------|
| `input_focus` | input/textarea 获得焦点 | `elementInfo` + `focusIndex`（第几次聚焦） |
| `input_blur` | input/textarea 失去焦点 | `elementInfo` + `duration`（聚焦时长 ms）+ `valueLength`（最终值长度） |
| `input_change` | input/textarea 值变化 | `elementInfo` + `changeCount`（本次聚焦内变化次数） |

**实现逻辑**：

1. 使用 `focusin` / `focusout`（冒泡）捕获输入框焦点变化
2. 用 `WeakMap` 记录每个元素的聚焦起始时间和变化次数
3. `input_change` 使用 `input` 事件，节流 300ms
4. 不采集实际输入值，仅采集变化次数和值长度

**隐私考量**：

- 不采集任何输入内容
- 仅采集元数据（聚焦时长、变化次数、值长度）
- `data-track-ignore-input` 属性的元素跳过

**配置项（`EysOptions`）**：

```ts
inputTracking?: boolean    // 默认 false
```

**验收标准**：

- [ ] 聚焦输入框时上报 `input_focus`
- [ ] 失焦时上报 `input_blur`，包含聚焦时长
- [ ] 多次输入时上报 `input_change`，changeCount 正确递增
- [ ] 标记 `data-track-ignore-input` 的元素被跳过

---

#### 2.4.2 下拉选择追踪

**现状**：当前未单独采集 `<select>` 元素的 change 事件。

**目标**：采集下拉选择框的选择变化事件。

| 项目 | 说明 |
|------|------|
| 新文件 | 集成到 `packages/sdk/src/behavior/advanced.js` 或独立文件 |
| 配置项 | `selectTracking: boolean`，默认 `false` |
| 事件名 | `select_change` |

**实现逻辑**：

1. 监听 `change` 事件，目标为 `select` 元素
2. 上报选中项的 value、text、index 和 select 元素信息

**Props**：

```js
{
  tag: 'SELECT',
  id: string,
  className: string,
  name: string,
  selectedValue: string,
  selectedText: string,
  selectedIndex: number,
  totalOptions: number
}
```

**配置项（`EysOptions`）**：

```ts
selectTracking?: boolean    // 默认 false
```

---

#### 2.4.3 键盘操作追踪

**现状**：当前未采集键盘事件。

**目标**：采集关键键盘操作（Enter 提交、Escape 关闭等），辅助分析表单提交流程。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/behavior/keyboard.js` |
| 配置项 | `keyboardTracking: boolean`，默认 `false` |
| 事件名 | `keyboard` |

**实现逻辑**：

1. 监听 `keydown` 事件
2. 只采集 `Enter`、`Escape`、`Tab` 三种键（可配置扩展）
3. 不采集实际输入的字符内容
4. 节流处理（避免长按重复上报）

**Props**：

```js
{
  key: string,                  // 'Enter' | 'Escape' | 'Tab'
  targetElement: {              // 聚焦元素信息（不包含值）
    tag: string,
    type: string,
    role: string
  },
  ctrlKey: boolean,
  shiftKey: boolean,
  altKey: boolean
}
```

**配置项（`EysOptions`）**：

```ts
keyboardTracking?: boolean               // 默认 false
keyboardTrackingKeys?: string[]          // 要追踪的按键，默认 ['Enter', 'Escape']
```

---

#### 2.4.4 Touch / 移动端手势追踪

**现状**：当前行为采集仅针对桌面端事件（click、scroll），缺少移动端 touch 事件。

**目标**：采集移动端核心 touch 手势（tap、swipe），用于分析移动端用户行为。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/behavior/touch.js` |
| 配置项 | `touchTracking: boolean`，默认 `false` |
| 事件名 | `touch_tap` / `touch_swipe` |

**实现逻辑**：

1. 监听 `touchstart` / `touchend` / `touchmove`
2. `touch_tap`：touchstart 和 touchend 距离 < 10px，时长 < 300ms
3. `touch_swipe`：touchstart 到 touchend 距离 > 100px，时长 < 1000ms
4. 附加滑动方向（上/下/左/右）

**Props**：

```js
// touch_tap
{ elementInfo, duration }

// touch_swipe
{ elementInfo, direction: 'up' | 'down' | 'left' | 'right', distance, duration }
```

**配置项（`EysOptions`）**：

```ts
touchTracking?: boolean    // 默认 false
```

---

### 2.5 运行时能力增强

#### 2.5.1 Web Worker 错误监控

**现状**：当前 `setupErrorMonitor` 仅监听主线程错误，Web Worker 内的错误无法捕获。

**目标**：监控 Web Worker 中的运行时错误。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/error/worker.js` |
| 配置项 | `workerMonitoring: boolean`，默认 `false` |
| 事件名 | `WorkerError` |

**实现逻辑**：

1. 遍历 `window` 上已有的 Worker 实例，劫持 `onerror` 和 `onmessageerror`
2. 使用 `Worker` constructor 代理，确保后续创建的 Worker 也被监控
3. 上报时附加 Worker 的创建来源信息

**Props**：

```js
{
  source: string,       // Worker URL
  error: string,        // 错误消息
  stack: string,        // 堆栈（如可获取）
  type: 'runtime' | 'message'
}
```

**配置项（`EysOptions`）**：

```ts
workerMonitoring?: boolean    // 默认 false
```

**验收标准**：

- [ ] 已有 Worker 的错误被捕获
- [ ] 后续动态创建的 Worker 的错误也能被捕获
- [ ] 上报的事件 name 为 `WorkerError`

---

#### 2.5.2 Service Worker 状态监控

**现状**：当前无 Service Worker 相关采集。

**目标**：采集 Service Worker 的注册状态、更新和错误。

| 项目 | 说明 |
|------|------|
| 新文件 | `packages/sdk/src/runtime/sw.js` |
| 配置项 | `serviceWorkerMonitoring: boolean`，默认 `false` |
| 事件名 | `service_worker_*` |

**事件定义**：

| 事件名 | 触发条件 |
|--------|----------|
| `service_worker_registered` | `navigator.serviceWorker.controller` 存在 |
| `service_worker_updated` | `controllerchange` 事件 |
| `service_worker_error` | `error` 事件 |
| `service_worker_activated` | `activate` 事件 |

**实现逻辑**：

1. 检测 `navigator.serviceWorker` 是否存在
2. 监听 `controllerchange`、`messageerror`、`statechange`（通过注册的 SW 实例）
3. 在 `service_worker_registered` 中记录当前 SW 的 script URL 和 state

**配置项（`EysOptions`）**：

```ts
serviceWorkerMonitoring?: boolean    // 默认 false
```

---

## 3. Web 平台端能力扩展

### 3.1 告警中心页面

**现状**：当前告警配置在"采集治理"页面中与业务管理混在一起，缺少独立的告警展示和处理页面。

**目标**：新建统一的告警中心，展示告警规则、触发记录、处理状态和通知渠道。

| 项目 | 说明 |
|------|------|
| 新页面 | `apps/web/src/pages/AlertsPage.vue` |
| 新路由 | `/alerts` |
| 新 API | `GET /api/alerts`（列表）、`PATCH /api/alerts/:id`（处理）、`GET /api/alerts/:id/deliveries`（触达记录） |

**页面功能**：

1. **告警规则列表**：名称、类型（错误/性能/回归）、阈值、状态（启用/暂停）、所属应用
2. **告警触发记录**：触发时间、告警名称、当前值、阈值、影响范围、处理状态
3. **告警处理流程**：未处理 → 处理中 → 已解决，支持备注
4. **通知渠道状态**：每种渠道（邮件/短信/飞书/企微/钉钉/Webhook）的最近发送记录
5. **告警趋势图**：近 7/30 天告警触发数量趋势

**组件拆分**：

- `components/AlertsTable.vue` — 告警记录表格
- `components/AlertChannels.vue` — 通知渠道状态
- `components/AlertTrendChart.vue` — 告警趋势图

**后端 API 扩展**（`apps/api/src/alerting.js`）已有的基础上增加：

```js
// GET /api/alerts?page=&pageSize=&appId=&level=&status=
// GET /api/alerts/:id
// PATCH /api/alerts/:id { status: 'acknowledged' | 'resolved', note: string }
// GET /api/alerts/:id/deliveries
// POST /api/alerts/test { channelType, target }
```

**验收标准**：

- [ ] 告警规则列表正确展示
- [ ] 触发告警后能在告警中心看到记录
- [ ] 支持更新告警处理状态
- [ ] 通知渠道发送状态可见

---

### 3.2 实时监控页面

**现状**：当前所有数据查询均为轮询模式，缺少实时推送。

**目标**：新建实时监控页面，通过 WebSocket 推送实时事件流，便于值班人员实时掌握系统状态。

| 项目 | 说明 |
|------|------|
| 新页面 | `apps/web/src/pages/LivePage.vue` |
| 新路由 | `/live` |
| 新 API | `WS /api/live`（Cloudflare Worker 支持） |

**页面功能**：

1. **实时事件流**：按时间倒序展示最新事件（错误/性能/行为），自动刷新
2. **实时统计面板**：最近 5 分钟错误数、P95、活跃会话数
3. **事件筛选**：按类型、级别、应用筛选
4. **暂停/恢复**：支持暂停自动滚动，方便查看某条事件详情
5. **告警声音**：P1/P2 错误到达时播放提示音（可关闭）

**后端扩展**（`cloudflare/worker.js`）：

```js
// WebSocket 连接管理
// 连接建立后推送最近的 summary 快照
// 新事件入库后广播给所有连接的客户端
// 支持按 appId 过滤推送
```

**前端实现**：

```js
// apps/web/src/composables/useLiveFeed.js
export function useLiveFeed() {
  const events = ref([])
  const connected = ref(false)
  const ws = ref(null)

  function connect() {
    ws.value = new WebSocket(WS_URL)
    ws.value.onmessage = (e) => {
      const data = JSON.parse(e.data)
      events.value.unshift(data)
      if (events.value.length > 200) events.value.pop()
    }
  }
  // ...
}
```

**验收标准**：

- [ ] WebSocket 连接建立成功
- [ ] 新事件入库后在 2s 内出现在实时页面
- [ ] 筛选条件正确过滤实时事件
- [ ] 断线后自动重连

---

### 3.3 用户会话页面

**现状**：当前行为分析中有会话概念，但缺少以用户为中心的全量会话时间线还原。

**目标**：新建用户会话页面，展示单个用户跨时间段的完整操作轨迹。

| 项目 | 说明 |
|------|------|
| 新页面 | `apps/web/src/pages/SessionsPage.vue` |
| 新路由 | `/sessions` |
| 新 API | `GET /api/analytics/sessions`（已有基础）、`GET /api/analytics/sessions/:id/events` |

**页面功能**：

1. **用户搜索**：按 userId、userName、userPhone 搜索
2. **会话列表**：按时间排列的会话卡片，包含首次/末次访问时间、事件数、错误数
3. **会话时间线**：选中会话后展示该会话内所有事件的时间线（PV → 行为 → 错误 → 离开）
4. **快速跳转**：时间线上的错误/性能事件可一键跳转到对应详情
5. **会话对比**：选择两个会话对比操作路径差异

**后端 API 扩展**：

```js
// GET /api/analytics/sessions?userId=&userName=&from=&to=&page=&pageSize=
// GET /api/analytics/sessions/:sessionId/events
// GET /api/analytics/users/:userId/sessions
```

**验收标准**：

- [ ] 按用户 ID 能检索到该用户的所有会话
- [ ] 会话时间线完整展示 PV → 行为 → 错误 → 离开
- [ ] 时间线上的事件可跳转到对应详情

---

### 3.4 发布管理页面

**现状**：当前治理页面已有 Release 管理的基本 CRUD，缺少版本对比和分析能力。

**目标**：新建发布管理页面，提供版本对比、影响分析和回滚建议。

| 项目 | 说明 |
|------|------|
| 新页面 | `apps/web/src/pages/ReleasesPage.vue` |
| 新路由 | `/releases` |
| 新 API | `GET /api/releases`（列表）、`GET /api/releases/:id/compare`（版本对比） |

**页面功能**：

1. **版本列表**：所有 release 的时间线视图，标注状态（active/rollback）
2. **版本对比**：选择两个版本，对比错误数、P95、LCP、INP、CLS、受影响用户数
3. **影响分析**：新版本发布后的错误增量、性能变化、受影响用户列表
4. **回滚建议**：基于增量分析，当错误激增或性能显著下降时给出回滚建议

**后端 API 扩展**：

```js
// GET /api/releases?appId=&page=&pageSize=
// GET /api/releases/:id
// GET /api/releases/compare?appId=&from=&to=
//   → { errors: { from: N, to: M, delta: number },
//       perf: { from: { lcp, inp, cls }, to: { lcp, inp, cls }, deltas },
//       affectedUsers: { from: N, to: M },
//       recommendation: string }
```

**验收标准**：

- [ ] 版本列表正确展示所有 release
- [ ] 版本对比数据正确计算
- [ ] 增量超过阈值时给出回滚建议

---

### 3.5 可视化分析增强

#### 3.5.1 性能趋势图

**现状**：当前性能页面只有当前快照，缺少历史趋势。

**目标**：在性能页面增加 Web Vitals 的趋势图，展示各指标随时间的变化。

| 项目 | 说明 |
|------|------|
| 修改 | `apps/web/src/components/PerfPanel.vue` |
| 新组件 | `apps/web/src/components/PerfTrendChart.vue` |
| 新 API | `GET /api/analytics/perf-trend?metric=lcp&from=&to=&appId=` |

**展示内容**：

- LCP / INP / CLS / FCP / FID 各自的时间趋势线
- 按 P50 / P75 / P95 分位值展示
- 标注版本发布节点（垂直线）
- 点击数据点可查看该时间点的详细分布

**验收标准**：

- [ ] 趋势图正确展示各指标的时间变化
- [ ] 版本发布节点正确标注
- [ ] 分位值数据正确

---

#### 3.5.2 行为热力图

**现状**：当前行为分析只有排行和明细表，缺少可视化热力图。

**目标**：新增点击热力图和滚动热力图组件。

| 项目 | 说明 |
|------|------|
| 新组件 | `apps/web/src/components/HeatmapPanel.vue` |
| 修改 | `apps/web/src/views/monitor/behavior/index.vue` 中增加热力图 tab |

**展示内容**：

- 点击热力图：在页面截图上叠加点击密度热力图（需配合 rrweb 快照或静态截图）
- 滚动热力图：展示页面各区域的停留时间分布
- 可按版本、时间范围筛选

**技术选型**：

- 简单方案：基于 Canvas 绘制热力图层，叠加在页面背景图上
- 背景图来源：rrweb 快照截图 或 用户自行上传的页面截图
- 滚动热力图：基于 scroll 事件的 depth 数据聚合

**验收标准**：

- [ ] 热力图正确展示点击密度
- [ ] 支持切换不同版本的热力图
- [ ] 缩放/平移热力图正常

---

#### 3.5.3 错误趋势图

**现状**：当前错误页面缺少时间维度趋势展示。

**目标**：在错误页面增加错误趋势图和 Top N 排名。

| 项目 | 说明 |
|------|------|
| 修改 | `apps/web/src/pages/ErrorsPage.vue` |
| 新组件 | `apps/web/src/components/ErrorTrendChart.vue` |
| 新组件 | `apps/web/src/components/ErrorRankPanel.vue` |
| 新 API | `GET /api/analytics/error-trend?from=&to=&appId=` |

**展示内容**：

- 错误数 / 受影响用户数 时间趋势（双轴）
- Top 10 错误排名（按影响用户数）
- 错误分类占比饼图（JS 运行时 / 资源加载 / 网络请求 / Promise）
- 版本间错误对比

**验收标准**：

- [ ] 趋势图正确展示错误数随时间变化
- [ ] Top 10 排名按影响用户数排序
- [ ] 错误分类占比正确

---

## 4. 优先级与里程碑

### Phase 1（Sprint 1-2）— 高优先级 SDK 增强

| 编号 | 能力 | 预估工期 | 优先级 |
|------|------|----------|--------|
| 2.1.1 | TTI 性能指标 | 2 天 | P0 | ✅ 已完成 |
| 2.1.3 | 内存使用监控 | 1 天 | P0 | ✅ 已完成 |
| 2.2.1 | 设备与环境指纹 | 3 天 | P0 | ✅ 已完成 |
| 2.2.2 | 运行时版本信息 | 1 天 | P0 | ✅ 已完成 |
| 2.4.1 | 输入行为追踪 | 2 天 | P1 | ✅ 已完成 |
| 2.3.1 | 请求/响应 Body 采样 | 2 天 | P1 | ✅ 已完成 |

**里程碑目标**：SDK 环境信息维度补齐，性能指标覆盖完整，行为采集覆盖核心交互场景。

### Phase 2（Sprint 3-4）— 中等优先级 SDK 增强

| 编号 | 能力 | 预估工期 | 优先级 |
|------|------|----------|--------|
| 2.1.2 | Bundle 大小监控 | 2 天 | P1 |
| 2.3.2 | Server-Timing 采集 | 1 天 | P1 |
| 2.4.2 | 下拉选择追踪 | 1 天 | P2 |
| 2.4.3 | 键盘操作追踪 | 1 天 | P2 |
| 2.4.4 | Touch / 移动端手势 | 2 天 | P2 |
| 2.5.1 | Web Worker 错误监控 | 2 天 | P2 |
| 2.5.2 | Service Worker 状态监控 | 1 天 | P2 |

**里程碑目标**：SDK 行为采集覆盖完整交互场景，运行时能力增强。

### Phase 3（Sprint 5-6）— Web 平台新页面

| 编号 | 能力 | 预估工期 | 优先级 |
|------|------|----------|--------|
| 3.1 | 告警中心页面 | 5 天 | P0 | ✅ 已完成 |
| 3.2 | 实时监控页面 | 4 天 | P0 | ✅ 已完成 |
| 3.3 | 用户会话页面 | 3 天 | P1 | ✅ 已完成 |

**里程碑目标**：平台管理能力增强，告警和实时监控补齐。

### Phase 4（Sprint 7-8）— Web 平台可视化增强

| 编号 | 能力 | 预估工期 | 优先级 |
|------|------|----------|--------|
| 3.4 | 发布管理页面 | 3 天 | P1 | ✅ 已完成 |
| 3.5.1 | 性能趋势图 | 2 天 | P1 | ✅ 已完成 |
| 3.5.2 | 行为热力图 | 3 天 | P2 | ⏳ 待后续 |
| 3.5.3 | 错误趋势图 | 2 天 | P1 | ✅ 已完成 |

**里程碑目标**：平台可视化能力增强，趋势分析和对比分析补齐。

---

## 5. 附录：现有模块开发规范

### 5.1 SDK 模块开发模板

参考现有模块结构（以 `packages/sdk/src/performance/tti.js` 为例）：

```js
/**
 * 初始化 TTI 监控。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 主实例的 metric 方法
 * @param {number} [opts.sampleRate=1] - TTI 上报采样率
 */
export function setupTtiMonitor({ metric, sampleRate = 1 }) {
  // ... 采集逻辑 ...

  return () => {
    // 清理逻辑
  }
}
```

### 5.2 配置项命名规范

- 布尔开关：`camelCase`，默认 `false`（opt-in）
- 数值参数：`camelCase`，附带默认值和范围注释
- 已在 `createEys()` 中默认 `true` 的项，新增功能默认 `false`

### 5.3 事件命名规范

- 使用蛇形命名：`input_focus`、`memory`、`bundle_summary`
- 同一逻辑事件使用统一名称（如 `service_worker_registered` 而非 `sw-registered`）
- Props 使用驼峰命名

### 5.4 Web 平台页面模板

```vue
<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { api, queryFromFilters, refreshVersion } from '../dashboard.js'
import SearchPanel from '../components/SearchPanel.vue'
// ...
</script>

<template>
  <SearchPanel :fields="[...]" @search="onSearch" />
  <el-card shadow="never" class="section panel">
    <template #header>
      <div class="panel-head"><b>页面标题</b></div>
    </template>
    <!-- 内容 -->
  </el-card>
</template>
```

### 5.5 API 路由规范

在 `apps/api/src/index.js` 中按功能分组注册：

```js
app.get('/api/alerts', ...)
app.get('/api/alerts/:id', ...)
app.patch('/api/alerts/:id', ...)
```

请求参数校验使用 `domain.parseInt` 等工具函数统一处理。
