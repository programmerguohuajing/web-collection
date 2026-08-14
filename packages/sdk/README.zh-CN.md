<div align="center">

🌐 **[中文文档](./README.zh-CN.md) · [English](./README.md)**

# 📦 Web Collection SDK 指标说明

> 开箱即用的浏览器端 SDK：错误、性能、回放、链路与行为采集。

[![npm version](https://img.shields.io/npm/v/@web-collection/sdk)](https://www.npmjs.com/package/@web-collection/sdk) [![npm downloads](https://img.shields.io/npm/dt/%40web-collection%2Fsdk?label=downloads)](https://www.npmjs.com/package/@web-collection/sdk) [![License](https://img.shields.io/npm/l/%40web-collection%2Fsdk)](https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk/LICENSE) [![TypeScript](https://img.shields.io/badge/types-included-blue)](https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk/index.d.ts)

</div>

**Web Collection SDK** 是为 [Web Collection](https://github.com/programmerguohuajing/web-collection) 控制台提供数据的浏览器端采集器，以轻量、框架无关的内核采集错误、性能、会话回放、分布式链路与行为数据。

## 📑 目录

- [🚀 接入](#接入)
- [🔒 隐私与数据最小化](#隐私与数据最小化)
- [🔗 分布式链路追踪与调用拓扑](#分布式链路追踪与调用拓扑)
- [🎯 手动埋点](#手动埋点)
- [📊 行为指标](#行为指标)
- [⚡ 性能指标](#性能指标)
- [🌐 请求指标](#请求指标)
- [🐛 错误指标](#错误指标)
- [💰 采样与成本控制](#采样与成本控制)
- [🎬 会话回放](#会话回放)
- [📋 通用字段](#通用字段)
- [📡 队列、传输与上报](#队列传输与上报)
- [📱 小程序与 App 接入](#小程序与-app-接入)

## 🔌 接入

```js
import { createEys } from '@web-collection/sdk'

const eys = createEys({
  endpoint: 'https://your-domain.com/api/collect',
  appId: 'mall-web',
  release: '1.0.0',
  userId: '10001',
  userName: '张三',
  userPhone: '13800000000'
})
```

登录后补用户信息：
```js
eys.setUser({ id: '10001', name: '张三', phone: '13800000000' })
```

业务首屏数据渲染完成后主动标记“页面数据就绪”：
```js
eys.markPageReady()
```

关闭模块：
```js
createEys({
  behavior: false,
  requests: false,
  exposure: false,
  replay: false
})
```

开启 `console: true` 后，会采集 `console.log/info/warn/error`，并保留最近 20 条控制台面包屑（单条最多 500 字符），用于检索及还原报错上下文。该能力默认关闭，避免意外采集业务日志中的敏感数据；可用 `consoleLevels` 限定级别。

同时可主动记录结构化日志：

```js
eys.log('info', '订单提交', { orderId: 'SO10001' })
```

请求链路默认开启，同源 Fetch/XHR 会携带标准 `traceparent`。跨域服务必须显式加入可信列表：

```js
createEys({
  collectKey: 'eys_xxx',
  traceOrigins: ['https://api.example.com']
})
```

TypeScript 项目可直接导入类型：
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

### Script 接入（无构建步骤）

无需打包工具时，直接通过 `<script>` 引入 IIFE 构建，挂载在 `window.WebCollection` 上：

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

`replay: true` 时 rrweb 不会打入核心包，IIFE 场景需由外部环境提供 `window.rrweb`（或用 `replayLibUrl` 指向自托管的 rrweb 脚本），详见[会话回放](#会话回放)。

### Vue 接入

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

- `WebCollection` 是 SDK 默认导出，作为 Vue 插件通过 `app.use()` 安装后自动完成初始化。
- 插件劫持 `app.config.errorHandler`，组件渲染期错误经 `eys.error` 自动上报（携带 `source: 'vue'`、组件名与渲染信息 `info`），无需手动 try/catch。
- 实例挂载到 `app.config.globalProperties.$eys`，组件内通过 `this.$eys` 调用埋点、日志等方法：

```js
// 选项式 API
this.$eys.track('checkout_clicked', { plan: 'pro' })
```

Vue Router 的页面切换与路由变更会被自动采集——SDK 已劫持 `history.pushState` / `replaceState` 与 `popstate` / `hashchange`，无需额外接入。要求 Vue 3.x。

### React 接入

```jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { WebCollectionProvider, ErrorBoundary, useWebCollection } from '@web-collection/sdk/react'
import App from './App'

createRoot(document.getElementById('root')).render(
  <WebCollectionProvider options={{ endpoint: 'https://your-domain.com/api/collect', appId: 'web', release: '1.0.0' }}>
    <ErrorBoundary fallback={<p>页面出错了</p>}>
      <App />
    </ErrorBoundary>
  </WebCollectionProvider>
)
```

- `WebCollectionProvider` 在应用根挂载一次并完成 SDK 初始化（在 `useEffect` 中执行，仅客户端，因此 Next.js 等 SSR 场景天然安全），通过 React Context 下发实例。
- `ErrorBoundary` 捕获子树渲染错误并通过 `eys.error` 自动上报。React 没有 Vue 那种 `app.config.errorHandler` 全局钩子，渲染期错误必须由 Error Boundary 捕获。可用 `fallback` 指定兜底 UI，或用 `eys` 传入外部创建的实例。
- `useWebCollection()` 从 Context 获取 SDK 实例（初始化完成前返回 `null`，建议在事件回调 / effect 中使用，而非首次渲染期依赖）。

```jsx
function CheckoutButton() {
  const eys = useWebCollection()
  return <button onClick={() => eys?.track('checkout_clicked', { plan: 'pro' })}>结算</button>
}
```

React Router 的页面切换与路由变更会被自动采集——SDK 已劫持 `history.pushState` / `replaceState` 与 `popstate` / `hashchange`，无需额外接入。要求 React 16.8+。

采集治理与上下文：
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

`consent` 默认是 `granted`，拒绝后事件不会进入队列或发起请求。内置脱敏先于 `beforeSend` 执行，请勿在回调中恢复敏感数据。设备环境指纹默认开启（`environmentInfo: true`）；运行时版本信息默认关闭（`runtimeInfo: false`）——开启后会在上下文中附加运行时 / SDK 版本。

## 🔒 隐私与数据最小化

SDK 默认尽量少的采集敏感数据。统一的脱敏引擎（`privacy.mode`）在每条事件**入队前**以及 `beforeSend` **之后**各执行一次，因此即便自定义钩子重新引入敏感数据，也不会被发出。

| 档位 | 行为 | 适用 |
| --- | --- | --- |
| `off` | 不做任何隐私保护（仅保留既有 `redactKeys` 字段脱敏） | 业务显式关闭保护、内网可信环境 |
| `balanced`（**默认**） | 字段键脱敏 + 值级 PII 文本脱敏 + 手机号不可逆 hash + URL 敏感参数剥离 + 头丢弃 + body 清洗 | 生产环境默认最小化采集 |
| `strict` | 在 balanced 基础上进一步：URL 丢弃整个 query、下拉框仅采索引与数量 | 强合规场景 |

`balanced` 默认自动完成：

- **字段键脱敏**：命中 `password`/`token`/`secret`/`authorization`/`cookie`/`apikey` 等敏感 key 整体替换为 `[REDACTED]`。
- **值级 PII 文本脱敏**：对字符串叶子值精准匹配并脱敏邮箱、中国大陆手机号、身份证（18 位）、银行卡（16–19 位）、JWT。
- **用户手机号不可逆 hash**：`balanced`/`strict` 下 `userPhone` 经 FNV-1a + 长度信息的 `h_*` 代称，服务端无法还原。
- **请求 / 响应头丢弃**：默认移除 `Authorization`/`Cookie`/`Set-Cookie`/`Proxy-Authorization`，可经 `dropHeaders` 追加。
- **URL query 剥离**：仅剥 `token`/`code`/`phone`/`idcard` 等敏感参数；`strict` 丢弃整个 query。
- **请求 / 响应 body 清洗**：JSON body 递归字段脱敏、文本 body 做 PII 脱敏；支持自定义 `requestResponseSanitizer` 钩子。

```js
WebCollection.createEys({
  appId: 'web-app',
  privacy: {
    mode: 'balanced',            // 默认即 balanced，可显式声明
    redactKeys: ['mySecret'],    // 在默认敏感字段基础上追加
    dropHeaders: ['x-api-secret'],
    textRedaction: true,         // 默认开启
    consentCategories: { replay: true }, // 显式授权可覆盖 GPC/DNT
    requestResponseSanitizer: (pair) => ({ ...pair, requestBody: 'REDACTED' })
  }
})
```

**同意分类与 GPC / DNT**：`consent` 默认是 `granted`，拒绝后仅保留 `essential`。浏览器发出 **GPC**（`navigator.globalPrivacyControl === true`）或 **DNT**（`navigator.doNotTrack` 为 `1/yes/true`）信号时，未被显式授权的 `analytics`/`replay`/`diagnostics` 降级为拒绝。自查接口：`getPrivacyMode()`、`getConsentCategories()`。

回放遮罩仍沿用 DOM 中的 `.eys-block`（不录制）与 `.eys-ignore`（输入框不录制）。

## 🔗 分布式链路追踪与调用拓扑

SDK 可以把页面性能、Fetch 和 XHR 事件关联为一棵分布式调用树。拓扑图不是在 SDK 内绘制的：SDK 负责上报 `traceId`、`spanId` 和 `parentSpanId`，监控平台再把相同 `traceId` 的节点聚合起来，并按父子 ID 建立连线。

### 快速接入

```js
const eys = createEys({
  endpoint: 'https://monitor.example.com/api/collect',
  appId: 'checkout-web',
  release: '1.2.0',

  // 采集 Fetch/XHR 的耗时和状态。
  requests: true,

  // 为请求指标添加链路 ID，并向可信请求注入 traceparent。
  tracing: true,

  // 创建页面根 Span 和具有父子关系的请求 Span。
  distributedTracing: true,

  // 同源请求默认可信；跨域 API 必须写入精确的协议、域名和端口。
  traceOrigins: [
    'https://api.example.com',
    'https://payment.example.com'
  ],

  // 以标准 W3C `baggage` 请求头传播的静态、非敏感业务上下文。
  // 不要放入密码、Token、Cookie、手机号或其他敏感信息。
  baggage: {
    tenant: 'shop',
    region: 'cn-east'
  },

  // SDK/会话的全局采样率；高流量生产环境应降低该值。
  sampleRate: 0.2
})
```

所有链路开关默认均为开启。要形成完整的自动请求拓扑，需要同时保持 `requests`、`tracing` 和 `distributedTracing` 为开启状态。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `requests` | `true` | 采集 Fetch/XHR 的耗时、方法、状态和失败信息；关闭后不再自动生成请求节点。 |
| `tracing` | `true` | 为请求指标附加链路标识，并向可信请求注入 `traceparent`。 |
| `distributedTracing` | `true` | 创建页面根 Span 和层级化子 Span，使平台能够根据 `parentSpanId` 还原父子关系。 |
| `traceOrigins` | `[]` | 允许接收链路请求头的跨域 Origin，支持精确字符串、`RegExp` 或 `(origin) => boolean` 匹配函数；同源请求始终允许。 |
| `baggage` | `{}` | 以标准 W3C 单一 `baggage` 请求头传播的静态、非敏感业务上下文。 |
| `sampleRate` | `1` | `0` 到 `1` 的全局会话采样率；当前会话未命中采样时返回空实现客户端。 |
| `categorySampleRates` | `{}` | 可选的分类采样率覆盖，在适用场景下也参与 Trace 采样标记。 |
| `spanExport` | `false` | 开启后，页面根 / 自动请求 / 自定义 Span 经 Processor/Exporter 批量写入 `/api/spans`（0.2.0-beta 起可配合采样默认开启）。 |

### 拓扑是如何形成的

使用上述配置时，浏览器侧会产生类似以下层级：

```text
page（根 Span）
├─ navigation 页面性能
├─ fetch https://api.example.com/orders
│  └─ order-api 服务端 Span
│     └─ 数据库或下游服务 Span
└─ xhr https://payment.example.com/pay
   └─ payment-api 服务端 Span
```

各链路字段的职责不同：

| 字段 | 含义 |
| --- | --- |
| `traceId` | 同一次端到端调用中的所有节点共用。 |
| `spanId` | 标识一次独立操作，例如页面、某个 Fetch/XHR 请求或服务端操作。 |
| `parentSpanId` | 指向调用方的 `spanId`，用于生成父子连线。 |
| `traceFlags` | 通过 W3C `traceparent` 请求头携带采样决策。 |

SDK 会自动创建页面根上下文和请求子 Span。要让调用树从浏览器继续连接到后端，每个服务都必须：

1. 读取传入的 W3C `traceparent` 请求头。
2. 保留传入的 `traceId`。
3. 创建新的服务端 `spanId`，并把传入的 `spanId` 作为 `parentSpanId`。
4. 调用下游服务时继续传递更新后的 `traceparent`。
5. 把服务端 Span 上报到同一套监控后端。

如果某个服务重新生成 `traceId`、丢失 `parentSpanId`，或者没有上报自己的 Span，平台只能显示浏览器节点或一段断开的调用分支。

### 跨域与 CORS 要求

只有目标请求与当前页面同源，或者目标的精确 Origin 已加入 `traceOrigins` 时，SDK 才会注入链路请求头。不要配置通配或不可信域名：链路和 baggage 请求头可能暴露内部关联信息。

跨域 API 必须在 CORS 预检中允许相关请求头。服务端或网关至少需要允许 `traceparent` 以及 `baggage` 请求头。如果服务端返回 `traceparent` 或 `traceresponse`，并且浏览器需要读取，还应暴露这些响应头。

```http
Access-Control-Allow-Headers: Content-Type, Authorization, traceparent, baggage
Access-Control-Expose-Headers: traceparent, traceresponse
```

配置 `traceOrigins` 不会绕过 `privacy.requestAllowlist`。设置了请求白名单时，目标 URL 必须同时满足隐私白名单和 Trace Origin 规则，SDK 才会注入链路请求头。

### 查看与排查分布式调用树

在监控平台打开 Trace 详情，然后切换到 **分布式调用树** 标签。有效且非空的拓扑要求已上报节点拥有相同的 `traceId`，并包含合法的 `spanId`/`parentSpanId` 关系。

如果页面只有顶部统计信息却没有拓扑，请依次检查：

1. `requests`、`tracing` 和 `distributedTracing` 没有被设置为 `false`。
2. `sampleRate` 大于 `0`，且当前会话命中了采样。
3. 当前请求不是 SDK 自己的采集接口。
4. 配置 `privacy.requestAllowlist` 后，白名单包含目标请求 URL。
5. 跨域地址与 `traceOrigins` 精确匹配，包括协议和端口。
6. 浏览器开发者工具中存在格式为 `00-<traceId>-<spanId>-<flags>` 的合法 `traceparent` 请求头。
7. CORS 已允许链路和 baggage 请求头。
8. 后端服务保留传入的 `traceId`、生成新的 `spanId`、记录 `parentSpanId`，并上报服务端 Span。
9. 监控平台筛选的是正确的应用、发布版本和时间范围。

生产环境建议从较低的 `sampleRate` 开始，根据采集量、存储和查询预算逐步调整。`baggage` 会随每个链路请求发送，应保持精简且不得包含敏感信息。

## 🎯 手动埋点

```js
eys.track('submit_order', {
  orderId: 'SO202607100001',
  amount: 99
})
```

入库字段：
| 字段 | 说明 |
| --- | --- |
| `type` | `track` |
| `name` | 自定义事件名 |
| `props` | 自定义业务参数 |

## 📊 行为指标

默认由 `behavior: true` 开启。
| 指标 | 触发时机 | 主要 props |
| --- | --- | --- |
| `pv` | SDK 初始化后页面访问 | `referrer` |
| `page_leave` | 页面隐藏时 | `stayTime` |
| `click` | 点击 `data-track/button/a/input/textarea/select/[role=button]` | `elementLabel`、`elementType`、`elementId`、`elementText`、`elementHref` |
| `scroll` | 页面滚动停止约 500ms 后 | `depth`、`maxDepth` |
| `pushState` | SPA 调用 `history.pushState` | `from`、`to` |
| `replaceState` | SPA 调用 `history.replaceState` | `from`、`to` |
| `popstate` | 浏览器前进后退 | `from`、`to` |
| `hashchange` | hash 路由变化 | `from`、`to` |
| `exposure` | 元素进入视口 50% 且停留约 1 秒 | 元素 `tag/id/className/text/data-track-*` |

以下可选行为默认关闭：
```js
createEys({
  formTracking: true,        // 表单提交 / 输入框聚焦失焦
  rageClick: true,           // 快速重复点击
  deadClick: true,           // 无效点击（需元素加 data-track-dead-click）
  interactionTracking: true, // 通用交互事件
  selectTracking: true,      // <select> 选项变更
  inputTracking: true,       // 输入框聚焦 / 失焦 / 变更
  keyboardTracking: true,    // 键盘按键（默认 Enter / Escape）
  touchTracking: true        // 触摸开始 / 结束
})
```

不会采集表单值与剪贴板内容。`dead_click` 需要元素增加 `data-track-dead-click`。`keyboardTrackingKeys`（默认 `['Enter', 'Escape']`）控制 `keyboardTracking` 开启时记录哪些按键。

业务事务：
```js
const transaction = eys.startTransaction('checkout', { page: 'order' })
transaction.setData({ step: 'pay' })
transaction.finish({ status: 'success' })
```

曝光用法：
```html
<section data-track-exposure data-track-name="home_banner">
  ...
</section>
```

点击元素可加业务属性：

```html
<button data-track data-track-action="save">保存</button>
```

## ⚡ 性能指标

默认自动采集。每条指标都会带上[通用字段](#通用字段)及自身 `props`。下方按类别分组。

### 页面加载与渲染

| 指标 | 含义 | `value` 来源 |
| --- | --- | --- |
| `navigation` | 完整 Navigation Timing 拆解 | `nav.duration` |
| `ttfb` | 首字节时间 | `navigation.responseStart` |
| `fp` | First Paint | `startTime` |
| `fcp` | First Contentful Paint | `startTime` |
| `first_screen` | 首屏完成（= LCP 时间点） | `lcpEntry.startTime` |
| `data_ready` | 业务数据就绪（`markPageReady()` 触发） | `performance.now()` |
| `js_boot` | SDK 初始化到首帧耗时 | `now − sdkStartedAt` |
| `lcp` | Largest Contentful Paint | `startTime` |
| `tti` | 可交互时间（基于 longtask 估算） | 估算值 |
| `tbt` | 总阻塞时间（Σ 时长 > 50ms 部分） | 累计值 |

`navigation` 的 props：`dns`、`tcp`、`tls`、`request`、`download`、`ttfb`、`dom_ready`、`page_load`、`redirect`、`redirect_count`。

### 交互、稳定性与健康度

| 指标 | 含义 |
| --- | --- |
| `fid` | 首次输入延迟 |
| `inp` | 交互延迟（Interaction to Next Paint） |
| `cls` | 累积布局偏移（会话窗口最大值） |
| `longtask` | 长任务（> 50ms，含 `attribution[]`） |
| `white_screen` | 白屏检测耗时（有效内容出现的时间） |
| `blank_screen_rate` | 白屏率——内容渲染后为 `0`，超过 `whiteScreenTimeout` 则为 `100` |
| `memory` | JS 堆内存快照（`usedJSHeapSize`/`totalJSHeapSize`/`jsHeapSizeLimit`），每 `memoryInterval` 采样一次 |
| `resource_failure_rate` | 资源加载失败率（`0` / `100`） |
| `cache_hit_rate` | 缓存命中率（`transferSize === 0 && decodedBodySize > 0` 时为 `100`） |
| `route_render` | SPA 路由渲染耗时（路由切换之间） |
| `service_worker_*` | Service Worker 生命周期状态（`installing`/`activated`/…） |

白屏检测始终开启，可用 `whiteScreenSelector`（默认 `'#app > *'`）与 `whiteScreenTimeout`（默认 `5000` ms）调整判定。`memory` 依赖 Chrome 的 `performance.memory`，默认每 `memoryInterval`（`60000` ms）采样一次；设 `memoryInterval: 0` 可关闭周期采样。

### 资源与包体

| 指标 | 含义 | 关键 `props` |
| --- | --- | --- |
| `resource` | 静态资源加载耗时 | `name`、`initiatorType`、`transferSize`、`ttfb` |
| `bundle_summary` | 页面卸载时的 JS/CSS 包体体积摘要（需 `bundleMonitoring: true`） | `jsTotalBytes`、`cssTotalBytes`、`jsCount`、`cssCount`、`chunks[]` |
| `fetch_body` / `xhr_body` | 请求/响应 body 采样（需 `requestBodySampling > 0`） | 请求/响应 body（经脱敏） |

fetch/XHR 响应中的 Server-Timing 会被解析并附加到对应 `fetch`/`xhr` 指标的 `props`（W3C Server-Timing）。

自定义性能指标：
```js
const start = performance.now()
await renderReport()
eys.metric('report_render', performance.now() - start, {
  page: 'dashboard'
})
```

## 🌐 请求指标

默认由 `requests: true` 开启，会采集 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`。通过 `requestBodySampling: <0..1>`（默认 `0`）开启请求 / 响应 body 采样；采样到的 body 以 `fetch_body` / `xhr_body` 上报，且始终经过隐私脱敏。
### Fetch

```js
await fetch('/api/orders')
```

| 字段 | 说明 |
| --- | --- |
| `metric` | `fetch` |
| `value` | 请求耗时 |
| `props.url` | 请求地址 |
| `props.method` | 请求方法 |
| `props.status` | 状态码 |
| `props.ok` | 是否 2xx |

失败时会上报 `FetchError`。
### XHR

```js
const xhr = new XMLHttpRequest()
xhr.open('GET', '/api/profile')
xhr.send()
```

| 字段 | 说明 |
| --- | --- |
| `metric` | `xhr` |
| `value` | 请求耗时 |
| `props.url` | 请求地址 |
| `props.method` | 请求方法 |
| `props.status` | 状态码 |

### WebSocket

```js
const ws = new WebSocket('wss://example.com/socket')
ws.send(JSON.stringify({ type: 'ping' }))
```

| 阶段 | 说明 |
| --- | --- |
| `phase: open` | 建连耗时 |
| `phase: close` | 连接持续时长、关闭码、消息数、字节数 |

失败时会上报 `WebSocketError`。
### SSE

```js
const source = new EventSource('/api/stream')
source.addEventListener('message', event => {
  console.log(event.data)
})
```

| 阶段 | 说明 |
| --- | --- |
| `phase: open` | 建连耗时 |
| `phase: close` | 连接持续时长、消息数、字节数 |

失败时会上报 `SseError`。
## 🐛 错误指标

默认自动采集。
| 错误 | 触发时机 | 主要 props |
| --- | --- | --- |
| `Error` | JS 运行时错误 | `source`、`line`、`column` |
| `ResourceError` | script/link/img 等资源加载失败 | `tag`、`elementPath` |
| `UnhandledRejection` | 未捕获 Promise 异常 | `name` |
| `FetchError` | fetch 请求异常 | `source` |
| `WebSocketError` | WebSocket 异常 | `source`、`readyState` |
| `SseError` | EventSource 异常 | `source`、`readyState` |

可通过 `workerMonitoring: true` 监控 Web Worker 错误、`serviceWorkerMonitoring: true` 监控 Service Worker 生命周期状态（两者默认均关闭）。

手动上报错误：
```js
try {
  await submit()
} catch (err) {
  eys.error(err, { module: 'order' })
}
```

## 💰 采样与成本控制

采样是**确定性**且**可解释**的：相同的 `traceId` 或 `sessionId` 永远得到相同的保留 / 丢弃决策，因此同一条分布式链路不会被拆到保留 / 丢弃两侧，错误关联数据也不会因采样丢失。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `sampleRate` | `1` | session/global 基础采样率（`0`~`1`） |
| `traceRate` | `= sampleRate` | 链路（`traceId`）基础采样率 |
| `categorySampleRates` | `{}` | 分类采样率表（error/performance/requests/behavior/exposure/replay）；仅收窄 session 级，绝不破坏 trace |
| `errorSampleRate` | 未设置 | 错误链路 / 事件确定性子采样率；不设置 = 错误始终保留 |

关键保证：

- **同 ID 同决策**：`rate=1` 永远采样；`rate=0` 永不采样；中间值下同一 key 永远得到相同布尔结果。
- **错误默认必留**：错误会将其 `traceId` 标记为优先级，即使 `sampleRate` 很低，错误及其关联请求 Span 仍被保留。仅在需要约束错误体量时才配置 `errorSampleRate`。
- **可解释**：被采样丢弃的事件通过 `onDiagnostic('dropped_by_sampling')` 派发（含 `rule`/`rate`/`unit`/`key`）；`getSamplingDecision()` 返回最近一次决策。

```js
const eys = createEys({
  sampleRate: 0.2,
  categorySampleRates: { behavior: 0.5, replay: 0.1 }
})
// 调试时自查最近一次采样决策：
console.log(eys.getSamplingDecision())
```

## 🎬 会话回放

会话回放基于 rrweb 录制用户 DOM，用于还原错误发生前的操作路径。它**按成本可选**：rrweb **不会**被打入核心包。当 `replay: false`（默认 `true`）时，ESM 与基础 IIFE 均不下载、解析、编译 rrweb。当 `replay: true` 时按需加载——ESM 拆分为独立 `rrweb-*.js` chunk；IIFE 由外部环境通过 `window.rrweb`（或 `replayLibUrl`）提供。

```js
const eys = createEys({
  replay: true,
  replaySegmentByRoute: true,   // 路由切换时结束当前录制并开始新录制
  replayMaxDuration: 60000,     // 单段最长录制时间
  replayBufferSize: 1500,       // 环形缓冲容量（条）
  replayWindowMs: 30000,        // 留存窗口——错误前 30 秒
  replayCompression: true       // gzip（Worker → 主线程 → none 降级）
})
```

### 成本与性能控制（SDK-209 / SDK-210）

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `replay` | `true` | 是否开启会话回放；`false` 时不下载 rrweb |
| `replayMaxDuration` | `60000` | 单段最长录制时长（ms）；路由切换或达到该时长时开启新一段 |
| `replayLibUrl` | `''` | IIFE 自托管场景：外部化 rrweb 脚本地址，加载后暴露 `window.rrweb` |
| `replayWorkerUrl` | `''` | 压缩 Worker 脚本地址；提供则优先在 Worker 内 gzip |
| `replayCompression` | `true` | 是否对回放 payload 做 gzip（无 `CompressionStream` 自动降级 `none`） |
| `replayBufferSize` | `1500` | 环形缓冲容量（条）；约束长会话常驻内存 |
| `replayWindowMs` | `30000` | 留存时间窗口（ms）；保证错误前 30 秒可恢复 |
| `replayBatchSize` | `50` | 增量刷新单页上限 |

- **内存有界**：事件写入环形缓冲（容量 + 时间窗口），旧事件惰性淘汰；窗口被压缩时发出 `replay_buffer_full`。
- **压缩**：优先 Worker 内 gzip，否则主线程 `CompressionStream`，否则 base64 UTF-8。`replay_compressed` 报告 payload 字节数；降级时一次性发出 `replay_worker_unavailable`。

### 错误触发升采样与质量（SDK-214）

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `replaySampleRate` | `1` | 常态回放增量采样率（`[0,1]`）；`<1` 时对高频事件降采样以降本 |
| `replayErrorTrigger` | `true` | 错误触发升采样：错误发生升至全采样并扩展留存窗口 |
| `replayWindowMsError` | `60000` | 错误升采样期间留存窗口（ms，常态 30s 的两倍） |
| `replayPageSize` | `50` | 强制刷新单页上限，超出拆多页（`page`/`pageCount`） |
| `replayCanvas` | `false` | Canvas 录制显式 opt-in：透传 rrweb `recordCanvas`（完整保真度需 `replayOptions.plugins` 提供 `@rrweb/rrweb-plugin-canvas`） |
| `replayIframe` | `false` | 跨域 iframe 录制显式 opt-in：透传 `recordCrossOriginIframes` + `inlineIframes` |

发生错误时，SDK 升至**全采样**并将留存窗口扩展到 `replayWindowMsError`（默认 60s），发出 `replay_error_triggered` 便于控制台优先保留该会话。Canvas / iframe 录制**默认关闭**，仅在确有需要时显式开启。

回放质量经 `replay_quality`（buffered、evictedTotal≈丢帧、sampledDrops、pages、compression、sampleRate、errorBoosted）与 `replay_recorder_error`（rrweb 内部报错，消息截断、不含 PII）可观测。

### 手动控制

```js
await eys.startReplay()                       // 异步，兼容不 await
eys.addReplayEvent('checkout_step', { step: 'pay' })
eys.takeReplaySnapshot()
await eys.stopReplay()                        // 异步
await eys.flushReplay(true)                   // 强制冲刷错误前 30 秒窗口
```

`startReplay`/`stopReplay`/`flushReplay` 已改为异步，但**可不 await**（调用排队而非丢失）。若 `destroy()` 与在途加载竞速，加载完成后立即停录，避免泄露。

### 敏感区域

```html
<div class="eys-block">不录制这个区域</div>
<input class="eys-ignore" />
```

## 📋 通用字段

每条事件都会带上：
| 字段 | 说明 |
| --- | --- |
| `sdkVersion` | SDK 版本 |
| `environment` | 运行环境，如 production/test |
| `source` | `auto`、`manual` 或 `platform` |
| `context` | 已脱敏的全局/事件上下文 |
| `appId` | 应用标识 |
| `release` | 发布版本 |
| `userId/userName/userPhone` | 用户信息 |
| `sessionId` | 会话 ID |
| `deviceId` | 设备 ID |
| `traceId/spanId` | 请求与业务链路标识（可选） |
| `url/path/title/referrer` | 页面信息 |
| `userAgent` | 浏览器 UA |
| `ts` | 事件时间戳 |

## 📡 队列、传输与上报

事件先进入内存**热队列**，并镜像到 **IndexedDB 冷队列**，因此刷新、崩溃、断网后不丢，并在下一会话恢复（发出 `next_session_recovered` 诊断）。标签页隐藏或页面卸载时，通过 **Beacon** 退出通道冲刷剩余事件（UTF-8 字节切片、非破坏性——服务端按 `eventId` 幂等去重）。

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `batchSize` | `10` | 普通事件批量上报条数（同时作为单次传输批次上限） |
| `flushInterval` | `60000` | 定时上报间隔（ms） |
| `maxQueue` | `200` | 本地队列最大缓存（超出丢弃最旧并触发 `queue_full`） |
| `maxRetries` | `3` | 在线发送失败重试次数 |
| `transportTimeout` | `10000` | 单次在线发送超时（ms） |
| `beaconMaxBytes` | `61440` | Beacon 单批 UTF-8 字节上限 |
| `sampleRate` | `1` | session/global 采样率（见采样与成本控制） |
| `onDiagnostic` | `null` | 健康事件回调（见诊断） |

发送可靠：指数退避 + 等抖动、`Retry-After` 优先、对 `408/425/429/5xx` 重试、对 `4xx` 契约错误永久丢弃；跨标签页锁保证同域名至多一个标签页真正发送。

手动刷新：
```js
eys.flush()
```

## 🩺 诊断（`onDiagnostic`）

传入 `onDiagnostic` 可观测非敏感的 SDK 健康事件。回调不会抛异常、不含业务 PII，可长期在生产开启以监控传输与回放成本：

```js
WebCollection.createEys({
  onDiagnostic: (e) => {
    if (e.type === 'queue_full') console.warn('本地队列溢出', e)
    if (e.type === 'replay_buffer_full') console.warn('回放窗口被压缩', e)
  }
})
```

传输事件：`queue_full`、`rate_limited`、`timeout`、`invalid_payload`、`storage_quota`、`dropped_by_sampling`、`beacon_rejected`、`beacon_oversize`、`beacon_fallback`、`next_session_recovered`、`dropped_non_retryable`、`flush_success`、`flush_failed`、`retry`。

回放事件：`replay_buffer_full`、`replay_worker_unavailable`、`replay_compressed`、`replay_error_triggered`、`replay_recorder_error`、`replay_quality`。

## 📱 小程序与 App 接入

非 Web 运行时使用独立入口 `@web-collection/sdk/platform`，不会加载 DOM、rrweb、`window` 或 `localStorage`。同一构建产物也可通过 `miniapp`、`uni-app`、`taro`、`react-native` 子路径导入。

### 微信、支付宝、抖音及其他小程序

SDK 会自动识别 `wx`、`my`、`tt`、`swan`、`qq`、`ks`、`jd`。在 `app.js` 中创建实例，并用 `instrumentApp`、`instrumentPage` 包装原有配置：

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

支付宝小程序传入 `my`，抖音小程序传入 `tt`；其他兼容小程序可显式传入对应全局 API：

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

// 在页面 onShow/onHide 中记录页面生命周期
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

React Native 持久化队列需要传入项目已有的 AsyncStorage 实例，SDK 不强制增加存储依赖：

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

跨端客户端统一支持 `track`、`behavior`、`metric`、`error`、`pageView`、`pageLeave`、`setUser`、批量队列、失败重试和持久化。小程序与原生 App 没有浏览器 DOM，因此不提供 rrweb 录屏；页面轨迹、点击和业务操作应通过生命周期及 `track` 上报。

平台端同样支持 `setConsent`、`setEnabled`、`setContext`、`addBreadcrumb` 和 `startTransaction`。使用 `instrumentApp` 会记录应用启动、前后台切换，并保留原有生命周期回调。
