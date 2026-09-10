<div align="center">

🌐 **[中文文档](./README.zh-CN.md) · [English](./README.md)**

# 📦 @web-collection/sdk-electron

> Web Collection SDK 的 **Electron** 适配包 —— 主进程应用级遥测 + 渲染进程事件 IPC 桥。

<p align="center">
  <a href="https://www.npmjs.com/package/@web-collection/sdk-electron"><img src="https://img.shields.io/npm/v/@web-collection/sdk-electron" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@web-collection/sdk-electron"><img src="https://img.shields.io/npm/dt/%40web-collection%2Fsdk-electron?label=downloads" alt="npm downloads" /></a>
  <a href="https://github.com/programmerguohuajing/web-collection/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/%40web-collection%2Fsdk-electron" alt="License" /></a>
  <a href="https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk-electron/index.d.ts"><img src="https://img.shields.io/badge/types-included-blue" alt="TypeScript" /></a>
</p>

</div>


平台适配器家族成员（`/platform`、`/miniapp`、`/react-native`、…）：所有事件复用**后端既有事件类型白名单**（`track` / `perf` / `behavior` / `error`），Electron 场景语义全部表达在 name / props 上，不新增任何事件 type。本包**绝不 import 'electron'**——全部依赖注入，保证可单测且 main/preload 边界干净。

## 安装

```bash
pnpm add @web-collection/sdk-electron @web-collection/sdk
```

`@web-collection/sdk` 为 peer dependency（平台内核）。要求 Electron ≥ 22（主进程有全局 `fetch`）。

## 主进程接入（5 行）

```js
// main.js
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElectronEys, createJsonFileStorage } from '@web-collection/sdk-electron'

const eys = createElectronEys({
  endpoint: 'https://your-host/api/collect',
  appId: 'my-electron-app',
  release: '1.0.0'
}, {
  app,
  storage: createJsonFileStorage({
    readFile: readFileSync,
    writeFile: writeFileSync,
    file: join(app.getPath('userData'), 'eys-storage.json')
  })
})
```

自动采集清单：

| 触发 | 事件 |
|---|---|
| `app 'ready'` | `behavior('app_start', {platform, electronVersion, appVersion})` + `perf('app_ready', 毫秒)`（冷启动） |
| `app 'browser-window-focus' / 'blur'` | `behavior('app_foreground' / 'app_background')`（去抖） |
| `process 'uncaughtException' / 'unhandledRejection'` | `error(err, {crash_source: 'main_*'})` |
| `webContents 'render-process-gone'` | `error(…, {crash_source: 'renderer_gone', reason, exitCode})` |
| `webContents 'preload-error'` | `error(err, {crash_source: 'preload_error', file})` |
| `app 'window-all-closed' / 'before-quit'` | `flush(true)`（退出前强制冲刷，尾部事件不丢） |

永不抛错保证：所有监听经 guard 包装；client 故障或传输失败只产出诊断，绝不崩溃宿主。退出前调用 `eys.dispose()` 卸载全部插桩并销毁内核 client（幂等）。启动后新建的窗口可用 `attachRendererWatchdog(webContents, client)` 手动补挂看门狗。

## 渲染进程

**A. 直连模式（推荐）**——渲染进程加载 `http(s)` 页面时，直接在渲染进程用 Web 版 `@web-collection/sdk`：DOM / 性能 / 错误 / **会话回放** 全能力。

**B. 桥接模式**——渲染进程加载 `file://`，或希望统一出口（collectKey 凭据只留主进程）：

```js
// preload.js（contextBridge 安全：只暴露最小 send 能力）
import { exposeEysBridge } from '@web-collection/sdk-electron/preload'
import { ipcRenderer } from 'electron'
exposeEysBridge(ipcRenderer) // window.__EYS_IPC__ = { channel, send(payload) }
```

```js
// main.js —— IPC 代理 sink：渲染进程载荷 → 主进程 fetch → 服务端
import { attachIpcSink } from '@web-collection/sdk-electron'
const sink = attachIpcSink({ ipcMain, channel: 'eys:events', endpoint: 'https://your-host/api/collect', collectKey: 'ck_xxx' })
```

```js
// renderer —— 平台内核 + IPC 适配器（传输走 IPC，带 ack 重试）
import { createPlatformEys } from '@web-collection/sdk/platform'
import { createElectronIpcAdapter } from '@web-collection/sdk-electron/preload'
const eys = createPlatformEys({ endpoint: '/api/collect', appId: 'my-electron-app' },
  createElectronIpcAdapter({ ipcRenderer, channel: 'eys:events' }))
```

桥接模式说明：可用时走 `invoke`/`handle`（带 ack，发送失败内核自动重试）；老版本 Electron 退化为 `send`（fire-and-forget，202）。桥接模式**不含** DOM/回放自动插桩（`capabilities.dom = false`）——需要回放请走直连模式。

## 硬性约束

- 不新增事件 `type` —— 后端白名单不动；映射表由 `test/event-mapping.test.js` 强制校验。
- electron 全程依赖注入、绝不 import（`test/no-web-globals.test.js` 同时校验无 Web 裸全局）。
- 公开 API 与采集回调永不向宿主抛错。
- 主进程崩溃处理器只采集，绝不调用 `process.exit` / `app.quit` —— 退出决策权在宿主。

## 构建与测试

```bash
pnpm --filter @web-collection/sdk-electron build   # es + cjs（主进程）+ es + cjs（preload）
pnpm --filter @web-collection/sdk-electron test    # node --test test/*.test.js
```
