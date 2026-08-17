# SDK v0.2.3 修复：createEys 崩溃 + 请求监控失效

## 你报的两个现象
1. IIFE SDK `createEys()` 直接抛 `ReferenceError: webCapabilities is not defined`，插件 `install` 的 catch 接住后**根本没创建采集实例**。
2. 把 `requests` 改成 `true` 会命中"缺失请求监控依赖"——请求采集（fetch/XHR）整段不工作。

## 根因
- **Bug A（致命）**：`requireCapability(name, opts)` 被放在**模块顶层**，却引用 `createEys` 作用域内的 `webCapabilities`（能力位表）与 `diagnostic`（诊断槽）。`exposure` 默认 `true`，`createEys` 跑到 `if (cfg.exposure && requireCapability('exposure', {required:true}))` 即抛 `webCapabilities is not defined`；非 Web 环境能力缺失时还会在 `diagnostic.emit` 处抛 `diagnostic is not defined`。
- **Bug B（静默）**：`src/performance/index.js:75` 调用 `setupServerTimingMonitor({ metric })`，但文件顶部 import 漏了它（只在 `src/index.js` 导入）。`requests` 默认 `true`，进入请求分支即 `ReferenceError`，被 `safe('performance')` 静默吞掉 → fetch/XHR/WebSocket/SSE 监控整体失效。

## 修复
- **Bug A**：把 `requireCapability` **整体移入 `createEys` 内部**（闭包同时捕获 `webCapabilities` 与 `diagnostic`），彻底消除作用域错位。
- **Bug B**：`performance/index.js` 补 `import { setupServerTimingMonitor } from './server-timing.js'`。

## 验证
- 新增 `packages/sdk/test/init-smoke.test.js`：以 `createEys({exposure:true, requests:true})` + 富 DOM 桩复现，断言：
  1. 实例创建成功、不再抛 `webCapabilities`；
  2. `window.fetch` 被请求监控包装（证明请求分支真正执行到 `setupFetchMonitor`）；
  3. 无 `IntersectionObserver` 时走 diagnostic 分支也不抛 `diagnostic`。
  - **3/3 通过**。原 `capabilities-identity.test.js` 的 web 测试传 `exposure:false`，从不走到 `requireCapability`，是漏测根因。
- 四产物构建成功（es/iife/platform/react）。
- 直接加载打包后的 `dist/web-collection-sdk.iife.js` 调 `createEys({exposure:true,requests:true})` 验证：实例创建成功、fetch 被包装（minified 产物中 `requireCapability` 已改名内联，无顶层引用）。

## 发布
- 版本 `0.2.2 → 0.2.3`（commit `309f1ad`）。
- 打 `v0.2.3` tag 触发 `release-npm.yml`：npm `latest = 0.2.3`；GitHub Release `v0.2.3` 为 **Latest** 且带 `web-collection-sdk-0.2.3.tgz`。
- 发布工作流顺带修了两个 CI 坑（Publish 步骤缺 `id:` 导致 release/tgz 步骤被静默 SKIP；pack 步骤 `if` 条件在重跑场景未触发），commits `ca43ada` / `0b56ab1`。

## 你还要做的一步
消费方（`account-shop-nuxt` / `account-shop-app` 等）需把 `@web-collection/sdk` 升级到 **0.2.3+** 并重部署，线上 `createEys` 才不会崩溃、请求监控才生效。
