# Reliable Transport v2 · 可靠传输设计说明

> 关联路线图：Phase 5（U05 / SDK-207 / SDK-219 / API-220）
> 实现模块：`packages/sdk/src/transport/`（诊断 `diagnostics.js`、事件 ID `id.js`、退避 `retry.js`、冷队列 `indexeddb-queue.js`、在线通道 `fetch-transport.js`、退出通道 `beacon-transport.js`、跨标签页锁 `multitab.js`、编排器 `sender.js`、barrel `index.js`）。

## 1. 背景与目标

历史实现中，发送链路存在以下问题：

- 队列直接读写 **localStorage（同步阻塞）**，刷新 / 崩溃 / 断网后事件易丢失；
- 没有超时、没有退避，遇到 408 / 429 / 5xx 只能干等或丢弃；
- `sendBeacon` 仅按 **JS 字符长度** 判断，遇到多字节（中文等）会超出 64 KiB 上限被静默丢弃，且没有鉴权、ACK 语义、幂等与失败回退；
- 多标签页同时上报，造成重复发送与带宽浪费；
- 缺少统一、可观测的传输健康诊断。

Reliable Transport v2 把「发送是否可靠」收敛到一套**热/冷队列 + 在线通道 + 退出通道 + 单发送者锁 + 诊断**的管线，做到「可恢复、可退避、可去重、可观测」。

## 2. 架构总览

```
                 ┌──────────────┐
   事件 push ──▶ │ 内存热队列    │  items[]（{id, value, retry}）
                 │ (ReliableSender)│
                 └──────┬───────┘
           镜像 / 恢复   │
                 ┌──────▼───────┐
                 │ IndexedDB    │  冷队列（崩溃/刷新/断网后可恢复）
                 │ 冷队列        │  不可用时降级为内存数组
                 └──────┬───────┘
       在线发送 ────────┤
                        │  FetchTransport（AbortController 超时 + x-app-key）
                        │  成功→出队 / retry→退避 / drop→永久丢弃
                        │
       页面退出 ────────┤
                        │  BeaconTransport（UTF-8 字节切片，非破坏性）
                        │  无 Beacon 且有 collectKey → fetch keepalive 回退
                        │
       跨标签页 ────────┘
                        MultiTabLock（BroadcastChannel 选举，单域名至多一个活跃发送者）
```

| 组件 | 职责 |
|---|---|
| `ReliableSender` | 编排热/冷队列、在线/退出发送、退避调度、单发送者锁协调、诊断分发 |
| `IndexedDBQueue` | 持久化冷队列；`isPersistent` 标识是否真用 IndexedDB，否则内存降级 |
| `FetchTransport` | 在线通道；独立 `AbortController` 超时；保留 `x-app-key`；`Retry-After` 解析 |
| `BeaconTransport` | 退出通道；UTF-8 字节切片；不含自定义 Header；非破坏性（事件保留待服务端去重） |
| `createMultiTabLock` | 跨标签页单活跃发送者（best-effort 领导者选举） |
| `diagnostics` | `onDiagnostic` 健康事件 sink（静默、不抛异常、不含业务敏感数据） |

## 3. 队列：热 + 冷

- **热队列** `items[]` 存于内存，是发送与去重的直接工作集，每条记录 `{ id, value, retry }`。
- **冷队列** `IndexedDBQueue` 异步镜像热队列，保证刷新 / 崩溃 / 断网后事件不丢。
- 启动时 `ReliableSender.ready` 从冷队列 `snapshot()` 恢复，合并未发送事件并触发 `next_session_recovered` 诊断。
- `IndexedDBQueue` 在 Node 测试 / 隐私模式 / SSR / quota 耗尽时自动降级为内存数组（`isPersistent === false`），SDK 不崩溃，仅退化为「当前会话内存」。
- `enqueue` 超出 `maxQueue` 时丢弃最旧事件并触发 `queue_full` 诊断。

> `replaceAll` 兼容两种入参形态：已是记录 `{ id, value, ts }`（sender 持久化时传入）或裸事件（测试/手动调用），避免二次嵌套 `value`。

## 4. 重试与退避（retry.js）

- `computeBackoff(attempt, { base=500, max=30000, factor=2, jitter=0.5 })`：指数退避 + **等抖动**（下限 `exp*(1-jitter)`，上限 `exp`），不超过 `max`。
- `parseRetryAfter(header, fallback)`：支持秒数（`"5"`）、HTTP-date、以及非法值时回退 `fallback`。
- `classifyResponse(status)`：
  - `success`：`2xx`；
  - `retry`：`408` / `425` / `429` / `5xx`；
  - `drop`：其余 `4xx`（契约错误，永久丢弃）。

`ReliableSender.sendBatchOnline` 的判定顺序：`timeout`/`abort`/`network` → `retry`；其余按 `classifyResponse` 分类。可重试事件递增 `retry` 计数，超过 `maxRetries` 转为 `dropped_non_retryable`（`dropped_by_sampling` 之外的另一种永久丢弃）；`429` 同时触发 `rate_limited` 诊断以便观测。退避定时器已 `unref`，不阻塞进程/Worker 退出。

## 5. 在线发送（fetch-transport.js）

- 每次发送使用**独立 `AbortController`**，支持超时中止，区分 `TimeoutError` / `AbortError` / `NetworkError`。
- 保留 `x-app-key` 自定义鉴权头（与现有后端兼容）。
- `fetchImpl` 可注入；显式传 `null` 视为不可用（走 GIF 兜底或退出通道），**不会回退到全局 `fetch`**。
- 超时定时器在 `finally` 中 `clearTimeout`，不留泄漏。

## 6. 页面退出发送（beacon-transport.js）

- **UTF-8 字节切片**（经由 `TextEncoder` → `Blob.size`，非 JS `length`），默认上限 `beaconMaxBytes = 60 KiB`。
- `sendBeacon` **不携带任何自定义 Header**（不带 `x-app-key`），符合 `sendBeacon` 规范；返回 `queued` / `rejected` / `oversize` / `fallback`。
- **非破坏性**：退出发送不把事件从队列移除，事件继续保留在持久队列，由服务端按 `eventId` 幂等去重（at-least-once 语义）。
- 单条超限（`oversize`）跳过该条并触发 `beacon_oversize`；`sendBeacon` 返回 `false` 触发 `beacon_rejected`；无 Beacon 且配置 `collectKey` 时回退 `fetch keepalive`（带 `x-app-key`）并触发 `beacon_fallback`。

## 7. 事件幂等（id.js + API-220 契约）

- 每条事件携带稳定 `eventId`：`e-${time}-${counter}-${rand}`（`crypto.getRandomValues`，不可用时 `Math.random` 兜底），在线发送与 Beacon 均携带。
- 服务端凭 `eventId` 做 at-least-once 去重（重复只入库一次）——SDK 侧契约已完成；服务端 `eventId` 入库去重与去重指标为后端 API-220 范畴。
- 区分「**已排队**（queued）」与「**服务端已摄入**（server ingested）」：Beacon 成功仅代表排队成功，最终以服务端 ACK + `eventId` 去重为准。

## 8. 跨标签页单发送者锁（multitab.js）

- 同一域名下「最多一个标签页」真正执行发送，避免多标签页重复上报（服务端 `eventId` 去重为最终防线）。
- **best-effort 领导者选举**：请求方广播 `request`，持有方回应 `held`；`timeout`（默认 120ms）内无回应即视为赢得锁。
- 不可用时（Node、隐私模式、旧浏览器）退化为同标签页内布尔守卫。
- ⚠️ **资源释放**：`createMultiTabLock` 创建的 `BroadcastChannel` 底层持有 `MessagePort`，使用方应在不再需要时调用 `close()`，否则进程/Worker 无法正常退出。

## 9. 诊断（diagnostics.js）

`createDiagnosticSink(onDiagnostic)` 暴露非敏感的传输健康事件，仅在提供回调时分发，且回调异常被吞掉不影响主流程。覆盖路线图要求的类型（含）：

`queue_full` · `rate_limited` · `timeout` · `invalid_payload` · `storage_quota` · `dropped_by_sampling` · `beacon_rejected` · `beacon_oversize` · `beacon_fallback` · `next_session_recovered` · `dropped_non_retryable` · `flush_success` · `flush_failed` · `retry` 等。

浏览器入口 `src/index.js` 与平台入口 `src/platform/core.js` 均支持 `onDiagnostic` 配置；`diagnostic` sink 同时累加 `stats.failed` 并回调用户。

## 10. 配置项（新增）

| 选项 | 默认值 | 说明 |
|---|---|---|
| `onDiagnostic` | `null` | 传输健康事件回调 |
| `transportTimeout` | `10000` | 单次在线发送超时（ms） |
| `beaconMaxBytes` | `60 * 1024` | Beacon 单批 UTF-8 字节上限 |

类型声明见 `index.d.ts`（`DiagnosticType` / `EysDiagnosticEvent` / 上述配置）与 `platform.d.ts`（`onDiagnostic`）。

## 11. 测试

新增 `packages/sdk/test/transport.test.js`（**31 例**，已接入 `npm test`，全部通过），覆盖：

- `createEventId` 格式与唯一性；
- 退避/抖动边界、`Retry-After` 解析、`classifyResponse` 三分类；
- 诊断 sink 静默与异常隔离；
- `IndexedDBQueue` 内存降级、容量丢弃、`replaceAll` 双形态；
- `FetchTransport` 成功 / 500 / 超时 / 网络错误 / 不可用（fetchImpl:null）；
- `BeaconTransport` 字节长度、成功入队、rejected、oversize、字节切片多批、fetch 回退；
- `ReliableSender` 自动 eventId、成功出队、4xx 永久丢弃、5xx 退避超限、并发单活跃发送者、退出 Beacon 非破坏性、下一会话恢复；
- `MultiTabLock` 真实 `BroadcastChannel` 竞争 + 无 Channel 退化（测试结束 `close()` 释放 MessagePort）。

## 12. 接入点

| 入口 | 接入方式 |
|---|---|
| 浏览器 `src/index.js` | `ReliableSender` + `FetchTransport` + `BeaconTransport` 编排；`push`→`enqueue`、`flush`→`sendBatchOnline`、`flushAll`→`sendExitBatch`+`flush`、退出事件→`enqueue`；`setConsent`/`setEnabled`→`clear` |
| 平台 `src/platform/core.js` | 复用 `classifyResponse` / `computeBackoff` / `createEventId` / `createDiagnosticSink` 纯逻辑；通道仍由适配器抽象，每条事件带 `eventId`，采样丢弃触发 `dropped_by_sampling` |
