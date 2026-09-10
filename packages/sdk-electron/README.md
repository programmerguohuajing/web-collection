<div align="center">

🌐 **[English](./README.md) · [中文文档](./README.zh-CN.md)**

# 📦 @web-collection/sdk-electron

> Web Collection SDK for **Electron** — app-level telemetry in the main process plus an IPC bridge for renderer events.

[![npm version](https://img.shields.io/npm/v/@web-collection/sdk-electron)](https://www.npmjs.com/package/@web-collection/sdk-electron) [![npm downloads](https://img.shields.io/npm/dt/%40web-collection%2Fsdk-electron?label=downloads)](https://www.npmjs.com/package/@web-collection/sdk-electron) [![License](https://img.shields.io/npm/l/%40web-collection%2Fsdk-electron)](https://github.com/programmerguohuajing/web-collection/blob/main/LICENSE) [![TypeScript](https://img.shields.io/badge/types-included-blue)](https://github.com/programmerguohuajing/web-collection/blob/main/packages/sdk-electron/index.d.ts)

</div>


Part of the platform-adapter family (`/platform`, `/miniapp`, `/react-native`, …): all event payloads reuse the **existing backend event-type whitelist** (`track` / `perf` / `behavior` / `error`); Electron semantics live in names and props, never in new event types. The `electron` module is **never imported** by this package — everything is dependency-injected, which keeps the package unit-testable and the main/preload boundary clean.

## Install

```bash
pnpm add @web-collection/sdk-electron @web-collection/sdk
```

`@web-collection/sdk` is a peer dependency (platform kernel). Requires Electron ≥ 22 (global `fetch` in the main process).

## Main process (5 lines)

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

Collected automatically:

| Trigger | Event |
|---|---|
| `app 'ready'` | `behavior('app_start', {platform, electronVersion, appVersion})` + `perf('app_ready', ms)` |
| `app 'browser-window-focus' / 'blur'` | `behavior('app_foreground' / 'app_background')` (deduped) |
| `process 'uncaughtException' / 'unhandledRejection'` | `error(err, {crash_source: 'main_*'})` |
| `webContents 'render-process-gone'` | `error(…, {crash_source: 'renderer_gone', reason, exitCode})` |
| `webContents 'preload-error'` | `error(err, {crash_source: 'preload_error', file})` |
| `app 'window-all-closed' / 'before-quit'` | `flush(true)` (no tail-event loss) |

Never-throws guarantee: all listeners are guarded; a broken client or failing transport only emits diagnostics, never crashes the host. `eys.dispose()` before quit removes all instrumentation and destroys the kernel client (idempotent). Renderer watchdogs can be attached manually via `attachRendererWatchdog(webContents, client)` for windows created after startup.

## Renderer

**A. Direct mode (recommended)** — when the renderer loads `http(s)` URLs, use the regular Web SDK (`@web-collection/sdk`) in the renderer: full DOM / performance / error / **session replay** capabilities.

**B. Bridge mode** — when the renderer loads `file://` or you want a single egress point (collect key stays in main):

```js
// preload.js (contextBridge-safe: only a minimal send is exposed)
import { exposeEysBridge } from '@web-collection/sdk-electron/preload'
import { ipcRenderer, contextBridge } from 'electron'
contextBridge.exposeInMainWorld('__EYS_IPC__', undefined) // see below
exposeEysBridge(ipcRenderer) // window.__EYS_IPC__ = { channel, send(payload) }
```

```js
// main.js — IPC proxy sink: renderer payload → main fetch → server
import { attachIpcSink } from '@web-collection/sdk-electron'
const sink = attachIpcSink({ ipcMain, channel: 'eys:events', endpoint: 'https://your-host/api/collect', collectKey: 'ck_xxx' })
```

```js
// renderer — platform kernel + IPC adapter (transport over IPC, ack-aware retry)
import { createPlatformEys } from '@web-collection/sdk/platform'
import { createElectronIpcAdapter } from '@web-collection/sdk-electron/preload'
const eys = createPlatformEys({ endpoint: '/api/collect', appId: 'my-electron-app' },
  createElectronIpcAdapter({ ipcRenderer, channel: 'eys:events' }))
```

Bridge mode notes: `invoke`/`handle` is used when available (ack → the kernel retries failed batches); on old Electron it degrades to `send` (fire-and-forget, 202). DOM/replay auto-instrumentation is **not** part of bridge mode (`capabilities.dom = false`) — use direct mode when you need replay.

## Hard constraints

- No new event `type`s — the backend whitelist is untouched; see `test/event-mapping.test.js` for the enforced mapping table.
- `electron` is injected, never imported (`test/no-web-globals.test.js` enforces this plus the absence of bare web globals).
- Public APIs and collection callbacks never throw to the host.
- Main-process crash handlers only record; they never call `process.exit`/`app.quit` — exit policy stays with the host.

## Build & test

```bash
pnpm --filter @web-collection/sdk-electron build   # es + cjs (main) + es + cjs (preload)
pnpm --filter @web-collection/sdk-electron test    # node --test test/*.test.js
```
