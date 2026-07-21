# Web Collection SDK 指标说明

## 接入

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

关闭模块：
```js
createEys({
  behavior: false,
  requests: false,
  exposure: false,
  replay: false
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

## 手动埋点

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

## 行为指标

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

## 性能指标

默认自动采集。
| 指标 | 含义 | value |
| --- | --- | --- |
| `ttfb` | 首字节时间 | `navigation.responseStart` |
| `fp` | First Paint | `startTime` |
| `fcp` | First Contentful Paint | `startTime` |
| `lcp` | Largest Contentful Paint | `startTime` |
| `fid` | First Input Delay | `processingStart - startTime` |
| `inp` | 交互延迟 | `duration` |
| `cls` | 累积布局偏移 | 会话窗口最大 CLS |
| `longtask` | 长任务 | `duration` |
| `resource` | 静态资源加载耗时 | `duration` |

`resource` props：
| 字段 | 说明 |
| --- | --- |
| `name` | 资源 URL |
| `initiatorType` | 资源类型，如 `img/script/css/fetch` |
| `transferSize` | 传输大小 |
| `ttfb` | 资源响应开始时间 |

自定义性能指标：
```js
const start = performance.now()
await renderReport()
eys.metric('report_render', performance.now() - start, {
  page: 'dashboard'
})
```

## 请求指标

默认由 `requests: true` 开启，会采集 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`。
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
## 错误指标

默认自动采集。
| 错误 | 触发时机 | 主要 props |
| --- | --- | --- |
| `Error` | JS 运行时错误 | `source`、`line`、`column` |
| `ResourceError` | script/link/img 等资源加载失败 | `tag`、`html` |
| `UnhandledRejection` | 未捕获 Promise 异常 | `name` |
| `FetchError` | fetch 请求异常 | `source` |
| `WebSocketError` | WebSocket 异常 | `source`、`readyState` |
| `SseError` | EventSource 异常 | `source`、`readyState` |

手动上报错误：
```js
try {
  await submit()
} catch (err) {
  eys.error(err, { module: 'order' })
}
```

## 会话回放

默认由 `replay: true` 开启，基于 rrweb。
```js
const eys = createEys({
  replay: true,
  replaySegmentByRoute: true,
  replayMaxDuration: 60000,
  replayBatchSize: 50
})
```

| 配置 | 说明 |
| --- | --- |
| `replaySegmentByRoute` | 路由切换时结束当前录制并开始新录制 |
| `replayMaxDuration` | 单段最长录制时间 |
| `replayBatchSize` | 回放事件批量上报大小 |
| `replayOptions` | 透传 rrweb `record()` 参数 |

敏感区域：
```html
<div class="eys-block">不录制这个区域</div>
<input class="eys-ignore" />
```

手动控制：
```js
eys.startReplay()
eys.addReplayEvent('checkout_step', { step: 'pay' })
eys.takeReplaySnapshot()
eys.stopReplay()
```

## 通用字段

每条事件都会带上：
| 字段 | 说明 |
| --- | --- |
| `appId` | 应用标识 |
| `release` | 发布版本 |
| `userId/userName/userPhone` | 用户信息 |
| `sessionId` | 会话 ID |
| `deviceId` | 设备 ID |
| `url/path/title/referrer` | 页面信息 |
| `userAgent` | 浏览器 UA |
| `ts` | 事件时间戳 |

## 队列与上报
| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `batchSize` | `10` | 普通事件批量上报条数 |
| `flushInterval` | `5000` | 定时上报间隔 |
| `maxQueue` | `200` | 本地队列最大缓存 |
| `maxRetries` | `3` | 失败重试次数 |
| `sampleRate` | `1` | 采样率 |

手动刷新：
```js
eys.flush()
```

## 小程序与 App 接入

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



