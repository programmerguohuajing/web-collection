# Web Collection

Web Collection 是 pnpm monorepo 版前端监控系统，包含 Vue3 + Element Plus 控制台、Node API 服务和浏览器 SDK。

## 目录

- `apps/web`: 前端监控控制台
- `apps/api`: Node 后端服务
- `packages/sdk`: 浏览器监控 SDK
- `packages/sdk/src/error`: JS、Promise、资源错误采集
- `packages/sdk/src/performance`: 性能采集，包含 `fetch.js`、`xhr.js`、`websocket.js`、`sse.js`
- `packages/sdk/src/behavior`: PV、点击、路由、停留、滚动行为采集
- `packages/sdk/src/exposure`: 元素曝光采集
- `packages/sdk/src/replay`: rrweb 会话回放采集

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 10
- PostgreSQL >= 12

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

在项目根目录创建 `.env` 文件，或通过系统环境变量配置：

```bash
PORT=8787
DATABASE_URL=postgresql://user:pass@localhost:5432/web_collection
ADMIN_API_KEY=your-secret-key
COLLECT_TOKEN=
CORS_ORIGIN=http://127.0.0.1:5173
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/your-token
```

也可以拆分 PostgreSQL 配置：

```bash
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=postgres
DB_NAME=web_collection
```

Windows PowerShell 示例：

```powershell
$env:ADMIN_API_KEY="change-me"
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/web_collection"
```

### 3. 初始化数据库

```bash
pnpm --filter @web-collection/api db:init
```

会创建事件、错误、回放、SourceMap、应用版本、采集策略和告警审计所需的数据表。

### 4. 开发模式

开发模式需要同时运行 API 服务和前端控制台。

终端 1：启动 API 服务，默认端口 `8787`。

```bash
pnpm dev
```

终端 2：启动前端控制台，默认端口 `5173`。

```bash
pnpm dev:web
```

访问 `http://127.0.0.1:5173` 或 `http://你的局域网IP:5173`，输入 `ADMIN_API_KEY` 后查看数据。Vite 默认监听 `0.0.0.0`，因此局域网内其他设备也可以访问。

### 5. 生产模式

先构建前端控制台和 SDK：

```bash
pnpm build
```

构建产物：

- 前端控制台：`apps/web/dist`
- SDK：`packages/sdk/dist`
- 统一产物目录：`dist/`

API 服务会托管 Web 控制台和 SDK：

- 控制台：`http://127.0.0.1:8787/`
- IIFE SDK：`http://127.0.0.1:8787/sdk/web-collection-sdk.iife.js`
- ES Module SDK：`http://127.0.0.1:8787/sdk/web-collection-sdk.es.js`
- 兼容入口：`http://127.0.0.1:8787/web-collection-sdk.iife.js`
- 兼容入口：`http://127.0.0.1:8787/web-collection-sdk.es.js`

启动生产服务：

```bash
pnpm --filter @web-collection/api start
```

等价于：

```bash
pm2 start ecosystem.config.cjs --only web-collection-api --env production
```

常用 PM2 命令：

```bash
pm2 status
pm2 logs web-collection-api
pm2 restart web-collection-api --update-env
pm2 stop web-collection-api
```

### GitHub Actions 自托管 Runner 部署

仓库内的 `.github/workflows/deploy.yml` 会在 `main` 分支更新后构建、测试并部署到带有 `web-collection` 标签的 Linux 自托管 Runner。

Runner 主机需预装 Node.js、PM2、curl，并准备部署目录：

```bash
sudo mkdir -p /opt/web-collection/{shared,releases}
sudo chown -R "$USER":"$USER" /opt/web-collection
cp .env /opt/web-collection/shared/.env
npm install -g pm2
```

在 GitHub 仓库的 `Settings > Actions > Runners` 注册 Runner，并添加 `web-collection` 标签。可选仓库变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEPLOY_ROOT` | `/opt/web-collection` | 稳定部署目录 |
| `HEALTH_URL` | `http://127.0.0.1:8787/health` | 发布后的健康检查地址 |

工作流保留最近 5 个版本；新版本启动或健康检查失败时自动切回上一个版本。

### SourceMap 自动上传

在业务构建完成后执行：

```bash
pnpm sourcemaps:upload -- --dir apps/web/dist --app-id web --release 1.0.0 \
  --endpoint https://monitor.example.com --key "$WEB_COLLECTION_ADMIN_KEY"
```

控制台的“采集治理”页面可以管理应用、版本、事件/回放采样率、数据保留周期、告警阈值、飞书通知记录和 CSV 报表导出。生产试点步骤见 [docs/production-pilot.md](docs/production-pilot.md)。

## SDK 接入

### NPM 接入

```js
import { createEys } from '@web-collection/sdk'

const eys = createEys({
  endpoint: 'https://your-domain.com/api/collect',
  appId: 'web',
  release: '1.0.0',
  userId: 'u_10001',
  userName: '张三',
  userPhone: '13800138000'
})

eys.setUser({ id: 'u_10002', name: '李四', phone: '13900139000' })
```

### Script 接入

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

### Vue3 插件接入

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

## 能力说明

### 行为埋点

自动采集 PV、点击、路由变化、页面停留和滚动深度。

```html
<button data-track data-track-name="buy_click" data-track-sku="A001">
  购买
</button>
```

```js
eys.track('checkout_submit', {
  sku: 'A001',
  amount: 199
})
```

关闭行为采集：

```js
createEys({ behavior: false })
```

### 错误监控

自动采集 JS 错误、未处理 Promise 异常、图片/CSS/JS 资源加载失败。Vue 插件模式会额外接入 `app.config.errorHandler`。

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

错误事件会带最近的行为面包屑，方便在后台回归用户操作路径。

### 性能监控

自动采集 FCP、LCP、FID、INP、CLS、TTFB、longtask、resource。

```js
const start = performance.now()
await renderReport()
eys.metric('report_render', performance.now() - start, {
  page: 'dashboard'
})
```

### Fetch / XHR / WebSocket / SSE

SDK 会劫持浏览器原生 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`，采集接口耗时、状态码、成功状态、连接耗时和连接持续时间。上报接口本身会自动过滤，避免循环上报。

```js
await fetch('/api/orders')

const xhr = new XMLHttpRequest()
xhr.open('GET', '/api/profile')
xhr.send()

const ws = new WebSocket('wss://example.com/socket')
const source = new EventSource('/api/stream')
```

关闭请求采集：

```js
createEys({ requests: false })
```

### 曝光采集

元素进入视口 50% 且停留约 1 秒后上报一次曝光。

```html
<section data-track-exposure data-track-name="home_banner" data-track-banner-id="B001">
  ...
</section>
```

关闭曝光采集：

```js
createEys({ exposure: false })
```

### rrweb 回放

默认开启 rrweb 会话录制，表单输入会脱敏。每次 SPA 路由切换会停止当前录制，进入新页面后重新开始录制；单个页面默认最多录制 60 秒，避免长时间停留产生过大的回放数据。

```html
<div class="eys-block">不会被录制的敏感区域</div>
<input class="eys-ignore" />
```

```js
const eys = createEys({ replay: false })

eys.startReplay()
eys.addReplayEvent('checkout_step', { step: 'pay' })
eys.takeReplaySnapshot()
eys.stopReplay()
```

自定义 rrweb 参数：

```js
createEys({
  replayMaxDuration: 60000,
  replayOptions: {
    checkoutEveryNms: 30000,
    recordCanvas: true,
    blockSelector: '.privacy',
    ignoreSelector: '.no-record'
  }
})
```

关闭回放：

```js
createEys({ replay: false })
```

## SourceMap

后台控制台可上传 SourceMap，也可调用接口：

```bash
curl -X POST http://127.0.0.1:8787/api/sourcemaps \
  -H "x-api-key: dev-admin-key" \
  -H "content-type: application/json" \
  -d '{"release":"1.0.0","file":"app.js","map":{}}'
```

错误堆栈里的 `app.js:line:column` 会按相同 `release + file` 自动反解到源码位置。

## 完整配置

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
  replayOptions: {},
  // 首页首个有效内容节点，用于计算白屏时间和白屏率
  whiteScreenSelector: '#app > *',
  // 超过该时间仍未出现有效内容，则记为白屏
  whiteScreenTimeout: 5000
})
```

首页关键数据渲染完成后，可主动标记“页面数据就绪”时间：

```js
const eys = createEys({
  endpoint: '/api/collect',
  appId: 'web'
})

await loadHomeData()
eys.markPageReady()
```

## 脚本一览

| 命令 | 说明 |
| --- | --- |
| `pnpm install` | 安装全部依赖 |
| `pnpm dev` | 启动 API 开发服务，端口 `8787` |
| `pnpm dev:web` | 启动前端控制台开发服务，端口 `5173` |
| `pnpm build` | 构建前端控制台和 SDK，并汇总产物到根目录 `dist/` |
| `pnpm start` | 生产模式启动 API，同时托管前端静态文件 |
| `pnpm test` | 运行测试 |
| `pnpm --filter @web-collection/api db:init` | 初始化 PostgreSQL 表结构 |
| `pnpm --filter @web-collection/sdk build` | 单独构建 SDK |
| `pnpm --filter @web-collection/web build` | 单独构建前端控制台 |
