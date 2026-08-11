# Deterministic Sampling · 确定性采样设计说明

> 关联路线图：Phase 6（U06 / SDK-208）
> 实现模块：`packages/sdk/src/sampling/`（哈希原语 `hash.js`、确定性采样器 `deterministic-sampler.js`、barrel `index.js`）。
> 接入点：浏览器 `src/index.js`、平台 `src/platform/core.js`、链路 `src/trace/tracer.js`。

## 1. 背景与目标

历史实现用 `Math.random()` 在「会话入口」和「每个事件 / 每个 Span」上独立掷骰子：

- `src/index.js` 初始化时 `Math.random() > sampleRate` 命中即**整会话返回空实现**，错误也被一并丢弃；
- `push` 内 `Math.random() > sampleRateFor(category)` 每个事件各自随机，同一会话的事件被随机地一部分采一部分丢；
- `trace/sampler.js` 的 `Sampler.shouldSample()` 每个 Span 各自随机，导致**同一 trace 内父子 Span 可能被拆开**，分布式调用树断裂；
- 采样原因无法解释，排查「为什么没收到这条」时只能靠猜。

路线图 U06 明确要求：**基于 trace / session ID 的确定性采样和优先级；同 trace 决策一致；错误会话按策略保留；配置可解释**。

Phase 6 用一套**哈希一致性采样器**替换上述随机逻辑，做到「同 ID 同决策、错误必留、原因可查」。

## 2. 架构总览

```
            事件 / Span 进入
                 │
                 ▼
        ┌────────────────────┐
        │ DeterministicSampler │
        │  decide({            │
        │    traceId?          │  优先作为决策单元（保证 trace 一致性）
        │    sessionId?        │  无 traceId 时作为决策单元
        │    category?         │  分类子采样（仅收窄 session 级）
        │    priority?         │  错误等优先级事件
        │  })                  │
        └─────────┬──────────┘
     决策优先级（从高到低）：
   1. priority / markPriority → 保留（错误链路默认强制保留）
   2. 远端权重 traceState(sampling_weight) → tail-based 预留
   3. base：trace 单元用 traceRate，session/global 用 sampleRate
   4. 分类子采样：仅收窄 session 级，绝不破坏 trace
                 │
                 ▼
       { sampled, rate, rule, unit, key, category? }
```

| 组件 | 职责 |
|---|---|
| `cyrb53` / `foldUnit` / `hashUnit` | 确定性哈希原语；把任意字符串稳定映射到 `[0,1)`，浏览器与 Node 行为一致 |
| `DeterministicSampler` | 基于 traceId/sessionId 的一致性采样 + 优先级保留 + 分类子采样 + 远端权重 + 可解释决策 |
| `markPriority(key)` | 标记某 traceId/sessionId 为优先保留（如发生错误），其下所有 Span/事件均保留 |
| `getTraceFlagsForTraceId(traceId)` | 同一 traceId 恒定返回 `'01'`/`'00'`，保证 trace 内父子 Span 决策一致 |
| `getSamplingDecision()` | 客户端自查接口，返回最近一次决策（含 rule/rate/unit/key） |

## 3. 一致性：同 ID 同决策

核心公式（对任意单元键 `key`）：

```js
unit = hashUnit(salt ? `${salt}:${key}` : key)   // 稳定落在 [0,1)
sampled = unit < rate
```

- **trace 单元**：事件 / Span 携带 `traceId` 时，以 `traceId` 为键。同一 trace 内所有 Span 共享同一个 `traceId` → 共享同一决策 → **父子 Span 不被随机拆分**。
- **session 单元**：无 `traceId` 的事件（如通用埋点）以 `sessionId` 为键，保证**同会话事件决策一致**（替换原来「每事件随机」）。
- 浏览器侧多数页面级事件（`error`/`metric`/`log`）默认携带 `pageTraceId`，因此实际上以 trace 单元决策，整页一致；其余事件回退 session 单元。

> 因为是纯哈希，`rate=1` ⇒ 永远采样；`rate=0` ⇒ 永不采样；中间值下同一 `key` 永远得到相同布尔结果——这正是「确定性」的含义。

## 4. 优先级：错误会话按策略保留

错误是一类「绝不能因为采样而丢失」的信号。设计：

- **错误事件默认强制保留**（`priority: true`）。当错误携带 `traceId` 时，额外 `markPriority(traceId)`，使其关联的整条 trace（请求 Span 等）也被保留，保证 **错误 → trace 关联不被采样切断**。
- 若需约束错误体量，可配置 `errorSampleRate`（0~1）：此时错误仍按单元**确定性子采样**（同一错误 trace 要么全留要么全丢），既不全部保留也不全部丢弃。
- 未配置 `errorSampleRate`（默认）时，错误始终保留。

```js
// src/index.js / src/platform/core.js（push 内）
if (item.type === 'error' && item.traceId) sampler.markPriority(item.traceId)
const decision = sampler.decide({ traceId: item.traceId, sessionId, category, priority: item.type === 'error' })
if (!decision.sampled) { /* 计数 + 诊断 + 丢弃 */ return }
```

> 与旧逻辑的区别：旧代码 `Math.random() > sampleRate` 命中即**整会话空实现**，错误也会被静默丢掉。新逻辑下，即使 `sampleRate=0`，错误事件（及其 trace）仍被保留——这正是「错误会话按策略保留」。

## 5. 分类子采样（不破坏 trace）

`categorySampleRates` 允许按分类（error / performance / requests / behavior / exposure / replay）设置独立采样率：

- 仅作用于 **session 级**事件；
- **绝不**作用于 trace 单元——即使某分类命中，trace 仍按 `traceRate` 单一决策，保证链路完整；
- 命中时规则记为 `session_category`，决策同时受 base 率与分类率约束（`sampled = base命中 && 分类命中`），可解释字段携带 `categoryRate`。

## 6. 远端权重（tail-based 预留）

`tracestate` 中若存在 `sampling_weight=X`（0~1），则作为 tail-based 采样权重覆盖本地决策，同样按单元一致。非法格式（如 `sampling_weight=abc`）解析失败，安全回退本地决策。

## 7. 可解释性

每次决策返回结构化结果：

```ts
interface SamplingDecision {
  sampled: boolean          // 是否保留
  rate: number              // 应用的基础采样率
  rule: 'priority' | 'error_rate' | 'remote' | 'trace' | 'session' | 'session_category'
  unit: 'trace' | 'session' | 'global'   // 决策单元
  key: string               // 参与哈希的单元键（不含敏感数据）
  category?: string
  categoryRate?: number     // rule === 'session_category' 时
}
```

- 被采样丢弃的事件通过 `onDiagnostic('dropped_by_sampling')` 派发，附带 `rule` / `rate` / `unit` / `key` / `category`（见 `EysDiagnosticEvent`）；
- 客户端提供 `getSamplingDecision()` 返回最近一次决策，供 SDK 自诊断页（路线图 P2）与调试使用；
- 全过程**不含任何业务敏感数据**（只暴露 traceId/sessionId 这类非敏感 ID 的哈希键）。

## 8. 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `sampleRate` | `1` | session/global 基础采样率（0~1） |
| `traceRate` | `= sampleRate` | 链路（traceId）基础采样率 |
| `categorySampleRates` | `{}` | 分类采样率表（仅收窄 session 级） |
| `errorSampleRate` | 未设置 | 错误链路/事件确定性子采样率；不设置 = 错误始终保留 |

> 默认值（`sampleRate=1`）下行为与旧版一致：全量采集。将 `sampleRate` 设为 `<1` 即获得**确定性、可解释、错误保留**的按比例采样，而非旧版的随机整会话开关。

## 9. 接入点变更

- **浏览器 `src/index.js`**：移除初始化 `Math.random() > sampleRate → noopClient()` 整会话门控；`push` 改用 `sampler.decide(...)`；错误触发 `markPriority`；丢弃时派发带解释字段的 `dropped_by_sampling`；新增 `getSamplingDecision()`；新增 cfg `traceRate` / `errorSampleRate`。
- **平台 `src/platform/core.js`**：同样的确定性替换；保留并返回客户端 `getSamplingDecision()`。
- **链路 `src/trace/tracer.js`**：`createRootSpan` / `startSpan` 改用 `sampler.getTraceFlagsForTraceId(traceId)`，保证页面内及远端分布式 trace 内父子 Span 共享同一决策。旧的 `Sampler`（随机版）保留以兼容外部调用，但其 `getTraceFlags` 不再被内部使用。

## 10. 测试

`test/sampling.test.js`（20 例，全部通过）覆盖：哈希确定性/范围/分布、rate=1/0 边界、同 traceId/sessionId 多次决策一致、优先级强制保留、markPriority、errorSampleRate 子采样、远端权重、分类子采样不破坏 trace、getTraceFlagsForTraceId 一致性、可解释字段。`npm test` 全绿。

## 11. 未覆盖 / 后续

- **回放独立采样**：回放事件当前**不参与**采样丢弃（`item.type === 'replay'` 直接跳过），其独立采样与缓冲策略归入路线图 Phase 7（SDK-209）。
- **远程 kill switch / 动态采样**：采样率可经远程配置下发（签名、TTL、失败回退）归入 P2（路线图 5.3）；届时 `createDeterministicSampler` 已支持注入 `traceState` 远端权重，可作为动态权重的落点。
- **优先级标记时效性**：`markPriority` 当前为进程内内存集合，跨会话不保留；若需「错误会话跨刷新保留」可在此基础上叠加持久标记。
