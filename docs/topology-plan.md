# Web Collection 拓扑可视化开发计划

> 本文档描述在现有 Web Collection 监控体系中新增「拓扑图」展示能力的落地方案，包含 **traceId 调用拓扑** 与 **用户点击路径拓扑** 两个特性。范围为**前端视角**（不依赖后端 span 回传），可直接基于现有采集数据落地。

---

## 目录

- [1. 背景与目标](#1-背景与目标)
- [2. 现状分析](#2-现状分析)
- [3. 总体设计](#3-总体设计)
- [4. 能力一：traceId 调用拓扑](#4-能力一traceid-调用拓扑)
- [5. 能力二：用户点击路径拓扑](#5-能力二用户点击路径拓扑)
- [6. 公共组件：TopologyChart](#6-公共组件topologychart)
- [7. 实施步骤与里程碑](#7-实施步骤与里程碑)
- [8. 风险与注意事项](#8-风险与注意事项)
- [9. 验收标准](#9-验收标准)
- [10. 后续可选扩展](#10-后续可选扩展)

---

## 1. 背景与目标

### 1.1 背景

Web Collection 已具备链路追踪（Traces）与用户路径（Paths）的**数据底座**，但当前展示形态偏「表格化」：

- Traces 页面（`apps/web/src/views/monitor/traces/index.vue`）仅以「表格 + 抽屉列表」呈现 span，无法直观看出一次页面会话调用了哪些后端接口、耗时与错误分布。
- 用户路径在 `AnalyticsChart.vue` 中已有桑基图（Sankey）渲染页面级流转，但只有「页面级」，缺少「点击级」拓扑。

引入拓扑图（节点-边关系图）可显著提升问题定位效率：一眼看清「页面 → 接口」的调用关系，以及「元素 → 元素」的行为流转。

### 1.2 目标

| 特性 | 目标 | 范围边界 |
|------|------|----------|
| traceId 调用拓扑 | 选定一个 traceId，用关系图展示该页面会话调用了哪些后端接口（含调用次数、平均耗时、错误数） | **前端视角**：基于 SDK 已上报的 fetch/xhr span，不要求后端回传 span |
| 用户点击路径拓扑 | 按会话聚合「元素 → 元素」点击转移，用关系图展示高频点击流转（含会话权重） | 复用现有 `behavior/click` 采集数据 |

### 1.3 设计原则（沿用现有规范）

- 新增 API 端点统一挂载到 `apps/api/src/index.js`，逻辑落在 `apps/api/src/services/analytics-service.js`。
- 前端遵循 Vue 3 + Element Plus + Pinia 技术栈，图表复用 ECharts（`apps/web` 已引入 `echarts@6.1.0`）。
- 聚合查询沿用现有「拉取事件行 → 在 JS 中归并」的模式（参考 `getPaths`、`getHeatmap`），避免复杂 SQL / jsonb 聚合，保持可维护性与灵活性。
- 新增接口不破坏既有链路与页面，默认对历史数据兼容。

---

## 2. 现状分析

### 2.1 已具备的能力

| 能力 | 现状 | 代码位置 |
|------|------|----------|
| 页面级 TraceId | SDK 每个页面加载生成 `pageTraceId`（32 位十六进制），fetch/xhr 自动注入 W3C `traceparent` 头 | `packages/sdk/src/platform/core.js`（`pageTraceId`）、`packages/sdk/src/performance/fetch.js`（`withTraceHeader`） |
| Span 数据 | 每次请求上报 `metric='fetch'/'xhr'`，携带 `props.url`、`props.method`、`props.status`、`props.statusClass`、`value`(耗时)；`navigation` span 带页面加载指标 | `packages/sdk/src/performance/fetch.js`、`xhr.js` |
| 存储 | `events` 表含 `trace_id`、`span_id` 列，并有 `idx_events_trace(trace_id, ts)` 索引 | `apps/api/src/db.js` |
| Trace 查询 | `listTraces` 按 `trace_id` 聚合；`getTrace(traceId, filters)` 返回该 trace 的 span 列表 | `apps/api/src/services/analytics-service.js` |
| 点击事件 | `behavior/click` 上报 `name='click'`，携带 `props.elementLabel`、`props.path`、`props.elementType`、`session_id`、`ts` | `packages/sdk/src/behavior/click.js` |
| 页面路径 | `getPaths` 已按会话聚合页面流转；`PathInsightPanel` + `AnalyticsChart` 用桑基图渲染 | `apps/api/src/services/analytics-service.js`、`apps/web/src/components/AnalyticsChart.vue` |
| 图表库 | `apps/web` 已引入 ECharts，但仅使用 `line/bar/sankey`，**未引入 `graph`（力导向关系图）** | `apps/web/src/components/AnalyticsChart.vue` |

### 2.2 关键缺口

1. **Traces 无拓扑形态**：`getTrace` 仅返回扁平 span 列表，缺少节点/边的归并；SDK 未记录 `parentSpanId`，因此前端侧只能还原「页面 → 各接口」的扁平调用关系，构不成跨服务分布式树。
2. **点击级拓扑缺失**：现有路径分析只到页面级（`pv` / 路由变化），没有「元素 → 元素」点击转移。
3. **缺少 graph 图表组件**：需新增一个 `TopologyChart` 组件并引入 ECharts `GraphChart`。

---

## 3. 总体设计

### 3.1 节点-边数据模型（两端共用）

后端两个聚合接口统一输出如下结构，供 `TopologyChart` 渲染：

```jsonc
{
  "nodes": [
    { "id": "page:/home",        "label": "/home",            "type": "page", "value": 1 },
    { "id": "api:POST api.example.com/api/order", "label": "POST /api/order", "type": "api", "value": 12 }
  ],
  "edges": [
    {
      "source": "page:/home",
      "target": "api:POST api.example.com/api/order",
      "calls": 12,        // 调用次数
      "avgDuration": 320, // 平均耗时(ms)
      "errors": 1,        // 错误次数(status>=400 或网络错误)
      "sessions": 9       // 涉及会话数(点击拓扑用)
    }
  ]
}
```

- `type` 用于着色：`page` / `api` / `click`（点击拓扑节点）。
- 边权（宽度）取 `calls` 或 `sessions`；错误边用红色高亮。

### 3.2 数据流

```
SDK 上报 events                     API 聚合服务                       Web 控制台
┌──────────────┐   POST /api/collect  ┌──────────────────────┐   fetch    ┌──────────────────┐
│ pageTraceId  │ ───────────────────▶ │ getTraceTopology()   │ ─────────▶ │ Traces 抽屉「拓扑」│
│ fetch/xhr    │                      │  按 host+path 归并    │            │ TopologyChart    │
│ span         │                      └──────────────────────┘            └──────────────────┘
│ click 事件   │ ───────────────────▶ ┌──────────────────────┐   fetch    ┌──────────────────┐
│ session_id   │                      │ getClickPaths()      │ ─────────▶ │ Paths 页「点击视角」│
│ ts           │                      │  按会话转移归并       │            │ TopologyChart    │
└──────────────┘                      └──────────────────────┘            └──────────────────┘
```

---

## 4. 能力一：traceId 调用拓扑

### 4.1 后端

**新函数**：`getTraceTopology(traceId, filters)`（`apps/api/src/services/analytics-service.js`）

- 输入：`traceId`（必填）、`filters`（复用 `appId`/`release`/`startTime`/`endTime` 等）。
- 查询：取该 `trace_id` 下**全部** span（不分页，上限 5000 条，利用 `idx_events_trace`）：
  ```sql
  select * from events where trace_id = ? order by ts asc limit 5000
  ```
- 归并逻辑（JS 内）：
  1. **根节点**：取 trace 中 `url`/`path` 作为页面节点 `page:<path>`。
  2. **接口节点**：对 `metric in ('fetch','xhr')` 的 span，按 `method + host + 归一化 path`（去掉 query）归并为 `api:<METHOD host/path>`。
  3. **边**：`page → api`，聚合 `calls`（span 数）、`avgDuration`（均值 `value`）、`errors`（`props.status >= 400` 或 `props.statusClass='network_error'` 或 `props.failed`）。
- 返回 `{ nodes, edges }`。

**路由**：在 `apps/api/src/index.js` 注册（紧邻现有 `/api/traces/:traceId`）：

```js
app.get('/api/traces/:traceId/topology', async (req, res, next) => {
  try { res.json(await getTraceTopology(req.params.traceId, filters(req.query))) }
  catch (err) { next(err) }
})
```

> 注：`filters()` 已含 `traceId` 字段，但此处 `traceId` 来自路径参数，直接透传即可。

### 4.2 前端

**改动文件**：`apps/web/src/views/monitor/traces/index.vue`

- 在现有 `el-drawer`（链路详情）中新增一个 `el-tab-pane` 标签「拓扑」。
- 「拓扑」tab 内调用 `api('/api/traces/' + encodeURIComponent(active.value.trace_id) + '/topology')`，将结果传给 `TopologyChart`。
- 复用现有 `loadSpans` 的触发时机（`open(row)` 时一并加载拓扑，或 lazy 到切换到该 tab 时加载）。

---

## 5. 能力二：用户点击路径拓扑

### 5.1 后端

**新函数**：`getClickPaths(filters)`（`apps/api/src/services/analytics-service.js`）

- 查询：取 `type='behavior' and name='click'` 的事件，按 `session_id, ts` 排序，上限 20000（与 `getPaths` 一致）：
  ```sql
  select session_id, ts, path, props_json
  from events
  where type='behavior' and name='click' and props_json ? 'elementLabel'
  order by session_id, ts
  limit 20000
  ```
- 归并逻辑（JS 内，参考 `getPaths` 的会话分组方式）：
  1. 按 `session_id` 分组，按 `ts` 排序。
  2. 相邻点击构成转移：`from = <elementLabel@path>` → `to = <elementLabel@path>`。
  3. 对转移去重计数：`calls`（转移出现总次数）、`sessions`（出现该转移的会话数）。
  4. 节点 `id = <elementLabel@path>`，`label = elementLabel`（可附 `path` 作为副标题）。
- 返回 `{ nodes, edges }`，结构与 §3.1 一致，节点 `type='click'`。

**路由**：在 `apps/api/src/index.js` 注册（紧邻 `/api/analytics/paths`）：

```js
app.get('/api/analytics/click-paths', async (req, res, next) => {
  try { res.json(await getClickPaths(filters(req.query))) }
  catch (err) { next(err) }
})
```

### 5.2 前端

**改动文件**：`apps/web/src/pages/PathsPage.vue`（路由 `/paths`）

- 顶部增加视图切换（如 `el-radio-group`）：「页面路径」（现有表格）/「点击拓扑」（新）。
- 「点击拓扑」下调用 `api('/api/analytics/click-paths?' + queryFromFilters())`，用 `TopologyChart` 渲染。
- 现有页面路径表格（`getPaths`）逻辑保持不变，仅在切换时按需加载点击拓扑数据。

> 可选：也可在 `apps/web/src/views/monitor/analytics/index.vue` 的 Path 相关 tab 内增强，但 `/paths` 页独立、改动面更小，优先选此。

---

## 6. 公共组件：TopologyChart

**新文件**：`apps/web/src/components/TopologyChart.vue`

- 引入 ECharts `GraphChart`（力导向关系图）及配套组件：
  ```js
  import { GraphChart } from 'echarts/charts'
  import { TooltipComponent, LegendComponent } from 'echarts/components'
  import { CanvasRenderer } from 'echarts/renderers'
  echarts.use([GraphChart, TooltipComponent, LegendComponent, CanvasRenderer])
  ```
- Props：`result: { nodes, edges }`、`nodeColor?: (type) => color`、`height?: string`（默认 `420px`）。
- 渲染 `series.type='graph'`、`layout='force'`，节点按 `type` 着色（`page`/`api`/`click`），边宽 ∝ `calls`/`sessions`，错误边用红色 `lineStyle`。
- 交互：点击节点通过 `emit('select-node', node)` 回传（与 `AnalyticsChart` 的 `select-node` 约定一致），便于后续下钻。
- 初始化 / `ResizeObserver` / `onBeforeUnmount` 逻辑**复用** `AnalyticsChart.vue` 现有写法，保持一致。

可复用现有 `kind='path'` 的 tooltip 文案风格，使两类关系图体验统一。

---

## 7. 实施步骤与里程碑

| 阶段 | 任务 | 产出 | 工作量 |
|------|------|------|--------|
| M1 | 新增 `TopologyChart.vue`（引入 `GraphChart`，实现 force 布局 + 节点着色 + 边权 + 点击回传） | 可复用的拓扑图组件 | 小 |
| M2 | 后端 `getTraceTopology` + 路由 `/api/traces/:traceId/topology` | trace 调用拓扑数据接口 | 中 |
| M3 | 前端 Traces 抽屉接入「拓扑」tab | traceId 调用拓扑可用 | 小 |
| M4 | 后端 `getClickPaths` + 路由 `/api/analytics/click-paths` | 点击路径拓扑数据接口 | 中 |
| M5 | 前端 Paths 页增加「点击视角」切换并渲染 | 点击路径拓扑可用 | 小 |
| M6 | 联调 + 补充 analytics-service 单测（参考 `test/`） | 测试与文档 | 中 |

> 依赖顺序：M1 不依赖后端；M2/M4 互不依赖；M3 依赖 M1+M2；M5 依赖 M1+M4。

---

## 8. 风险与注意事项

1. **数据量**：点击拓扑按会话聚合可能行数较大（上限 20000，与 `getPaths` 对齐）；trace 拓扑受单 trace span 数限制（上限 5000）。如数据量增长，后续可下推 SQL 聚合。
2. **归一化口径**：接口节点归并需统一「去 query、去动态路径段（如 `/order/123` → `/order/:id`）」策略，否则节点会过碎。建议在文档中固化归一化规则（先按 host+pathname，动态 id 段用 `:id` 占位）。
3. **echarts 体积**：新增 `GraphChart` 会略微增大前端 bundle，建议按需引入（已在 `AnalyticsChart` 采用 `echarts/core` 按需注册模式，继续保持）。
4. **兼容**：新增接口对历史数据只读，不修改 `events` 表结构，无需迁移；`db:init` 无需改动。
5. **错误边判定**：网络错误 / 超时在 SDK 侧以 `props.statusClass='network_error'` 或 `props.failed=true` 标记，归并时需同时覆盖 HTTP 错误与网络错误。

---

## 9. 验收标准

- [ ] `GET /api/traces/:traceId/topology` 对存在 span 的 trace 返回非空的 `nodes`/`edges`，且 `edges` 的 `calls`/`avgDuration`/`errors` 数值正确。
- [ ] Traces 抽屉「拓扑」tab 正确渲染力导向图，节点区分页面/接口，错误调用以红色边高亮，hover 显示耗时/错误明细。
- [ ] `GET /api/analytics/click-paths` 返回按会话聚合的点击转移，`edges.sessions` 为去重会话数。
- [ ] Paths 页「点击视角」切换后正确渲染点击拓扑，无控制台报错。
- [ ] 新增组件/接口不破坏既有 Traces、Paths、Analytics 页面与现有单测。
- [ ] （可选）为 `getTraceTopology` / `getClickPaths` 补充单测，覆盖空数据、纯错误调用、单节点等边界。

---

## 10. 后续可选扩展

1. **分布式调用树（后端视角）**：若需「前端 → 网关 → 服务 A → 服务 B」的跨服务拓扑，需后端按 SDK 注入的 `traceparent` 回传 span 至本系统（新增 span 存储表与 ingest 接口）。这是更大的范围，当前计划**暂不纳入**。
2. **拓扑下钻**：点击接口节点跳转到对应 Traces / 错误聚合；点击点击节点下钻到该元素的会话回放。
3. **服务级聚合拓扑**：跨多 trace 按 `host` 聚合出全局「前端应用 → 后端服务」的调用大盘（而非单 trace）。
4. **时序拓扑**：在现有拓扑基础上叠加时间维度，展示调用随时间的演进（waterfall + graph 结合）。
