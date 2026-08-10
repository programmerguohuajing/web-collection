# 分布式调用追踪（Distributed Tracing）能力规划

> 目标：让 Web Collection 从「前端视角的扁平调用关系」升级为「前端 → 网关 → 服务 A → 服务 B」的**真正分布式调用树**。
> 本文档配套 `docs/topology-plan.md`（拓扑可视化规划）。本文聚焦 **SDK 链路上下文增强 + 后端 span 采集** 这一更大范围的实现路径。

---

## 1. 背景与目标

当前 `web-eys-sdk` 已具备 W3C `traceparent` 注入能力：每个页面加载生成 `pageTraceId`，所有 fetch/xhr 请求自动带上 `traceparent` 头向后端透传（见 `packages/sdk/src/performance/fetch.js` 的 `withTraceHeader`）。后端只要按 W3C Trace Context 规范提取该头，就能把前端请求与自身链路串起来。

但「串起来」这件事目前**只做了一半**：

- 前端确实把 `traceparent` 发给了后端 ✅
- 后端**没有任何机制把自身生成的 span（网关/服务 A/服务 B）回传给本系统** ❌
- 前端每个请求的 `spanId` 是 `randomHex(8)` 随机值，**没有 `parentSpanId`**，无法在页面内构成「点击 → 请求」的嵌套 ❌
- API 侧 `getTrace(traceId)` 只返回前端 `events` 表中同 `trace_id` 的事件，拿不到后端 span ❌

因此，目标拆为两层：

1. **前端 SDK 增强**：生成规范的、带父子关系的 span 上下文（W3C 兼容），正确传播到后端。
2. **后端 span 采集（更大范围）**：新增后端 Server-SDK / OpenTelemetry 导出器 + 采集 API 的 span 入库与查询，使「前端 → 网关 → 服务 A → 服务 B」能被还原成树。

> 关键认知：**SDK 能「传播」上下文，但无法「强制」后端上报 span。** 第 2 层依赖后端服务接入本系统的追踪 SDK（或 OTel 桥接），这是范围变大的根本原因，需在文档中明确责任边界。

---

## 2. 现状分析（SDK 当前链路能力）

| 能力 | 现状（真实代码） | 缺口 |
|---|---|---|
| 页面级 TraceId | `core.js:51` `pageTraceId = id().replace(/-/g,'').slice(0,32)` | 已是 32 位 hex，OK |
| traceparent 注入 | `fetch.js:69-72` `00-${traceId}-${spanId}-01` | 版本/flags 写死 `00`/`01`；缺 `tracestate`/`baggage` |
| 请求级 SpanId | `fetch.js:18` `randomHex(8)` | **随机值，无 parentSpanId，无法嵌套** |
| Span 父子关系 | 无 | 页面内点击 → fetch 无法构成层级 |
| 采样决策 | `core.js` 整体按 `sampleRate` 采样 | traceFlags 未与采样联动（恒为 `01`） |
| 后端 span 回传 | 无端点、无存储 | API 没有接收/保存后端 span 的能力 |
| 分布式查询 | `getTrace` 仅查前端 events | 无跨端合并 + 建树 |
| Server-Timing | `server-timing.js` 已解析并附到 fetch props | 仅扁平耗时，未用于建树；可作为轻量回退 |

**关键代码引用（便于落地时定位）：**
- `packages/sdk/src/platform/core.js` — `pageTraceId`、 `metric()`（注入 `traceId`/`spanId`）、`push()`
- `packages/sdk/src/performance/fetch.js` — `withTraceHeader()`、`randomHex()`、`canTrace()`
- `packages/sdk/src/performance/xhr.js` — 与 fetch 同构，需同步改造
- `packages/sdk/src/performance/server-timing.js` — `parse()`
- `apps/api/src/db.js:65-66` — `events` 表已有 `trace_id`/`span_id` 列 + `idx_events_trace`
- `apps/api/src/services/analytics-service.js:72-93` — `listTraces` / `getTrace`
- `apps/api/src/index.js:206-207` — `/api/traces`、 `/api/traces/:traceId`

---

## 3. 目标架构

```
┌─────────────── 浏览器（web-eys-sdk 前端 SDK） ───────────────┐
│  Page Root Span (trace_id = pageTraceId, span_id=R0)         │
│   ├─ Click Span (span_id=C1, parent=R0)                      │
│   │   └─ fetch Span (span_id=F1, parent=C1)  ── traceparent ─┐
│   └─ navigation Span (span_id=N1, parent=R0)                 │
└─────────────────────────────────────────────────────────────┘
                                                              │ HTTP 请求
                                                              ▼
┌─────────────── 后端服务（需接入 Server-SDK / OTel） ──────────┐
│  Gateway Span (span_id=G1, parent=F1, kind=SERVER)          │
│   ├─ Service-A Span (span_id=A1, parent=G1, kind=SERVER)    │
│   │   └─ DB Span (span_id=D1, parent=A1)                    │
│   └─ Service-B Span (span_id=B1, parent=G1, kind=SERVER)    │
└─────────────────────────────────────────────────────────────┘
                                                              │ POST /api/spans
                                                              ▼
┌─────────────── 采集 API（apps/api） ─────────────────────────┐
│  spans 表 (trace_id, span_id, parent_span_id, service, ...)  │
│  getDistributedTrace(traceId) → 跨端合并 + 建树              │
└─────────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
┌─────────────── 前端控制台（apps/web） ───────────────────────┐
│  DistributedTraceTree 组件 → 渲染调用树 / 瀑布图            │
└─────────────────────────────────────────────────────────────┘
```

**三端职责边界：**

| 端 | 职责 | 是否在本 SDK 仓库内可控 |
|---|---|---|
| 前端 SDK | 生成 trace 上下文、层级 span、注入/提取 W3C 头、上报前端 span | ✅ 完全可控 |
| 后端 Server-SDK | 提取上下文、生成网关/服务 span、导出到 `/api/spans` | ⚠️ 需新建包，且依赖各后端团队接入 |
| 采集 API | 接收 span、入库、提供分布式查询与建树 | ✅ 完全可控 |

---

## 4. 核心概念与数据模型

### 4.1 W3C Trace Context（传播标准）

- `traceparent`: `00-{traceId(32hex)}-{spanId(16hex)}-{flags(2hex)}`
  - `flags` 的 `0x1` 位 = sampled。当前写死 `01`，需改为由采样决策得出。
- `tracestate`: 跨厂商状态透传（如多租户、路由标记）。
- `baggage`: 跨服务业务属性透传（如 `userId=xxx,release=v1`）。

### 4.2 Span 模型（与 OpenTelemetry 对齐）

```jsonc
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",   // 32 hex，全链路一致
  "spanId": "00f067aa0ba902b7",                     // 16 hex，本 span 唯一
  "parentSpanId": "a3ce929d0ba902b7",               // 16 hex，为空=根
  "serviceName": "web-app | gateway | svc-order",   // 服务名（前端=web-app）
  "operationName": "GET /api/order",                // 操作名
  "kind": "SERVER | CLIENT | INTERNAL",             // 跨进程/内部
  "startTime": 1690000000123,                       // epoch ms
  "duration": 47.3,                                 // ms
  "status": { "code": "OK | ERROR", "message": "" },
  "attributes": { "http.method": "GET", "http.status_code": 200 }
}
```

### 4.3 调用树重建算法（前端/API 通用）

```
输入：同一 traceId 下的全部 span（含 parentSpanId）
1. 建索引 spanId -> span
2. 根集合 = parentSpanId 为空或找不到对应父的 span（通常是前端 Page Root）
3. 对每个 span，挂到 parentSpanId 对应的父 span.children
4. 输出森林（多根则并列展示）
5. 派生指标：每层耗时、关键路径（最长耗时链）、错误向上冒泡标记
```

---

## 5. SDK 增强设计（前端，完全可控）

### 5.1 新增 trace 模块

```
packages/sdk/src/trace/
├── context.js      // TraceContext：traceId/spanId/flags/tracestate/baggage + 序列化
├── span.js         // Span 类：start/end/setAttribute/recordException
├── tracer.js       // Tracer：startSpan / currentSpan / 上下文栈 / 注入提取
├── sampler.js      // 采样决策 → traceFlags（head sampling）
└── propagation.js  // injectHeaders / extractHeaders（traceparent+tracestate+baggage）
```

### 5.2 Span 上下文与层级（parentSpanId）

- Tracer 维护一个**当前活动 span 栈**（用模块级栈 + 可选 AsyncLocalStorage 模拟 zone）。
- 页面加载创建 **Page Root Span**（取代当前 `pageTraceId.slice(0,16)` 作为 spanId 的写法）。
- `fetch.js` / `xhr.js` 不再用 `randomHex(8)`，改为 `tracer.startSpan('fetch '+url, { parent: tracer.currentSpan() })`，spanId 由 Span 生成，`parentSpanId` 自动关联。
- 点击/路由等事件同样挂到当前活动 span 之下，形成「点击 → 请求」嵌套。
- `core.js` 的 `metric()` 改为附带 `{ traceId, spanId, parentSpanId }`，并新增 `parentSpanId` 列落库。

### 5.3 采样与 traceFlags

- `sampler.js` 依据 `cfg.sampleRate` 与 `categorySampleRates` 决策是否 sampled。
- 命中则 `flags = '01'`，否则 `'00'`（unsampled 的链路不强制上报后端子 span）。
- 支持远端采样头（`tracestate` 中的采样权重）为后续 tail sampling 预留。

### 5.4 上下文传播（注入 / 提取）

- `propagation.js#injectHeaders(init, context)`：写入 `traceparent` + `tracestate` + `baggage` 三类头（替代 `withTraceHeader`）。
- `propagation.js#extractHeaders(response)`：从响应头读取后端返回的 `traceresponse` / `Server-Timing`（携带 `traceparent=...`）以补全后端根 span 标识。
- **CORS 前置条件**：跨域时需后端在 `Access-Control-Expose-Headers` 暴露 `server-timing`、`traceresponse`；`traceparent`/`tracestate`/`baggage` 需加入 `Access-Control-Allow-Headers`。

### 5.5 Server-Timing 升级（零代码后端 span 提示，轻量回退）

对于**未接入 Server-SDK** 的后端，利用已有 `server-timing.js` 解析能力扩展：
- 约定后端在 `Server-Timing` 中以 `desc` 携带服务/阶段名、`dur` 携带耗时，SDK 将其转为「后端阶段叶子节点」挂到对应 fetch span 下。
- 这是**降级方案**：能展示「前端 → 后端阶段耗时」但无法展示「网关 → 服务 A → 服务 B」内部树，最终仍需 5/6 节的标准方案。

### 5.6 Span 上报

- 前端 span 复用现有 `/api/collect` 批量通道（作为 `perf` 事件的 `traceId/spanId/parentSpanId` 字段），**不新增前端上报端点**，降低改动面。
- 后端 span 走新增的 `POST /api/spans`（见 6.2），与前端事件表解耦。

### 5.7 公共 API 与配置

新增（向后兼容，默认关闭 `distributedTracing`）：
```js
const eys = createEys({ distributedTracing: true, traceOrigins: ['https://api.xxx.com'] })
eys.startSpan('checkout', { attributes: { step: 'pay' } })   // 手动开 span
eys.withSpan('heavy-task', async () => { ... })               // 自动结束
eys.getCurrentSpan()                                          // 取当前活动 span
```
配置项新增：`distributedTracing`、`traceOrigins`（已有）、`baggage`（静态业务属性）。

### 5.8 代码改动点清单（文件级）

| 文件 | 改动 |
|---|---|
| `packages/sdk/src/trace/*` | 新增上下文/Span/Tracer/采样/传播模块 |
| `packages/sdk/src/performance/fetch.js` | 用 Tracer 创建层级 span，替换 `randomHex` + `withTraceHeader` |
| `packages/sdk/src/performance/xhr.js` | 同 fetch 改造 |
| `packages/sdk/src/performance/index.js` | navigation 改为 Page Root Span |
| `packages/sdk/src/platform/core.js` | `metric/error` 注入 `parentSpanId`；新增公开 API |
| `apps/api/src/db.js` | `events` 表加 `parent_span_id`；新增 `spans` 表 |
| `apps/api/src/repositories/events-repo.js` | 落库 `parent_span_id` |

---

## 6. 后端 Span 采集（更大范围，需后端接入）

> 此层是范围变大的根源。前端 SDK 改造完成后，若后端不接入，仍只能看到「前端 → 单跳后端」，**看不到网关/服务内部树**。

### 6.1 Server-SDK / OpenTelemetry 导出器

新增包 `packages/server-sdk`（Node，提供 Express/Koa/Fastify 中间件 + OTel `SpanProcessor`）：

1. **提取**：从入站请求头解析 `traceparent`/`tracestate`/`baggage`，重建 TraceContext 作为 SERVER span 父。
2. **生成**：为入站请求建 SERVER span；为向下游（服务 A/B、DB、RPC）调用建 CLIENT span，`parentSpanId` 指向当前 span。
3. **导出**：Span 结束通过 `SpanProcessor` 批量 `POST /api/spans`。

> 若后端已是 OTel 体系，可不引入本包，直接用一个 **OTLP → `/api/spans` 桥接器**（轻量转换层）即可。二选一，文档默认推荐桥接器优先。

### 6.2 采集 API：入库与表结构

新增 `POST /api/spans`（批量接收 span 数组）。

`spans` 表（与 `events` 表解耦，按 trace 维度优化）：
```sql
create table if not exists spans (
  id              varchar(64) primary key,
  trace_id        varchar(64) not null,
  span_id         varchar(32) not null,
  parent_span_id  varchar(32),
  service_name    varchar(128),
  operation_name  varchar(256),
  kind            varchar(16),
  start_ts        bigint not null,
  duration        double precision,
  status_code     varchar(16),
  status_message  text,
  attributes_json jsonb,
  ts              bigint not null
);
create index if not exists idx_spans_trace on spans(trace_id, start_ts);
create index if not exists idx_spans_parent on spans(trace_id, parent_span_id);
```

### 6.3 分布式 Trace 查询 `getDistributedTrace`

- 合并 `events`（前端 span，按 `trace_id`）+ `spans`（后端 span，按 `trace_id`）。
- 统一映射为 4.2 的 Span 模型，执行 4.3 建树算法。
- 新增路由 `GET /api/traces/:traceId/distributed`，返回 `{ root, nodes, edges, criticalPath, errorSpans }`。
- 复用现有 `filters()`（`appId`/`release`/`startTime` 等）做权限与裁剪。

---

## 7. 前端可视化（分布式调用树）

- 新增 `apps/web/src/components/DistributedTraceTree.vue`：
  - 默认 **树形 + 嵌套瀑布**（ECharts `tree` 或自绘 Gantt），节点按 `serviceName` 着色（前端/web-app、网关、各服务不同色）。
  - 错误 span 红色高亮并向上冒泡标记路径。
  - 关键路径（最长耗时链）加粗。
- 在 `apps/web/src/views/monitor/traces/index.vue` 的 trace 详情里新增「分布式调用树」tab，调用 `/api/traces/:traceId/distributed`。
- 可与 `topology-plan.md` 的 `TopologyChart` 复用同一节点-边渲染基座。

---

## 8. 实施里程碑

| 阶段 | 内容 | 可控性 | 工作量 |
|---|---|---|---|
| **M1** | SDK trace 模块 + 层级 span（parentSpanId）+ 替换 randomHex | 前端可控 | 中 |
| **M2** | tracestate/baggage 注入提取 + CORS 文档 + Server-Timing 升级（轻量回退） | 前端可控 | 中 |
| **M3** | span 落库（events 加 parent_span_id）+ 前端 span 随 `/api/collect` 上报 | 前端+API 可控 | 小 |
| **M4** | 后端 Server-SDK / OTel 桥接器 + `POST /api/spans` 入库 + `spans` 表 | API 可控；后端接入需协调 | 大 |
| **M5** | `getDistributedTrace` 建树 + 前端 DistributedTraceTree 视图 | 前端+API 可控 | 中 |
| **M6** | 采样/脱敏/留存裁剪/基数控制 + 端到端联调（含 demo 后端） | 全栈 | 中 |

> 建议优先级：**M1 → M3 → M5 先把「前端内层级树」跑通**（不依赖后端，价值立现）；M2/M4 解决「跨服务树」，依赖后端协作，可并行推进。

---

## 9. 风险与开放问题

1. **后端接入是唯一硬依赖**：SDK 改造再多，后端不接 Server-SDK/OTel，就看不到网关/服务内部树。需推动后端团队采用，或先用 Server-Timing 轻量回退（M2）。
2. **CORS 配置**：跨域 trace 头与 `Server-Timing` 暴露需后端配合加响应头。
3. **存储膨胀**：每个 DB/RPC 调用都成 span，需基数控制 + 采样 + 留存裁剪（参考 `events` 表的 `trimEventRows`）。
4. **隐私**：span `attributes` 可能含 PII（如 userId、URL 参数），需在落库前走现有 `sanitizeEvent` 脱敏。
5. **时钟漂移**：跨服务 `start_ts` 来自不同机器，建树前需容忍小幅负时长（钳制为 0）。
6. **W3C 版本演进**：`traceparent` 版本 `00`，需保留未来升版兼容。

---

## 10. 验收标准

- [ ] 前端页面内点击 → 请求在 trace 详情中呈现**嵌套父子关系**（parentSpanId 正确）。
- [ ] 启用 `distributedTracing` 后，跨域请求带 `traceparent`+`tracestate`+`baggage`，且 `flags` 与采样决策一致。
- [ ] （后端接入后）一个带 `traceparent` 的请求到达后端，后端回传子 span；查询该 `traceId` 返回完整「前端 → 网关 → 服务 A → 服务 B」树，父子与耗时正确。
- [ ] Server-Timing 回退路径对未接入后端仍可用，展示后端阶段耗时。
- [ ] 不破坏既有 Traces 页面、单测与 `/api/collect` 通道；隐私脱敏对 span attributes 生效。

---

## 11. 与 `topology-plan.md` 的关系

- `topology-plan.md`：解决「**看得到拓扑图**」——基于现有数据做前端视角拓扑（页面→接口、点击→点击）。
- 本文档：解决「**拓扑能跨服务**」——补齐分布式链路上下文与后端 span 采集，使拓扑升级为真正的调用树。
- 二者共用 `TopologyChart`/`DistributedTraceTree` 的节点-边渲染基座，且都依赖 `traceId` 串联，建议同步推进、复用数据层。
