# Replay v2 · 会话回放分包、懒加载与性能治理设计说明

> 关联路线图：Phase 7（U07 / SDK-209 / SDK-210）
> 实现模块：`packages/sdk/src/replay/`（`rrweb-driver.js`、`index.js`、`ring-buffer.js`、`compress.js`、`compression.worker.js`）、构建 `vite.config.js` / `vite.iife.config.js`、入口 `src/index.js`、`index.d.ts`。
> 接入点：浏览器 `src/index.js`（`createEys`）、`index.d.ts`。

## 1. 背景与目标

历史实现（Phase 7 之前）在 `packages/sdk/src/replay/index.js` 顶层 `import { record } from 'rrweb'`，导致 rrweb 作为**静态依赖**被打入核心包默认入口：

- `replay:false` 时浏览器仍要下载、解压、解析、编译 rrweb（约 560 KB / gzip 118 KB），浪费带宽与 TT...；
- 核心 ESM 与基础 IIFE 都包含 rrweb，无法做到「关闭 Replay 即不下载」；
- 回放事件写入无界数组 `replayEvents`，长会话内存只增不减，无错误前 30 秒窗口保留概念；
- 回放 payload 原样上报，无压缩、无 Worker 卸载，主线程开销不可控；
- 无错误触发保留、无质量指标，难以评估回放成本与收益。

路线图 U07 明确要求：**Replay 分包与懒加载（SDK-209）+ Worker/压缩/环形缓冲（SDK-210）**。Phase 7 用「动态加载边界 + 内存有界环形缓冲 + 分层压缩」替换上述静态打包与无界数组，做到「关闭即零下载、开启才按需、内存有界、主线程低开销」。

## 2. 架构总览

```
                  createEys({ replay: true })
                          │
                          ▼
                  startCapture → startReplay()  ──(async, fire-and-forget)──┐
                          │                                                  │
                          │                          ┌──────────────────────┘
                          ▼                          ▼
                  ensureDriver({replayLibUrl})   loadRrweb() 三策略：
                          │                      1) window.rrweb?.record 直接复用（注入/自托管）
                          │                      2) await import('rrweb')      ← ESM 拆分独立 chunk
                          │                      3) injectScript(replayLibUrl) → window.rrweb  ← IIFE 自托管
                          ▼
                  setupReplayMonitor → rrweb.record(emit: queueReplay, …)
                          │
                          ▼  rrweb 事件
                  queueReplay(event) ──► ReplayRingBuffer.push(event, ts)
                          │                 (容量 maxSize + 窗口 windowMs 惰性淘汰)
                          │                 evicted>0 → diagnostic 'replay_buffer_full'
                          ▼  size>=replayBatchSize
                  flushReplay(force?)  ──► ring.take(batch) | ring.drain()
                          │
                          ▼  replayCompression
                  createReplayCompressor.compress(events)
                          ├─ Worker(replayWorkerUrl) gzip   （优先，零主线程阻塞）
                          ├─ 主线程 CompressionStream gzip  （回退）
                          └─ none (base64 UTF-8)            （无 CompressionStream 时降级）
                          │
                          ▼
                  sender.enqueue({ type:'replay', sessionId: 分段ID, events, compression, segmentEndReason? })
```

| 组件 | 职责 |
|---|---|
| `rrweb-driver.js` → `loadRrweb` / `injectScript` | rrweb 唯一动态加载边界；三策略解析 rrweb，失败时抛可读错误 |
| `replay/index.js` → `ensureDriver` / `setupReplayMonitor` / `addReplayEvent` / `takeReplaySnapshot` | 懒加载 facade；驱动未加载时 no-op 安全；幂等共享 Promise |
| `ring-buffer.js` → `ReplayRingBuffer` | 内存有界环形缓冲（容量 + 时间窗口），错误前 30 秒可恢复 |
| `compress.js` + `compression.worker.js` → `createReplayCompressor` | gzip（Worker/主线程/降级）+ base64 解码；诊断事件 |
| `vite.config.js`（es）/ `vite.iife.config.js`（iife） | ESM 拆分 rrweb chunk；IIFE 外部化 `window.rrweb` |
| `src/index.js` 接入 | `startReplay`/`stopReplayRecording`/`flushReplay` 异步化、`disposed` 竞态守卫、分段 sessionId |

## 3. 动态加载边界（SDK-209 · rrweb-driver.js）

`loadRrweb({ replayLibUrl })` 按以下顺序解析 rrweb，命中即返回：

1. **`window.rrweb?.record` 已注入**（自托管 / 第三方提前加载）→ 直接复用，不触发任何网络或拆分 chunk；
2. **动态 `import('rrweb')`** → ESM 构建下 Vite 自动将其拆分为独立 `rrweb-*.js` chunk，核心包不包含 rrweb 本体；
3. **`replayLibUrl` 脚本注入** → `injectScript(src)` 创建 `<script data-eys-replay-lib>` 并以 `load`/`error` 去重与 Promise 化，加载完成后读取 `window.rrweb`。

三者均失败则抛可读错误（`replayLibUrl load failed` / `rrweb not available`），由上层 `startReplay` 捕获并降级关闭回放（绝不抛出未处理 rejection）。

`ensureDriver` 幂等：首次调用缓存 `driver` 与 `loading` Promise，并发调用共享同一 Promise，避免重复下载。

## 4. 环形缓冲（SDK-210 · ring-buffer.js）

`ReplayRingBuffer({ maxSize = 1500, windowMs = 30000 })`：

- `push(event, ts)`：写入并（超过容量时）淘汰最旧事件，返回 `{ evicted }`；累计 `evictedTotal` 供质量指标。
- `_evictExpired(now)`：惰性按时间窗口淘汰，只有在 `take`/`drain` 时才扫描过期，避免每次写入都全量扫描。
- `drain(now)`：`force` 时取出**全部留存**（错误前 30 秒窗口），用于分段结束 / 页面退出。
- `take(count, now)`：非强制时只取前 `count` 条（增量批量），降低单次上报体积。

内存护栏保证：长会话常驻内存有界（最多 `maxSize` 条且均在 `windowMs` 内），既防止 OOM，又保证「错误发生前 30 秒」可被完整恢复。

## 5. 压缩（SDK-210 · compress.js + compression.worker.js）

`createReplayCompressor({ workerUrl, onDiagnostic })` → `{ compress(events), decompress(payload), destroy() }`：

- **优先 Worker**：提供 `replayWorkerUrl` 且环境支持 `Worker` 时，在 `compression.worker.js` 内用 `CompressionStream('gzip')` 压缩，**主线程零阻塞**。
- **主线程回退**：无 Worker 时用主线程 `CompressionStream`（Node 22 / 现代浏览器均支持）。
- **`none` 降级**：无 `CompressionStream` 时退化为 base64 UTF-8（仍可被服务端解码），并发 `replay_worker_unavailable` 诊断（仅一次，经 `warned` 标记）。
- 压缩成功发 `replay_compressed` 诊断（payload 字节数）；`flushReplay` 失败回退原样（`none`），不阻断上报。

`compress` 返回 `{ compression: 'gzip' | 'none', body: string }`，随回放事件 `item.compression` 上报，服务端按标记选择解码路径。

## 6. 异步管线与竞态守卫（SDK-209/210 接入）

- `startReplay()` / `stopReplayRecording()` / `flushReplay(force?)` 均改为 `async`；调用方**无需 await**（兼容旧代码），但内部排队而非丢调用。
- `disposed` 守卫：若 `destroy()` 与在途 `startReplay()` 竞速，`startReplay` 加载完成后立即 `stopCurrentReplay()` 并返回，避免 rrweb 内部录制定时器 / Worker 泄露。
- `destroy()` 顺序：`clearInterval` → `stopCapture` → `await stopReplayRecording` → 兜底 `stopCurrentReplay` → `replayCompressor.destroy()` → 清空 ring → `await flushAll(true)`（冲刷错误前 30 秒窗口 + 退出批次）→ `tracer?.shutdownSpans` → **最后** `multiTabLock.close()`。锁必须在所有发送之后关闭，否则 `sendExitBatch`/`flushBatch` 再次 `acquire` 会重建 BroadcastChannel。
- 分段：`endReplaySegment(reason)` 设定结束原因（`error`/`route`/`max_duration`/`page_unload`）→ 强制 flush（带原因）→ 拍全量快照 → 生成新 `currentReplaySessionId`（`_segN`），每个分段独立成一条回放记录。

## 7. 构建分包（SDK-209）

- **ESM（`vite.config.js`）**：仅 `formats: ['es']`；`import('rrweb')` 被 Vite 自动拆分为独立 `dist/rrweb-*.js` chunk。核心 `dist/web-collection-sdk.es.js` 不含 rrweb 本体，`replay:false` 时根本不请求该 chunk。
- **IIFE（`vite.iife.config.js`）**：`rollupOptions.external: ['rrweb']` + `globals: { rrweb: 'rrweb' }`，`emptyOutDir: false`（保留 es 输出）。IIFE 无法做动态 `import('rrweb')`，故 rrweb 由外部环境通过 `window.rrweb` 或 `replayLibUrl` 提供，核心 IIFE 体积显著下降（约 80 KB / gzip 25 KB）。
- **platform（`vite.platform.config.js`）**：保持独立轻量构建，不受影响。

实测：`replay:false` 时 ESM 与基础 IIFE 均**不下载、不解析、不编译** rrweb；`replay:true` 时浏览器按上述策略按需加载。

## 8. 配置项（新增 / 变更）

| 选项 | 默认值 | 说明 |
|---|---|---|
| `replay` | `true` | 是否开启会话回放；`false` 时不下载 rrweb |
| `replayLibUrl` | `''` | IIFE 自托管场景：外部化 rrweb 脚本地址，加载后暴露 `window.rrweb` |
| `replayWorkerUrl` | `''` | 压缩 Worker 脚本地址；提供则优先在 Worker 内 gzip |
| `replayCompression` | `true` | 是否对回放 payload 做 gzip（无 `CompressionStream` 自动降级 `none`） |
| `replayBufferSize` | `1500` | 环形缓冲容量（条） |
| `replayWindowMs` | `30000` | 环形缓冲时间窗口（ms），保证错误前 30 秒可恢复 |
| `replayBatchSize` | `50` | 回放事件批量上报数量 |
| `replayMaxDuration` | `60000` | 单路由页面最多录制时长（ms），`0` 表示不限制 |
| `replaySegmentByRoute` | `true` | 路由切换时自动分段 |
| `replayOptions` | `{}` | 透传给 rrweb `record` 的附加配置 |

类型变更（`index.d.ts`）：`startReplay(): Promise<void>`、`stopReplay(): Promise<void>`、`flushReplay(force?: boolean): Promise<void>`，并补全上述 replay 选项声明。

## 9. 诊断

| 诊断类型 | 触发条件 | 含义 |
|---|---|---|
| `replay_buffer_full` | 环形缓冲因容量/窗口淘汰事件 | 回放窗口被压缩，提示 `replayBufferSize`/`replayWindowMs` 是否需调大 |
| `replay_worker_unavailable` | 无 `CompressionStream` 且退化为 `none` | 压缩降级，关注主线程开销 |
| `replay_compressed` | 压缩成功 | payload 字节数，用于评估压缩收益 |

## 10. 测试

新增 `packages/sdk/test/replay.test.js`（13 例），已接入 `npm test` 并全部通过、进程干净退出：

- `ReplayRingBuffer`：容量超限淘汰 + `evictedTotal`、时间窗口惰性淘汰、`drain` 取全部 / `take` 取前 N。
- 压缩：gzip 主线程往返一致、`none` 降级 + `replay_worker_unavailable` 诊断、Worker 优先（via `MockWorker`）。
- `loadRrweb`：`window.rrweb` 复用（不触发动态 import）、`injectScript` resolve/reject、`window.rrweb` 缺失时动态 `import` 懒加载核心路径。
- `ensureDriver` 幂等且仅加载一次；`addReplayEvent` / `takeReplaySnapshot` 未加载时为安全 no-op。
- `createEys` `replay:false` 与 `replay:true` 均可构造且回放 API 完整。

> 测试环境注意：Node 22 暴露全局 `BroadcastChannel`，但其 `close()` **不会释放底层 PipeWrap**（实测仍泄漏）。集成测试在 DOM mock 中置 `BroadcastChannel: undefined`，使跨标签页锁退化为单标签页布尔守卫（SDK 既定降级路径），保证 `node --test` 干净退出。这属于测试环境适配，不改动浏览器侧行为。

## 11. 接入点

- 浏览器：`src/index.js` 的 `createEys`，回放控制 API（`startReplay` / `stopReplay` / `flushReplay` / `addReplayEvent` / `takeReplaySnapshot` / `endReplaySegment`）始终返回，受 `replay` 与同意分类 `replay` 门控。
- 类型：`index.d.ts` 声明 replay 选项与异步 replay API。
- 构建：`vite.config.js`（es）、`vite.iife.config.js`（iife 外部化）、`vite.platform.config.js`（轻量平台包）。

## 12. 验收（SDK-209 / SDK-210）

- **SDK-209**：`replay:false` 时 ESM 与基础 IIFE 均不下载/包含 rrweb（核心包 0 处 rrweb 录制内部逻辑，ES 拆分为独立 `rrweb-*.js` chunk，IIFE 仅引用外部 `rrweb` 全局）；`replay:true` 时按需加载成功（三策略均可解析）。
- **SDK-210**：错误前 30 秒可恢复（环形缓冲容量 + 30s 窗口）；长任务增量满足预算（gzip Worker 优先、主线程回退、`none` 降级，主线程零阻塞或可控）；内存有界（容量 + 窗口淘汰，`replay_buffer_full` 可观测）。
