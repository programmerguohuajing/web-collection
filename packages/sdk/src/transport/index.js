/**
 * Reliable Transport v2 模块统一出口。
 *
 * 该模块把「发送可靠性」从 `createEys` 的内部逻辑中抽离为可替换、可测试的组件：
 * - `ReliableSender`：编排热/冷队列、在线发送、退避重试、退出 Beacon 兜底与诊断。
 * - `FetchTransport` / `BeaconTransport`：实现同一 Transport 接口的两个通道。
 * - `IndexedDBQueue`：持久化冷队列（含内存降级）。
 * - `createMultiTabLock`：跨标签页单活跃发送者协调（best-effort）。
 * - `createEventId` / `computeBackoff` / `classifyResponse` / `parseRetryAfter` / `createDiagnosticSink`：
 *   可被平台层 SDK 复用的纯函数与工具。
 */
export { ReliableSender } from './sender.js'
export { FetchTransport } from './fetch-transport.js'
export { BeaconTransport } from './beacon-transport.js'
export { IndexedDBQueue } from './indexeddb-queue.js'
export { createMultiTabLock } from './multitab.js'
export { createEventId } from './id.js'
export { computeBackoff, parseRetryAfter, classifyResponse } from './retry.js'
export { createDiagnosticSink, DIAGNOSTIC_TYPES } from './diagnostics.js'
