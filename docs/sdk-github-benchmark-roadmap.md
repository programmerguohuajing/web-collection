# Web Collection SDK GitHub 能力对标与落地路线图

> 文档状态：可执行评审稿
> 调研日期：2026-08-11
> 适用读者：SDK 工程师、前端平台工程师、后端采集工程师、测试负责人、技术负责人
> 对标对象：开源 Web 监控、RUM、Tracing、产品分析和 Session Replay SDK

## 实施进度追踪

> 本路线图按 P0（可信）→ P1（轻量可组合）→ P2（规模化）分阶段落地。以下勾选框反映**实际开发进度**；完成的条目同时会在第 6 节（U 表）与第 8 节（Backlog）对应行以 `✅` 标注，并注明所属阶段。
> 最后更新：2026-08-12（Phase 1、Phase 2、Phase 3、Phase 4、Phase 5、Phase 6 完成）

- [x] **Phase 1 · Tracing 可信性基础**（路线图 P0 首位，已完成并通过测试）
  - [x] **U01** 自定义 Span 生命周期与异步恢复（对应 SDK-201）：`withSpan` 在同步 / 异步 resolve / reject / 异常所有路径调用 `endSpan` 弹栈；Tracer 活动栈从模块级全局改为**实例级**，修复多实例污染；`createTracer` 注册活跃 Tracer 供模块级便捷函数委托。
  - [x] **U02** TypeScript 公共契约补齐（对应 SDK-204）：`src/index.js` 通过 `export * from './trace/index.js'` 导出 tracing 公共 API；`index.d.ts` 补齐 `Span` / `Tracer` / `createTracer` / `getCurrentSpan` / `getCurrentContext` / `TraceContext` / `Sampler` 等声明，消除 runtime ↔ `.d.ts` 漂移。
  - [x] **Trace/Span 生命周期单元测试**（U15 子集）：新增 `packages/sdk/test/trace.test.js`，覆盖同步 / 异步 / 异常 / 嵌套 / 多实例 / 幂等，已接入 `npm test`，10/10 通过。
- [x] **Phase 2 · Span Processor / Exporter 闭环**（SDK-202 / API-203，已完成并通过测试）
  - [x] **SDK-202** Span Processor / Exporter：新增 `packages/sdk/src/trace/processor.js`（`BatchSpanProcessor` + `WebCollectionSpanExporter`，接口对齐 OpenTelemetry）；`Span.toExport()` 产出与后端 `normalizeSpan` 对齐的 v2 记录（epoch 时间戳、`id` 幂等去重）；`Tracer` 接入 `addSpanProcessor` / `endSpan` 通知 / `flushSpans` / `shutdownSpans`；`createEys` 新增 `spanExport` 配置（默认 `false`，0.1.x 不破坏后端），启用时派生 `/api/spans` 端点并带 `x-app-key` 鉴权；页面根 Span 在 `finalizePerformance` 经 `tracer.endSpan` 结束并导出（此前从未结束）；`flushAll(force)` / `destroy()` 冲刷 Span 缓冲。自定义 Span、自动请求 Span、根 Span 现经同一管线导出，后端调用树不再依赖 perf event「猜」Span。
  - [x] **API-203** Span Envelope v2 接收：`POST /api/spans` 兼容 v1 数组与 v2 信封 `{ schemaVersion:2, resource, spans }` 双读；非法顶层结构返回 `400 invalid_payload`、未知 `schemaVersion` 返回 `400 unsupported_schema_version`、空返回 `400 empty_payload`、超硬上限返回 `413 too_many_spans`；逐 Span 非法字段由 `normalizeSpan` 过滤并计入 `rejected`。
  - [x] **导出管线单元测试**：新增 `packages/sdk/test/exporter.test.js`，10 例覆盖 `toExport` 字段、`WebCollectionSpanExporter` v2 信封 / 错误隔离 / 空批、`BatchSpanProcessor` 达量触发 / `forceFlush` / `shutdown` / 异常不抛出、`Tracer` 经 Processor 导出自定义 Span（父子正确）、自动请求 Span 经同一 Processor 导出，已接入 `npm test`，全部通过。
- [x] **Phase 3 · 标准 W3C baggage / tracestate**（U03，SDK-205）：替换自定义 `baggage-*` Header。
  - [x] **U03** 标准 W3C 传播（对应 SDK-205）：`propagation.js` 的 `injectBaggage` 改为写入**标准单一 `baggage` Header**（`key=value` 逗号分隔、值 `encodeURIComponent`），`serializeBaggage` / `parseBaggage` 双向实现；`extractBaggage` 优先读标准 `baggage` 并向后兼容旧 `baggage-*` 多个头（过渡期）；`tracestate` 增加 `normalizeTraceState`（trim / 去空 member / 512 上限截断）。`traceOrigins` 从「仅精确字符串」扩展为支持 **string / RegExp / function** 三类匹配（`matchesTraceOrigin` + `canTrace`），非法 URL / 不匹配规则一律拒绝注入，避免配置错误向第三方泄露 baggage。`fetch.js` / `xhr.js` 复用标准 `injectBaggage` 与 `canTrace`，删除各自本地重复实现。详见 `docs/w3c-propagation.md`（含跨域 CORS 配置）。
  - [x] **互操作测试**：新增 `packages/sdk/test/propagation.test.js`（13 例），含与「OpenTelemetry 风格解析器」互操作对拍（双方都能读懂对方的标准 `baggage` 输出）、向后兼容旧头、tracestate 规范化、`traceOrigins` 三类 matcher、非法 URL 拒绝；已接入 `npm test`，全部通过。
- [x] **Phase 4 · Privacy v2 统一 sanitizer**（U04 / U11，SDK-206）。
  - [x] **U04** Privacy v2 统一 sanitizer：新增 `packages/sdk/src/core/sanitizer.js` 作为隐私清洗唯一事实来源，提供 `strict | balanced | off` 三档策略（生产默认 `balanced`）；`sanitizeEvent` 在 `balanced`/`strict` 下对事件字段键脱敏 + 值级 PII（邮箱 / 手机号 / 身份证 / 银行卡 / JWT）文本脱敏；用户手机号默认不可逆 hash（不发明文）；URL query 敏感参数剥离（strict 丢弃整个 query）；请求 / 响应头默认移除 Authorization / Cookie / Set-Cookie / Proxy-Authorization；`requestResponseSanitizer` 钩子 + body 默认脱敏；同意分类 `essential / performance / analytics / replay / diagnostics` 与 GPC / DNT 信号映射（门控回放与 body 采样）。`select` 默认仅采 `selectedIndex` / 选项数量 / 受控 `labelHash`（balanced）或仅索引与数量（strict），不采原文；点击 label / DOM 文本经同一 sanitizer 脱敏；`addReplayEvent` 自定义事件 payload 经 sanitizer 清洗。`index.d.ts` 补全 `PrivacyMode` / `ConsentCategory` / `EysPrivacyOptions` 扩展 / `getPrivacyMode` / `getConsentCategories`。详见 `docs/privacy-v2.md`。
  - [x] **U11** 请求 Body 隐私：body 采样经 `sanitizePair` 统一清洗（JSON 字段键脱敏 + 文本 PII 脱敏 + 敏感头丢弃），支持自定义 `requestResponseSanitizer`；`index.js` / `platform/core.js` 的 `push` 全面切换为 sanitizer 实例，且 `beforeSend` 后仍二次清洗。
  - [x] **隐私回归测试**：新增 `packages/sdk/test/privacy.test.js`（11 例），断言语料序列化后不含明文手机号 / 邮箱 / 密码 / token / 身份证 / 银行卡 / 敏感 query 参数，已接入 `npm test`，全部通过。
- [x] **Phase 5 · Reliable Transport v2**（U05，SDK-207 / SDK-219 / API-220）：IndexedDB 队列、退避、429/5xx、BeaconTransport、diagnostics。
  - [x] **SDK-207** IndexedDB Reliable Queue：新增 `packages/sdk/src/transport/`（诊断 `diagnostics.js`、`createEventId` `id.js`、指数退避+`Retry-After`+`classifyResponse` `retry.js`、IndexedDB 冷队列 `indexeddb-queue.js` 含内存降级、在线通道 `fetch-transport.js` 带 `AbortController` 超时、退出通道 `beacon-transport.js` UTF-8 字节切片、跨标签页单发送者锁 `multitab.js`、编排器 `sender.js` 与 barrel `index.js`）；`ReliableSender` 维护内存热队列并异步镜像 IndexedDB，刷新/崩溃/断网后可恢复（`next_session_recovered`），`queue_full` 溢出丢弃并告警。
  - [x] **SDK-219** BeaconTransport 与页面退出调度：`BeaconTransport` 按 UTF-8 **字节**（默认 60 KiB，非 JS 字符长度）切片，`sendBeacon` 无自定义 Header（不带 `x-app-key`），返回 `queued`/`rejected`/`oversize`/`fallback`；`sendExitBatch` **非破坏性**（事件保留在持久队列，由服务端按 `eventId` 幂等去重）；无 Beacon 且有 `collectKey` 时回退 `fetch keepalive`（带 `x-app-key`）。
  - [x] **API-220（SDK 侧契约）**：每条事件携带稳定 `eventId`（`e-${time}-${counter}-${rand}`），在线发送与 Beacon 均携带，支持服务端 at-least-once 幂等去重；在线 `classifyResponse` 区分 `success`/`retry`(408/425/429/5xx)/`drop`(其余 4xx)，重试走指数退避+抖动并遵守 `Retry-After`，超 `maxRetries` 永久丢弃（`dropped_non_retryable`）；`onDiagnostic` 暴露 `queue_full`/`rate_limited`/`timeout`/`invalid_payload`/`storage_quota`/`dropped_by_sampling`/`beacon_rejected`/`beacon_oversize`/`beacon_fallback` 等健康事件。服务端 `eventId` 入库去重为后端 API-220 范畴，契约已对齐。
  - [x] **传输层单元测试**：新增 `packages/sdk/test/transport.test.js`（31 例），覆盖 `createEventId`/`computeBackoff`/`parseRetryAfter`/`classifyResponse`/诊断/`IndexedDBQueue`（内存降级、容量、replaceAll 双形态）/FetchTransport（成功、500、超时、网络错误、不可用）/BeaconTransport（字节长度、成功、rejected、oversize、字节切片、fetch 回退）/ReliableSender（自动 eventId、成功出队、4xx 丢弃、5xx 退避超限、并发单活跃发送者、退出 Beacon 非破坏性、下一会话恢复）/MultiTabLock（真实 BroadcastChannel 竞争 + 无 Channel 退化），已接入 `npm test`，全部通过。
- [x] **Phase 6 · 确定性采样**（U06，SDK-208）：新增 `src/sampling/`（哈希原语 + `DeterministicSampler`），基于 traceId/sessionId 的哈希一致性采样、优先级保留错误链路、分类子采样（不破坏 trace）、远端权重、可解释决策与 `dropped_by_sampling` 诊断、`getSamplingDecision()` 自查；浏览器/平台入口与 tracer 接入。
- [ ] **Phase 7 · Core / Replay 分包与懒加载**（U07，SDK-209 / SDK-210）。
- [ ] **其余 P1 / P2 与 Week 5–12 里程碑**：按计划推进（见第 7 节）。

## 0. 如何使用本文件

- 技术负责人：先读第 1、5、7、10 节，用于确认投资顺序、团队配置、版本和回滚策略。
- SDK/采集工程师：重点读第 3.2、5、6、8 节，可直接将 `SDK-*`、`API-*` 条目拆入迭代。
- 测试负责人：重点读第 9、13 节，将资源、数据质量、隐私和浏览器兼容指标转成发布门禁。
- 产品/平台负责人：重点读第 4、5.3、11 节，明确哪些能力要补、哪些只做关联、哪些不应扩张。
- 本文给出的工作量是工程估算，不替代 Sprint Planning；进入排期前需由对应 Owner 对依赖和历史兼容数据再做一次校准。

## 1. 结论先行

Web Collection SDK 已经不是“只有埋点”的早期 SDK。当前代码同时覆盖错误、Web 性能、请求、行为、曝光、日志、会话回放、前端链路上下文、运行环境和多端适配，配套平台还具备错误聚合、源码映射、发布版本、会话、路径、热力图、漏斗、告警和分布式调用树。这种“采集 + 分析 + 自托管”的组合，是相对只做单一采集能力的开源项目的真实优势。

但当前最需要做的不是继续横向增加采集事件，而是把已经对外暴露的能力做成可信的工程产品。源码审计确认，至少有以下 P0 问题：

1. 自定义 Span 有运行时 API，但 Span 对象本身没有稳定的结束回调和独立导出管线；`withSpan()` 结束 Span 后没有从活动栈移除，异步并发上下文也不能可靠隔离。
2. `distributedTracing`、`baggage`、`startSpan()`、`withSpan()`、`getCurrentSpan()` 已在运行时出现，但没有同步进入 `index.d.ts`，存在“代码能调用、TypeScript 不允许”的契约漂移。
3. `traceparent` 基本符合 W3C Trace Context；但 baggage 使用多个自定义 `baggage-*` Header，而不是标准 `baggage` Header，跨厂商互操作性不足。
4. 输入框采集只记录长度和次数，隐私策略正确；但下拉框仍采集原始 `selectedValue` 和 `selectedText`，基础事件还直接携带 `userPhone`，隐私模型不一致。
5. 发送队列使用同步 `localStorage`，重试没有指数退避、抖动、`Retry-After`、请求超时和丢弃原因回调；当前虽在 `force=true`、无 `collectKey` 且载荷长度小于约 64 KB 时尝试 `sendBeacon`，但尚未处理字节级切片、鉴权兼容、幂等去重、Beacon 返回 `false`、无服务端 ACK 和失败回退，在弱网、高频事件、多标签页及页面退出场景下可靠性仍不足。
6. rrweb 被静态打入默认包。当前构建产物约为 ESM 494 KB、IIFE 230 KB（未压缩文件大小），即使业务不开启回放，也需要承担解析和下载成本。
7. Web Vitals 仍采集已逐步退出核心指标体系的 FID，缺少 BFCache、预渲染、SPA soft navigation、LoAF 等现代页面生命周期和卡顿诊断。
8. SDK 测试集中在单模块行为，Tracing、Replay、隐私、队列恢复、页面生命周期和浏览器兼容缺少系统性端到端门禁。
9. `tracing` 与 `distributedTracing` 的职责重叠但语义不同；网络拦截器也没有形成完整的 disposer，销毁或创建多个实例时可能遗留 fetch/XHR patch 和监听器。

因此建议采用以下顺序：

- 第 1 阶段先做“可信”：Span 生命周期与导出、类型契约、W3C 传播、隐私基线、发送可靠性。
- 第 2 阶段再做“轻量且可组合”：核心包拆分、Replay 懒加载、插件化 Instrumentation/Transport/Exporter。
- 第 3 阶段做“开放生态”：OTLP Exporter、框架集成、远程配置、现代 Web 性能、错误质量提升。
- 产品分析类能力只补“可观测性关联”所需的 feature flag / experiment / business context，不建议把 SDK 扩张成完整的 PostHog 替代品。

在 2 名 SDK 工程师、1 名采集后端工程师、1 名 Web/QA 工程师可并行投入的前提下，P0 可在 4 周内闭环，核心架构升级可在 12 周内完成首个稳定版本。

## 2. 调研范围与判断规则

### 2.1 项目筛选

下表数据通过 GitHub API 在 2026-08-11 获取。Star 只用于说明社区规模，不作为技术质量评分；许可显示为 `NOASSERTION` 的项目必须在复用代码前单独核对各包许可证。

| 项目 | 调研快照 | 主要定位 | 本次重点借鉴 |
|---|---:|---|---|
| [getsentry/sentry-javascript](https://github.com/getsentry/sentry-javascript) | 8,716 stars，MIT | 错误、Tracing、Replay、Profiling | 错误质量、Integration 架构、数据控制、发布兼容 |
| [DataDog/browser-sdk](https://github.com/DataDog/browser-sdk) | 397 stars，Apache-2.0 | RUM、日志、Replay | 分层采样、隐私默认值、RUM 与后端 Trace 关联 |
| [open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js) | 3,434 stars，Apache-2.0 | 厂商中立的 Trace/Metrics SDK | Context、Processor、Exporter、Resource、OTLP |
| [open-telemetry/opentelemetry-js-contrib](https://github.com/open-telemetry/opentelemetry-js-contrib) | 915 stars，Apache-2.0 | Browser/Node Instrumentation | fetch、XHR、document load、user interaction 插件化 |
| [elastic/apm-agent-rum-js](https://github.com/elastic/apm-agent-rum-js) | 302 stars，MIT | 浏览器 APM/RUM | 页面加载、SPA、User Timing、标准分布式追踪 |
| [grafana/faro-web-sdk](https://github.com/grafana/faro-web-sdk) | 1,118 stars，Apache-2.0 | 可组合的前端可观测 SDK | Core、Instrumentation、Transport、Tracing 分包 |
| [PostHog/posthog-js](https://github.com/PostHog/posthog-js) | 580 stars，许可需按包核对 | 产品分析、Autocapture、Replay、Feature Flag | 业务上下文、功能开关关联、远程配置和产品化体验 |
| [rrweb-io/rrweb](https://github.com/rrweb-io/rrweb) | 20,024 stars，MIT | DOM 录制与回放引擎 | 插件、分页加载、实时回放、Canvas、存储优化 |
| [highlight/highlight](https://github.com/highlight/highlight) | 9,363 stars，许可需按目录核对 | 开源全栈监控 | Replay + Error + Log + Trace 关联、隐私分级、网络净化 |

### 2.2 判断口径

- `完整`：SDK 有公开配置或 API、实际采集/发送链路、类型声明和基本测试。
- `部分`：已有采集代码或平台展示，但契约、兼容性、可靠性、隐私或测试仍不完整。
- `缺失`：源码中没有可供业务稳定使用的实现。
- 对竞品只采用官方仓库或官方文档作为证据；营销页能力不直接等同于开源 SDK 已实现。
- OpenTelemetry 浏览器能力仍被官方标为 experimental，建议采用其标准和组件边界，不建议在本项目中原样替换全部采集代码。

## 3. 当前 SDK 能力基线

### 3.1 已具备能力

| 能力域 | 当前实现 | 结论 |
|---|---|---|
| 公共 API | `track`、`error`、`metric`、`log`、用户/上下文、Breadcrumb、Transaction、Replay 控制 | 完整度较高 |
| 错误 | `window.error`、资源加载错误、`unhandledrejection`、Worker/SSE/WebSocket/请求错误 | 已具备基础采集，错误语义需升级 |
| 性能 | Navigation Timing、FP/FCP/LCP/FID/INP/CLS、Long Task、TBT、TTI 估算、Resource、内存、Bundle、Server-Timing | 覆盖面广，现代生命周期与准确性需升级 |
| 网络 | fetch、XHR、WebSocket、SSE、状态码、耗时、响应大小、请求体采样、允许名单 | 已具备，隐私与 GraphQL/超时/取消语义需加强 |
| 行为 | PV、路由、点击、滚动、曝光、表单、愤怒点击、声明式死点击、剪贴板、下载、选择、输入元数据、键盘、触摸 | 覆盖面领先，但默认隐私规则不统一 |
| Replay | rrweb、输入遮盖、屏蔽/忽略选择器、路由/错误分段、自定义事件、全量快照 | 已可用，需懒加载、采样和性能治理 |
| Tracing | 页面 Trace、请求 Span ID、父子关系、`traceparent`、Trace Origins、分布式调用树 | 请求级链路可用；通用 Span 能力仍是“部分” |
| 隐私与治理 | consent、enabled、beforeSend、字段脱敏、请求允许名单、分类采样 | 有基线，缺少分类同意、GPC/DNT、统一敏感字段策略 |
| 发送 | 批量、定时刷新、sendBeacon、keepalive、失败重试、localStorage 恢复、GIF 降级 | 有基线，弱网可靠性和可观测性不足 |
| 多端 | Web、Vue 插件、小程序、uni-app、Taro、React Native 适配入口 | 是本项目差异化优势 |
| 配套平台 | 事件、错误、日志、Trace、Replay、会话、路径、版本、告警、热力图、漏斗 | 自托管一体化优势明显 |

### 3.2 源码证据与已确认边界

| 结论 | 源码证据 |
|---|---|
| SDK 当前版本为 0.1.16 | `packages/sdk/package.json`、`packages/sdk/src/core/event.js` |
| rrweb 为静态依赖并进入默认入口 | `packages/sdk/src/replay/index.js` 被 `packages/sdk/src/index.js` 静态导入 |
| 请求 Trace 通过 fetch/XHR 自动创建 | `packages/sdk/src/performance/fetch.js`、`xhr.js` |
| 自定义 Span 未独立发送 | `Span.toJSON()` 存在，但 `createEys()` 的统一 `push()` 没有 Span Processor/Exporter 接入 |
| `withSpan()` 活动栈清理不完整 | `packages/sdk/src/trace/tracer.js` 只调用 `span.end()`，没有调用 `endSpan(span)` |
| baggage 不是标准 Header | `packages/sdk/src/trace/propagation.js` 使用 `baggage-<key>` |
| TypeScript 与运行时不一致 | `packages/sdk/src/index.js` 暴露 Span API，`packages/sdk/index.d.ts` 未声明 |
| 输入内容默认被 rrweb 遮盖 | `packages/sdk/src/replay/index.js` 设置 `maskAllInputs: true` |
| 输入行为不采原始值 | `packages/sdk/src/behavior/input.js` 只采集时长、次数和值长度 |
| 选择行为采集原始值和文本 | `packages/sdk/src/behavior/advanced.js` 上报 `selectedValue`、`selectedText` |
| 队列使用 localStorage，重试较简单 | `packages/sdk/src/index.js` 的 `flush()`、`saveQueue()`、`loadQueue()` |
| 测试覆盖仍偏单模块 | `packages/sdk/test/` 目前为 7 个测试文件，Trace 仅有请求链路用例，Replay 无专项用例 |

## 4. 能力对标矩阵

这张表不强行让每个项目覆盖所有领域，而是标出每个能力最值得参考的实现。

| 能力维度 | Web Collection 当前状态 | 领先参考 | 差距判断 |
|---|---|---|---|
| JS/资源/Promise 错误 | 部分 | Sentry、Datadog、Highlight | 缺少完整异常链、handled/mechanism、第三方帧过滤和高级分组语义 |
| Source Map 与发布关联 | 部分，平台已有上传和发布 | Sentry、PostHog | 需引入 Debug ID/构建产物校验，减少仅靠文件名匹配的不确定性 |
| Web Vitals/RUM | 较强但需现代化 | Datadog、Elastic、Faro | 需移除核心决策对 FID 的依赖，补 BFCache、预渲染、soft navigation、LoAF |
| 请求采集 | 较强 | Datadog、Highlight | 缺 GraphQL operation、可编程 request/response sanitizer、取消请求去噪 |
| W3C 分布式追踪 | 部分 | OpenTelemetry、Elastic、Faro | `traceparent` 已有；Context、标准 baggage/tracestate、Exporter 尚未闭环 |
| 通用自定义 Span | 部分且有生命周期缺陷 | OpenTelemetry、Sentry | 需要 Processor/Exporter 和可靠异步上下文，不能只返回 Span 对象 |
| Session Replay | 可用 | rrweb、Sentry、Datadog、Highlight | 需懒加载、差异化采样、压缩、Worker、Canvas/iframe 策略和回放质量指标 |
| Replay 隐私 | 有输入遮盖 | Sentry、Datadog、Highlight | 需统一严格/默认/关闭分级，并覆盖文本、图片、选择框、网络体和自定义事件 |
| 行为 Autocapture | 较强 | PostHog | 需稳定元素指纹、文本隐私、业务事件治理和版本化 schema |
| Feature Flag/实验上下文 | 缺失 | PostHog | 建议只采集 flag key/variant，服务于错误、性能、Replay 对比 |
| 插件/Integration 架构 | 缺失 | Sentry、Faro、OpenTelemetry | 当前 `createEys()` 集中装配，难以按需裁剪和第三方扩展 |
| Transport/Exporter | 部分 | Faro、OpenTelemetry | 需要可替换 Transport、OTLP、自托管协议和测试 Exporter |
| 远程配置/kill switch | 缺失 | PostHog、Sentry/Datadog 产品实践 | 需要签名配置、缓存、TTL、失败回退，支持紧急停采和动态采样 |
| 采样 | 部分 | Datadog、Highlight、OpenTelemetry | 当前会话/事件随机采样不能保证 Trace 一致性，缺错误触发 Replay 和速率限制 |
| SDK 自监控 | 部分，有 `sdk_health` | Sentry、Datadog | 需暴露丢弃原因、队列水位、传输耗时、限流、配置版本和诊断回调 |
| 离线与弱网 | 部分，已有受限 `sendBeacon` | 成熟 RUM SDK 通用实践 | 缺 IndexedDB、退避、超时、多标签页协调，以及 Beacon 专用切片、鉴权、幂等和回退策略 |
| 框架集成 | Vue 安装入口，多端适配 | Sentry、Faro、Elastic | 需 React/Vue Router/Next/Nuxt 的路由名、Error Boundary、组件上下文集成 |
| 开放标准互操作 | 较弱 | OpenTelemetry、Faro | 专有事件模型强绑定后端，缺 OTLP 和语义约定映射 |

## 5. 应新增哪些能力

### 5.1 P0：先补可信性，不增加新的默认采集面

#### A. Tracing v2：Span Processor + Exporter

目标不是再增加一个 `traceId` 字段，而是让每个 Span 都能可靠结束、序列化、采样和发送。

建议接口：

```ts
interface SpanProcessor {
  onStart(span: ReadableSpan): void
  onEnd(span: ReadableSpan): void
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

interface SpanExporter {
  export(spans: ReadableSpan[]): Promise<ExportResult>
}
```

落地要求：

- `Span.end()` 只能执行一次，并通知 Processor；`withSpan()` 必须在同步、Promise resolve/reject、thenable 和异常路径都恢复父上下文。
- 先提供 `WebCollectionSpanExporter`，批量写入现有 `/api/spans`；再提供可选 `OTLPHttpSpanExporter`。
- 自动请求 Span、页面根 Span、自定义 Span 走同一模型，避免平台用 perf event“猜”Span。
- 使用确定性 trace 采样；一个 trace 内父子 Span 必须保持一致采样决定。
- 浏览器异步上下文优先评估 OpenTelemetry Context API/ZoneContextManager；不直接依赖模块级全局栈处理并发 Promise。

#### B. Event Envelope v2 与契约版本

统一事件头，事件体按 signal 分型，服务端支持 v1/v2 双读。

```ts
interface EnvelopeV2 {
  schemaVersion: 2
  eventId: string
  sentAt: number
  resource: {
    appId: string
    release: string
    environment: string
    sdkName: string
    sdkVersion: string
  }
  session?: { id: string; deviceId?: string; sampled: boolean }
  trace?: { traceId: string; spanId?: string; parentSpanId?: string; flags?: string }
  signal: 'error' | 'metric' | 'log' | 'event' | 'replay' | 'span'
  payload: unknown
}
```

收益：字段取值路径稳定、后端无需大量 snake/camel 和历史字段 fallback、未知协议可显式拒绝并报警，避免页面把契约错误展示成“暂无数据”。

#### C. Privacy v2

- 建立 `strict | balanced | off` 三档策略，生产环境默认 `balanced`。
- 默认不发送 `userPhone` 明文；提供 `user.id`、不可逆 hash 或业务侧 token 化方式。
- `select` 默认只采 `selectedIndex`、选项数量和受控 label hash，不采原文。
- 点击 label、DOM 文本、自定义事件、URL query、Headers、request/response body 全部走同一个 sanitizer。
- 增加 `requestResponseSanitizer(pair)` 和 `drop` 能力，默认移除 Authorization、Cookie、Set-Cookie、Proxy-Authorization。
- 支持 consent category：`essential`、`performance`、`analytics`、`replay`、`diagnostics`；支持 GPC/DNT 策略映射。
- 增加隐私回归测试，断言 payload 中不存在手机号、邮箱、密码、token、输入值和被 block 的 DOM。

#### D. Reliable Transport v2

- 将队列从同步 localStorage 迁移为内存热队列 + IndexedDB 冷队列；localStorage 只保留轻量会话标识和迁移标记。
- 指数退避 + jitter，识别 408/429/5xx，遵守 `Retry-After`；4xx 契约错误进入不可重试丢弃原因。
- 每次常规发送有 AbortController 超时；网络恢复时唤醒；页面退出、隐藏或冻结时使用 `sendBeacon`/`fetch keepalive` 的受限批次。
- 单域名最多一个活跃发送者，可用 BroadcastChannel/锁避免多标签页重复上报。
- 支持可选 gzip/compression stream；对 Replay 采用独立队列、批量大小和优先级。
- 对外提供 `onDiagnostic(event)`，事件至少包含 `queue_full`、`rate_limited`、`timeout`、`invalid_payload`、`storage_quota`、`dropped_by_sampling`、`beacon_rejected`、`beacon_oversize` 和 `beacon_fallback`。

##### sendBeacon 页面退出与弱网上报通道

`sendBeacon` 应作为页面退出阶段的“尽力排队”通道，而不是替代常规 fetch Transport。它不能设置自定义 Header、不能读取响应状态，返回 `true` 也只代表浏览器接受排队，并不代表采集服务已经成功入库。因此必须和事件幂等、持久队列及回退策略一起设计。

建议发送决策：

```text
常规在线发送
  -> fetch + AbortController + ACK

pagehide / visibility hidden / freeze / destroy
  -> 同源或支持 Beacon 鉴权：sendBeacon
       -> 返回 true：事件保留为可重试状态，服务端按 eventId 幂等去重
       -> 返回 false：立即尝试 fetch keepalive
  -> 必须使用自定义 Header：fetch keepalive
  -> 两者不可用或失败：保留 IndexedDB，下一会话恢复发送
```

具体实现要求：

- 新增独立 `BeaconTransport`，与 `FetchTransport` 实现相同的 Transport 接口，由生命周期调度器选择，避免继续把条件分支堆在 `flush()` 中。
- 监听 `pagehide`、`visibilitychange` 和 `freeze`；`pagehide.persisted=true` 的 BFCache 页面只做安全 flush，不销毁观察器，恢复时不得重复 patch。
- 使用 `TextEncoder` 或 `Blob.size` 按 UTF-8 字节切片，单个 Beacon 批次默认不超过 60 KiB，并允许配置更小上限；不能继续使用 JavaScript 字符串长度判断字节数。
- 优先发送错误、未结束 Trace 的已结束 Span、关键业务事件和 SDK diagnostics；Replay 使用独立批次，超大快照不得挤占错误事件。
- 所有事件必须有稳定 `eventId`。Beacon 返回 `true` 后不将本地事件直接视为“服务端已确认”，下次常规发送允许重试，由服务端通过 `eventId` 和 TTL 去重，实现 at-least-once 而不是静默丢失。
- `sendBeacon` 不能携带当前的 `x-app-key` 自定义 Header。首选同源采集代理；跨域场景使用写入 Envelope 的短期受限 Beacon Token，并限制 app、origin、有效期和写入权限。不得把长期 `collectKey` 放入 URL query、Referer 或日志。
- 若服务端暂不支持 Beacon Token，配置了 `collectKey` 时继续使用 `fetch(..., { keepalive: true })`；该兼容限制必须在 README 和 diagnostics 中可见。
- Beacon 端点需要接受适合退出阶段的简单 Content-Type，并完成与普通采集端点相同的 schema 校验、限流、脱敏和幂等入库。
- 统计 `beacon_attempted`、`beacon_queued`、`beacon_rejected`、`keepalive_fallback`、`next_session_recovered`、`server_deduplicated` 和各类载荷字节数，不能把 `sendBeacon() === true` 直接计为发送成功。
- 自动化覆盖 API 不存在、返回 `false`、载荷超限、中文多字节、跨域、鉴权、BFCache、离线退出、下一会话恢复和重复入库场景。

### 5.2 P1：轻量、可组合、可互操作

#### E. Core/Integration 分包与懒加载

建议包结构：

```text
@web-collection/core              # API、Envelope、Scope、Transport，零 DOM 录制依赖
@web-collection/browser           # error/performance/behavior 默认组合
@web-collection/tracing           # Span、Context、W3C propagation
@web-collection/replay            # rrweb，按需 dynamic import
@web-collection/otel-exporter     # OTLP HTTP exporter
@web-collection/vue               # Vue error/router/component context
@web-collection/react             # ErrorBoundary/router/profiler context
```

兼容期内保留 `@web-collection/sdk` 聚合包。`replay: false` 时不得下载和解析 rrweb；`startReplay()` 首次调用时再动态加载。

##### IIFE 产物与加载规则

IIFE 分包必须同时满足“默认下载体积下降”和“现有单 script 接入可迁移”两个目标。默认发布物采用基础 IIFE + 可选 Integration IIFE；另行提供 full 单文件兼容包。不能把所有能力仍打入一个文件后，仅通过 `if (replay)` 跳过运行，因为这种方式不会减少网络下载、解压、解析和编译成本，不属于真正的懒加载。

建议产物：

```text
dist/
├─ web-collection-sdk.iife.js
├─ web-collection-replay.iife.js
├─ web-collection-vue.iife.js
├─ web-collection-react.iife.js
├─ web-collection-otel-exporter.iife.js
├─ web-collection-sdk.full.iife.js
└─ integration-manifest.json
```

| 文件 | 包含能力 | 默认下载 | 定位 |
|---|---|---:|---|
| `web-collection-sdk.iife.js` | Core、Browser 默认错误/性能/行为、Transport、轻量 W3C Tracing | 是 | 推荐生产入口，不包含 rrweb 和框架专用代码 |
| `web-collection-replay.iife.js` | rrweb、Replay Recorder、Replay 专用队列与 Transport | 否 | `replay:true` 或首次 `startReplay()` 时加载 |
| `web-collection-vue.iife.js` | Vue error handler、Router、组件上下文 | 否 | Vue 项目按需加载 |
| `web-collection-react.iife.js` | ErrorBoundary、Router、Profiler 上下文 | 否 | React 项目按需加载 |
| `web-collection-otel-exporter.iife.js` | OTLP HTTP Span Exporter | 否 | 需要对接 OTel Collector 时加载 |
| `web-collection-sdk.full.iife.js` | 基础 SDK 与所有官方 Integration | 否 | 单文件、内网、严格部署限制和旧接入兼容；不具备下载级懒加载收益 |
| `integration-manifest.json` | 文件 URL、版本、字节数、SRI、兼容范围 | 按发布工具读取 | 自动加载、完整性校验和诊断依据 |

轻量 Trace Context、fetch/XHR 自动 Span 和 W3C propagation 暂时保留在基础 IIFE，因为分布式调用树是核心能力；OTLP Exporter 和框架专用 Tracing 单独分包。如果基础包超过预算，再通过真实业务使用率决定是否把完整 Tracing 独立为 `web-collection-tracing.iife.js`，不能只为文件数量而拆分。

默认接入仍只要求业务引用一个文件：

```html
<script src="https://cdn.example.com/web-collection/0.2.0/web-collection-sdk.iife.js"></script>
<script>
  const client = WebCollection.createEys({
    appId: 'web-app',
    replay: false
  })
</script>
```

此时浏览器只能请求基础 IIFE，不得请求 Replay、Vue、React 或 OTLP 文件。

开启 Replay 时，业务仍可只引用基础入口，由 SDK 的 IIFE loader 再加载 Replay：

```html
<script src="https://cdn.example.com/web-collection/0.2.0/web-collection-sdk.iife.js"></script>
<script>
  const client = WebCollection.createEys({
    appId: 'web-app',
    replay: true,
    assetsBaseUrl: 'https://cdn.example.com/web-collection/0.2.0/'
  })
</script>
```

IIFE 加载路径不依赖业务构建器处理 ESM dynamic import，而是由基础 SDK 创建受控 `<script>`，加载 `web-collection-replay.iife.js`。扩展文件加载后通过全局注册表安装自身：

```js
WebCollection.registerIntegration({
  name: 'replay',
  version: '0.2.0',
  coreVersionRange: '^0.2.0',
  setup(client, options) {
    // 安装 Replay Integration，并返回 disposer
  }
})
```

加载器必须满足：

- 同一 URL 和 Integration 的并发加载合并为一个 Promise，禁止插入多个重复 script。
- 注册和 setup 幂等；`destroy()` 后 disposer 必须完整释放监听器、rrweb recorder 和队列资源。
- 校验 `version` 与 `coreVersionRange`。版本不兼容时拒绝安装并产生 `integration_version_mismatch`，不能静默运行。
- `assetsBaseUrl` 必须显式可配置，不能只通过猜测当前 script URL 定位 CDN；同时允许每个 Integration 覆盖 `url`。
- 版本化 CDN 目录使用不可变缓存；`integration-manifest.json` 提供真实文件、字节数、hash、SRI 和兼容范围。
- 加载失败只关闭对应 Integration，错误、性能、日志和基础 Trace 必须继续工作，并产生 `integration_load_failed` diagnostics。
- 支持超时、重试上限和失败缓存；离线时不做重试风暴，网络恢复后按策略重试。
- 调用 `startReplay()` 时如果文件仍在加载，应返回同一个 Promise；推荐将类型升级为 `startReplay(): Promise<void>`，兼容期内允许旧代码不 `await`，但内部必须排队而不是丢调用。

严格 CSP 或不允许动态插入 script 的应用可以显式加载：

```html
<script src="/sdk/0.2.0/web-collection-sdk.iife.js"></script>
<script src="/sdk/0.2.0/web-collection-replay.iife.js"></script>
```

并配置：

```js
WebCollection.createEys({
  replay: true,
  integrations: {
    replay: { load: 'manual' }
  }
})
```

自动 script loader 必须支持 CSP nonce、SRI 和跨域属性：

```js
WebCollection.createEys({
  replay: true,
  integrations: {
    nonce: window.__CSP_NONCE__,
    replay: {
      load: 'lazy',
      url: 'https://cdn.example.com/web-collection/0.2.0/web-collection-replay.iife.js',
      integrity: 'sha384-...',
      crossOrigin: 'anonymous'
    }
  }
})
```

`web-collection-sdk.full.iife.js` 继续支持原有单文件方式：

```html
<script src="https://cdn.example.com/web-collection/0.2.0/web-collection-sdk.full.iife.js"></script>
```

full 版本的规则是：

- 不再额外请求官方 Integration 文件，所有内置 Integration 仍通过相同注册表安装，避免维护两套运行时。
- `replay:false` 只阻止 Replay 执行，不能减少 full 文件的下载和解析体积；README 和构建报告必须明确提示。
- full 与基础 IIFE 暴露相同 `WebCollection` 公共 API，事件协议、类型和默认隐私策略必须一致。
- 页面不得同时加载基础 IIFE 和 full IIFE；检测到重复 Core 时给出 `duplicate_core` diagnostics，不能重复 patch 浏览器 API。

IIFE 分包验收标准：

- `replay:false` 的浏览器 Network 记录只有基础 IIFE，产物内容扫描确认不存在 rrweb recorder 代码。
- `replay:true` 只额外请求一次 Replay IIFE；首次加载完成后能录制、分段、发送和销毁。
- 自动加载、手动加载和 full 单文件三种模式产生等价的 Replay/Trace 事件协议。
- Integration 404、超时、SRI 失败、版本不匹配和离线时，基础 SDK 不崩溃且 diagnostics 原因准确。
- CSP nonce、SRI、跨域 CDN、强缓存更新、多实例和重复 script 场景有浏览器自动化测试。
- 每次发布输出基础、各 Integration 和 full 文件的 raw/gzip/brotli 大小；任何预算回归使 CI 失败。
- npm ESM 和 CDN IIFE 使用同一 Integration 接口与兼容矩阵，不允许两条产品线能力漂移。

#### F. Performance v2

- Web Vitals 实现对齐 `web-vitals` 最新语义，核心看 LCP、INP、CLS；FID 只作为兼容字段。
- 处理 BFCache restore、prerender activation、visibility/pagehide、前后台切换和页面冻结。
- 引入 SPA soft navigation/route transaction，输出 route name、route render、数据就绪和交互归因。
- 增加 Long Animation Frame（LoAF）及脚本归因；不支持时回退 Long Task。
- 支持 User Timing `mark/measure` 白名单转 Span/Metric。
- 修正 Resource Timing 阶段计算，TTFB 使用阶段差值，区分 cache/service worker/protocol。
- 每项指标带 `rating`、`navigationType`、`metricId`、`delta` 和 attribution。

#### G. Error v2

- 结构化异常链：`cause`、AggregateError、DOMException、Promise reason、handled、mechanism。
- 统一 Stack Frame 解析，区分 in-app/third-party；支持 allow/deny URLs 和重复扩展噪音过滤。
- 构建时生成 Debug ID，Source Map 上传校验 release、dist、debugId 和产物 hash。
- 错误指纹允许业务覆盖；保留原始指纹版本，避免规则变化后历史 Issue 无法追溯。
- 错误与 Replay、Trace、release、feature flags、最近网络请求和 Breadcrumb 双向关联。

#### H. 可观测性业务上下文

只增加关联能力，不实现完整产品分析平台：

```ts
client.setFeatureFlag('checkout-v2', 'variant-b')
client.setExperiment('pricing-test', 'control')
client.setView({ name: 'Checkout', route: '/checkout/:id' })
```

这些字段进入错误、Span、RUM 和 Replay 索引，用于回答“某个灰度版本是否导致错误率/LCP 上升”。不要在 SDK 中实现 Feature Flag 计算引擎和实验分流后台。

### 5.3 P2：规模化运营能力

- 远程配置：采样率、模块开关、URL 过滤、紧急停采；必须签名校验、TTL、缓存和失败回退。
- 框架 Integration：Vue/React Router 路由命名、Error Boundary、组件栈、SSR hydration、Next/Nuxt 页面生命周期。
- ReportingObserver：deprecation、intervention、CSP violation；默认低采样并有 allowlist。
- Replay 增强：错误前环形缓冲、错误触发升采样、Canvas/iframe 显式 opt-in、录制质量和丢帧指标、分页加载。
- SDK 自诊断页：展示当前配置版本、采样决定、队列水位、最近一次发送结果、被过滤原因；仅开发环境或授权用户可打开。
- 可选 UI Profiling：先采 LoAF/React Profiler 聚合，不在当前 12 周内自研完整连续性能剖析器。

## 6. 哪些现有能力需要优化升级

| 编号 | 现有能力 | 具体问题 | 升级方案 | 优先级 |
|---|---|---|---|---|
| U01 ✅ | 自定义 Span | 无独立导出；活动栈清理不完整；并发异步上下文不可靠（Phase 1 已修复活动栈清理与多实例隔离；Phase 2 已补齐 Processor/Exporter 导出管线，Span 经 `/api/spans` 闭环） | Processor/Exporter + Context Manager + 生命周期测试 | P0 |
| U02 ✅ | 类型声明 | 运行时 API/配置未全部声明（Phase 1 已在 index.d.ts 补齐 tracing 公共 API 声明） | 从同一 TS source 生成 runtime 和 `.d.ts`，增加 API Extractor diff 门禁 | P0 |
| U03 ✅ | W3C 传播 | baggage 使用非标准 Header；traceOrigins 只支持精确字符串（Phase 3 已改为标准单一 `baggage` Header，traceOrigins 支持 string/RegExp/function matcher） | 标准 `baggage`/`tracestate`，支持 string/RegExp/function matcher | P0 |
| U04 ✅ | 隐私 | select/点击文本/用户手机号/网络体策略不一致（Phase 4 已落地统一 sanitizer、默认 balanced、手机号不可逆 hash、select 不采原文、body 默认脱敏） | Privacy v2、统一 sanitizer、默认最小化采集 | P0 |
| U05 ✅ | 发送队列 | localStorage 同步阻塞；无超时/退避/429；现有 sendBeacon 仅按字符长度判断，缺鉴权、ACK 语义、幂等和失败回退（Phase 5 已落地 Reliable Transport v2：IndexedDB 冷队列 + 内存热队列、AbortController 超时、指数退避+Retry-After、429/5xx 识别、BeaconTransport UTF-8 字节切片与非破坏性退出、eventId 幂等、onDiagnostic 健康事件） | Reliable Transport v2 + BeaconTransport + 服务端 eventId 去重 | P0 |
| U06 ✅ | 采样 | 会话和事件随机决策，Trace/Replay 关联可能断裂（Phase 6 已落地 `src/sampling/`：traceId/sessionId 哈希一致性采样、父子 Span 同决策、错误链路优先级保留、分类子采样不破坏 trace、可解释诊断与自查） | 基于 trace/session ID 的确定性采样和优先级 | P0 |
| U07 | Replay | 默认静态打包、无错误触发保留、无质量指标 | 独立包、懒加载、环形缓冲、Worker 压缩 | P1 |
| U08 | Web Vitals | FID 仍在核心列表；生命周期覆盖不完整 | web-vitals v5 语义、BFCache/soft nav/LoAF | P1 |
| U09 | Resource Timing | 个别阶段值使用绝对时间，缓存/SW 归因弱 | 标准阶段差值和 attribution 测试夹具 | P1 |
| U10 | 错误上下文 | 异常链、机制、框架信息不足 | Error v2 + Vue/React Integration | P1 |
| U11 ✅ | 请求 Body | 有采集开关，但仅字段名脱敏无法覆盖任意文本内容（Phase 4 已接入 `sanitizePair` 统一清洗 + 自定义 `requestResponseSanitizer`） | 内容类型限制、大小限制、路径级 allowlist、自定义 sanitizer | P0 |
| U12 | 死点击 | 依赖 `data-track-dead-click`，不是真正自动检测 | Mutation/导航/网络/视觉反馈窗口的启发式检测，保留声明式模式 | P2 |
| U13 | SDK 健康 | 仅在 dropped/failed 后上报聚合 metric | 结构化 diagnostics、用户回调、平台健康面板 | P1 |
| U14 | 文档 | `capability-roadmap.md` 多处把已实现能力写成“缺失/待做” | 建立 capability manifest，并由 CI 校验文档/类型/默认值 | P0 |
| U15 | 测试 | 缺 Replay/Trace/Queue/Consent 浏览器级回归 | Vitest/Node 单测 + Playwright 多浏览器 + 协议契约测试 | P0 |
| U16 | 配置和生命周期 | `tracing`/`distributedTracing` 容易组合出半开启状态；fetch/XHR patch 无统一销毁协议 | 合并为清晰的 tracing 配置对象；所有 Integration 必须幂等并返回 disposer | P0 |

## 7. 12 周落地计划

### 7.1 团队与边界假设

- SDK A：Tracing、Context、类型和插件边界。
- SDK B：Privacy、Transport、Replay、性能。
- Backend：Envelope v2、Span ingest、兼容读写、限流和诊断。
- Web/QA：调用树/错误/Replay 验收、浏览器矩阵、性能基准、发布门禁。
- 所有新采集默认 opt-in；修复标准合规、类型和安全问题可以保持原默认行为，但必须给升级说明。

### 7.2 里程碑

| 周期 | 交付内容 | 出口条件 |
|---|---|---|
| Week 1 | capability manifest、数据字典、bundle/CPU/发送成功率基线、隐私测试语料 | 基线报告可重复执行；所有公共配置有唯一来源 |
| Week 2 | 类型契约补齐、`withSpan` 生命周期修复、Integration 幂等/销毁、Trace/Span 单测 | runtime 与 `.d.ts` 无差异；嵌套/异常/Promise/多实例/销毁测试全绿 |
| Week 3 | Span Processor、WebCollection Exporter、`/api/spans` v2 契约 | 手工 Span 和自动请求 Span 都能在调用树展示，父子关系正确 |
| Week 4 | 标准 baggage/tracestate、确定性采样、Privacy v2 第一阶段 | W3C 互操作测试通过；敏感语料零明文 |
| Week 5 | IndexedDB 队列、超时、退避、429/5xx、BeaconTransport、keepalive 回退、diagnostics | 断网/页面退出可恢复；Beacon 超限或拒绝时正确回退；重复发送只入库一次 |
| Week 6 | Core/Browser/Tracing 包边界、IIFE Integration 注册表/Loader、基础/full 兼容产物 | 老接入可迁移；重复 Core/Integration 可诊断；tree-shaking、exports、CSP/SRI 测试通过 |
| Week 7 | Replay 独立包、ESM 动态加载、IIFE 独立产物和 Replay 独立采样 | `replay:false` 不下载 rrweb；lazy/manual/full 三种模式协议一致且按需启动成功 |
| Week 8 | Replay 环形缓冲、错误触发保留、Worker/压缩 PoC | 错误前后片段完整；主线程开销满足预算 |
| Week 9 | Performance v2：BFCache、prerender、visibility、现代 Web Vitals | 与 `web-vitals` 对照误差在约定阈值内 |
| Week 10 | SPA route transaction、LoAF/User Timing、资源归因 | Vue/React 示例中路由性能和请求 Span 可关联 |
| Week 11 | Error v2、Debug ID 上传与校验、错误/Replay/Trace 关联 | 混淆堆栈可稳定还原；详情页双向跳转 |
| Week 12 | OTLP Exporter beta、远程 kill switch MVP、迁移文档和发布演练 | 兼容矩阵全绿；可灰度、可回滚、可观察 |

## 8. 可直接进入迭代的 Backlog

工作量按人日估算，包含编码和单元测试，不包含跨团队排期等待。

| ID | 任务 | 主要文件/模块 | 估算 | 验收标准 |
|---|---|---|---:|---|
| SDK-201 ✅ | 修复 Span 生命周期和异步恢复（Phase 1 已完成） | `src/trace/tracer.js`、`span.js` | 2d | 同步/异步/嵌套/异常后 current span 均恢复正确 |
| SDK-202 ✅ | 增加 Span Processor/Exporter | `src/trace/`、`src/index.js` | 5d | 自定义 Span 批量发送，页面调用树可见且无重复（Phase 2 已完成：BatchSpanProcessor + WebCollectionSpanExporter，spanExport 配置默认关） |
| API-203 ✅ | 定义并接收 Span Envelope v2 | `apps/api` ingest/store | 4d | v1/v2 双读；非法字段 4xx；500 Span 批量写入满足性能门禁（Phase 2 已完成：POST /api/spans 支持 v2 信封 + 校验 + 硬上限） |
| SDK-204 ✅ | 补齐 TypeScript 公共契约（Phase 1 已完成运行时 API 声明补齐） | `index.d.ts`，后续迁移 TS source | 2d | tsd/API Extractor 覆盖所有运行时公共成员 |
| SDK-205 ✅ | 标准化 W3C baggage/tracestate | `src/trace/propagation.js`、fetch/xhr | 3d | 与 OTel/Elastic 测试服务互通；CORS 文档完整（Phase 3 已完成：标准 `baggage` 单一 Header + `traceOrigins` string/RegExp/function matcher + 互操作单测 + `docs/w3c-propagation.md`） |
| SDK-206 ✅ | Privacy v2 与统一 sanitizer | `src/core/sanitizer.js`、`src/core/event.js`、behavior/network/replay | 5d | 隐私测试语料零敏感明文；默认不发送原手机号/选项文本（Phase 4 已完成：统一 sanitizer + 三档策略 + GPC/DNT + 11 例回归测试） |
| SDK-207 ✅ | IndexedDB Reliable Queue | 新 `src/transport/` | 7d | 刷新、崩溃、断网、quota、429 场景结果可预测且有诊断（Phase 5 已完成：`IndexedDBQueue` + `ReliableSender` 热/冷队列镜像、`next_session_recovered`、`queue_full` 溢出告警、31 例单测全绿） |
| SDK-208 ✅ | 确定性采样与 Replay 策略 | `src/sampling/`、trace/replay | 4d | 同 trace 决策一致；错误会话按策略保留；配置可解释（Phase 6 已完成：`DeterministicSampler` + 哈希原语、20 例单测全绿；Replay 独立采样归入 Phase 7 / SDK-209） |
| SDK-209 | Replay 动态加载与分包 | `src/replay/`、Vite config、exports | 4d | 关闭 Replay 时 ESM 和基础 IIFE 均不下载/包含 rrweb；开启后按需加载成功 |
| SDK-210 | Replay Worker/压缩/环形缓冲 | replay transport | 7d | 错误前 30 秒可恢复；长任务增量满足预算 |
| SDK-211 | Web Vitals 与页面生命周期 v2 | `src/performance/` | 6d | BFCache/prerender/pagehide/INP/CLS 对照用例通过 |
| SDK-212 | SPA Route Transaction | performance + Vue/React integration | 6d | 路由、数据请求、渲染完成形成稳定父子链路 |
| SDK-213 | Error v2 异常链和 Stack Frame | `src/error/`、API issue grouping | 6d | cause/AggregateError/DOMException/扩展噪音测试通过 |
| TOOL-214 | Debug ID Source Map 插件 | build plugin + release API | 7d | 错误通过 debugId 精确匹配构建产物，错版本显式报警 |
| SDK-215 | `onDiagnostic` 和 SDK 健康事件 | core/transport/sampling | 3d | 每种丢弃/失败原因可观测，不含业务敏感数据 |
| QA-216 | Browser SDK E2E 矩阵 | Playwright + fixtures | 7d | Chromium/Firefox/WebKit 覆盖 error/perf/trace/replay/privacy |
| DOC-217 | capability manifest 与文档生成 | `docs/`、CI script | 3d | 默认值、类型、README、能力表漂移会使 CI 失败 |
| SDK-218 | 统一 tracing 配置和 Integration 生命周期 | `src/index.js`、performance/behavior integrations | 4d | start/destroy 可重复；多实例不重复 patch；销毁后原生 API 和监听器恢复 |
| SDK-219 ✅ | BeaconTransport 与页面退出调度 | `src/transport/beacon.js`、lifecycle、collect API | 4d | UTF-8 字节切片、优先级、鉴权兼容、false/超限回退、BFCache、下一会话恢复和服务端幂等测试通过（Phase 5 已完成：`beacon-transport.js` 字节切片、非破坏性退出、`sendBeacon` 不带自定义 Header、fetch keepalive 回退、31 例单测覆盖） |
| API-220 ✅（SDK 侧契约） | Beacon 鉴权与事件幂等入库 | collect API、token service、event repository | 4d | SDK 侧已完成：每条事件稳定 `eventId` + 在线/Beacon 携带 + at-least-once 语义；Beacon 回退 fetch keepalive 带 `x-app-key` 鉴权兼容。服务端 `eventId` 入库去重与去重指标为后端范畴，契约已对齐（Phase 5 已完成 SDK 契约与 31 例单测） |
| SDK-221 | IIFE Integration Loader 与产物矩阵 | 新 `src/integrations/`、Vite 多入口、release script | 5d | 基础/可选/full 产物、版本握手、并发去重、CSP/SRI、manual/lazy/full 和失败降级测试通过 |

## 9. 质量门禁与量化指标

### 9.1 SDK 资源预算

| 指标 | 目标 |
|---|---:|
| Core + Browser 默认包 | gzip ≤ 35 KB，不包含 Replay |
| Tracing 可选包 | gzip 增量 ≤ 12 KB |
| Replay 首次启动额外下载 | gzip ≤ 90 KB，允许独立缓存 |
| IIFE full 兼容包 | gzip ≤ 125 KB；每次发布必须单独报告，不作为默认推荐入口 |
| SDK 初始化主线程阻塞 | P95 ≤ 5 ms，中低端设备 P95 ≤ 12 ms |
| 非 Replay 常驻内存增量 | P95 ≤ 5 MB |
| Replay 运行主线程额外开销 | P95 CPU ≤ 3%，Long Task 增量 ≤ 1 次/分钟 |
| 单事件序列化 | P95 ≤ 1 ms；超大 payload 必须截断并诊断 |

预算应在真实示例应用和至少一台中低端 Android 设备上测量，不只看开发机。

### 9.2 数据质量和可靠性

- 采集成功率 ≥ 99.9%，按接收、重试成功、不可重试、采样丢弃、隐私丢弃分别统计。
- Trace 父子闭合率 ≥ 99.5%；重复 spanId、孤儿 Span 和负 duration 为 0。
- 错误 Source Map 还原成功率 ≥ 98%，匹配不到时必须展示明确原因。
- 合法空数据和接口/契约错误必须是不同 UI 状态，不能把错误转成空数组。
- 后端健康接口 P95 < 250 ms，常用列表 P95 < 2 s；查询必须有分页和上限。
- 断网 10 分钟后恢复，未超容量的高优先级错误和 Span 100% 最终送达。
- 页面在事件入队后立即关闭或切到后台，关键错误和已结束 Span 的最终入库率 ≥ 99%；`sendBeacon` 拒绝、不可用或超限时必须回退到 keepalive 或下一会话恢复。
- 同一 `eventId` 经 Beacon 和下一会话 fetch 重复发送时，服务端最终只保留一份；Beacon 的“已排队”与服务端“已入库”必须分开统计。

### 9.3 隐私和安全

- 默认配置下，输入值、密码、token、cookie、手机号、邮箱、身份证、银行卡测试语料不得出现在网络 payload、持久化队列和 SDK 日志。
- `beforeSend` 之后必须再次 sanitize，防止钩子重新引入敏感字段；当前代码已有二次清洗，应保留并扩展。
- Trace Header 只向同源或显式 allowlist 目标发送；配置错误不得向任意第三方域传播 baggage。
- 远程配置必须签名校验并限制可变字段；远程端不能下发任意代码、正则灾难表达式或扩大隐私范围。
- 每个新采集项必须记录 purpose、默认值、保留期、敏感级别、采样方式和删除方式。

## 10. 兼容与发布策略

建议不要在 0.1.x 中一次性切换事件协议：

1. `0.1.x`：只修 Span 生命周期、类型、隐私高风险项和测试，不破坏现有后端。
2. `0.2.0-beta`：加入 Envelope v2、Processor/Exporter、分包；支持 `protocolVersion: 1 | 2`，默认仍为 1。
3. `0.2.x`：生产灰度双写 5% → 25% → 100%，对比事件数、字段完整率、Trace 闭合率和成本。
4. `0.3.0`：默认 v2；v1 进入弃用期，聚合包保持兼容。
5. 后端至少跨两个 minor 版本双读；回滚只切远程配置，不要求业务重新发版。

每次发布必须生成：类型 API diff、bundle size diff、协议 diff、隐私字段 diff、浏览器矩阵结果和迁移说明。

## 11. Build / Borrow / Adopt 决策

| 项目 | 决策 | 原因 |
|---|---|---|
| 自托管事件协议和平台 | Build | 已形成差异化产品能力，应继续控制成本和数据模型 |
| W3C Trace Context/Baggage | Adopt | 标准已经成熟，自定义协议没有收益 |
| OTel API 全量替换 | 暂不 | Browser 仍属 experimental，迁移成本高；先兼容语义和 Exporter |
| OTel Context/Exporter 边界 | Borrow/Adopt | 可显著减少并发上下文和生态互通风险 |
| Replay 引擎 | Adopt rrweb | 当前已有基础，不应自研 DOM 录制内核 |
| Replay 调度、隐私、队列 | Build | 与本项目协议、采样、治理和平台强相关 |
| 完整 Feature Flag 平台 | 不做 | 偏离可观测性主线；只采集 variant 关联上下文 |
| Web Vitals 算法 | Adopt 官方库语义 | 浏览器细节变化快，不应长期维护自定义近似实现 |
| 错误 Issue 产品 | Build + Borrow patterns | 平台已具备基础，可借鉴 Sentry 的错误语义而不复制其全部产品 |

## 12. 风险与控制措施

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 新协议导致历史页面无数据 | 高 | v1/v2 双读、契约 fixture、灰度双写、未知协议显式错误 |
| Span 数量引发存储爆炸 | 高 | 确定性采样、每 trace 上限、属性限长、服务端配额、truncated 标记 |
| Replay 影响业务性能 | 高 | 懒加载、Worker、资源预算、远程 kill switch、错误触发采样 |
| 隐私规则误采或误删 | 高 | 默认最小化、分级策略、fixture、payload 快照、数据字典和审计日志 |
| 插件化造成版本碎片 | 中 | 核心 peer 版本范围、兼容矩阵、统一 release train |
| IndexedDB 在隐私模式失败 | 中 | 内存回退、容量诊断、错误优先队列、禁止静默无限重试 |
| OTel 语义升级 | 中 | 适配层隔离，不把后端表结构直接绑定到实验字段 |
| 远程配置被滥用 | 高 | 签名、字段 allowlist、TTL、本地上限、审计、强制隐私下限 |

## 13. 第一批迭代完成定义

当且仅当以下条件全部满足，才可以宣布“Tracing 和采集可靠性升级完成”：

- TypeScript 示例可调用所有公开 API，且不存在运行时成员未声明。
- 页面根 Span、自动 fetch/XHR Span、自定义嵌套 Span 在分布式调用树可见，SpanId、ParentSpanId、状态和耗时均非空且正确。
- 并发 Promise、reject、abort、timeout、HTTP 4xx/5xx 后 current span 不污染后续请求。
- 与一个 OpenTelemetry 测试服务完成 `traceparent`、`tracestate`、`baggage` 互操作。
- 隐私 fixture 在网络请求和 IndexedDB 中均无敏感明文。
- 断网、刷新、页面立即关闭、Beacon 返回 `false`、Beacon 超过字节上限、429、500、慢接口、配额不足场景均有自动恢复或明确 diagnostics。
- 配置无自定义 Header 鉴权时，页面退出可通过 `sendBeacon` 分批上报；配置 `collectKey` 时按约定使用短期 Beacon Token 或明确回退 `fetch keepalive`，长期密钥不得进入 URL。
- Beacon 与下一会话 fetch 重复提交相同 `eventId` 时，服务端幂等去重且 Trace/Replay 关联不被破坏。
- npm ESM 与基础 IIFE 在 `replay:false` 时均不包含或下载 rrweb；开启 Replay 后只加载一次独立 Replay 产物，录制、分段、错误关联和回放正常。
- IIFE lazy、manual 和 full 单文件三种方式产生相同事件协议；Integration 404、超时、SRI 失败、版本不匹配时基础采集继续运行并显示准确 diagnostics。
- 基础 IIFE 与 full IIFE 重复加载时不得重复 patch 浏览器 API，必须阻止第二个 Core 并报告 `duplicate_core`。
- Chromium、Firefox、WebKit 自动化通过；不支持的 Performance API 只降级，不产生未捕获异常。
- 后台页面将“真正无数据”“请求失败”“协议不兼容”“数据被截断”展示为不同状态。

## 14. 参考资料

### 14.1 官方仓库

- [Sentry JavaScript SDK](https://github.com/getsentry/sentry-javascript)
- [Datadog Browser SDK](https://github.com/DataDog/browser-sdk)
- [OpenTelemetry JavaScript](https://github.com/open-telemetry/opentelemetry-js)
- [OpenTelemetry JavaScript Contrib](https://github.com/open-telemetry/opentelemetry-js-contrib)
- [Elastic APM RUM Agent](https://github.com/elastic/apm-agent-rum-js)
- [Grafana Faro Web SDK](https://github.com/grafana/faro-web-sdk)
- [PostHog JS](https://github.com/PostHog/posthog-js)
- [rrweb](https://github.com/rrweb-io/rrweb)
- [Highlight](https://github.com/highlight/highlight)

### 14.2 官方能力文档

- [OpenTelemetry JS Browser 入门](https://opentelemetry.io/docs/languages/js/getting-started/browser/)
- [OpenTelemetry JS 状态说明](https://opentelemetry.io/docs/languages/js/)
- [Elastic RUM Agent 能力](https://www.elastic.co/docs/reference/apm/agents/rum-js)
- [Elastic RUM 分布式追踪](https://www.elastic.co/docs/reference/apm/agents/rum-js/distributed-tracing)
- [Datadog Browser RUM Setup](https://docs.datadoghq.com/real_user_monitoring/application_monitoring/browser/setup/client/)
- [Datadog Browser Sampling](https://docs.datadoghq.com/real_user_monitoring/guide/sampling-browser-plans/)
- [Datadog Browser Session Replay](https://docs.datadoghq.com/session_replay/browser/)
- [Sentry JavaScript Session Replay](https://docs.sentry.dev/platforms/javascript/session-replay/)
- [Grafana Faro Instrumentation](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/instrument/)
- [Grafana Faro User Sessions](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/visualize-data/sessions/)
- [rrweb Recipes](https://github.com/rrweb-io/rrweb/blob/main/docs/recipes/index.md)
- [Highlight Browser SDK API](https://highlight.io/docs/sdk/client)
- [Highlight Privacy](https://www.highlight.io/docs/getting-started/browser/replay-configuration/privacy)
- [Highlight Network Recording and Redaction](https://www.highlight.io/docs/getting-started/browser/replay-configuration/recording-network-requests-and-responses)
- [MDN `Navigator.sendBeacon()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon)
- [MDN `Request.keepalive`](https://developer.mozilla.org/en-US/docs/Web/API/Request/keepalive)
- [Vite Library Mode / Build Options](https://vite.dev/config/build-options)

## 15. 文档维护说明

本文件是 2026-08-11 的源码和开源项目快照。`docs/capability-roadmap.md` 中仍有部分“缺失能力”已经在当前代码中实现，后续应由 `DOC-217` 将其标记为历史规划或合并到本文件，避免两个路线图相互矛盾。每个季度至少重新核对一次竞品能力、浏览器标准状态、SDK 包体积和本项目公共 API。
