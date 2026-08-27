# PRD 01：用户链路（User Journey）

> 优先级：P0 ｜ 里程碑：M1 ｜ SDK 改动：无（M1）
> 修订：2026-08-26 评审修订——存储模型按实际 schema 更正（无独立 errors/logs 表）；API 节点关联由开放问题升级为设计决策（§5.3）
> 关联：上位文档 README；消费数据：events（pv/behavior/error/log/perf 多 type 明细）/ spans / issues / sessions

## 1. 背景与问题

当前"还原一个用户发生了什么"的能力割裂：

- 会话回放强依赖 rrweb 录制，未录制（采样外/旧版本/采集失败）的会话是黑盒；
- 错误详情、API 请求、日志、Trace 分散在四个页面，需要人工按 session_id 多次检索拼接；
- 服务端视角（请求是否到达、如何响应）与前端行为无法对照。

参考系统的用户链路页验证了价值：会话列表 → 事件时间线 → 节点全属性的三栏结构，**不依赖录制**即可还原用户操作序列。

## 2. 目标 / 非目标

**目标**
- G1 给定用户/设备/会话/trace 任一标识，30 秒内还原完整行为序列
- G2 前端事件、JS 错误、API 请求（含状态码）、日志在一条时间线合并呈现
- G3 从错误详情/回放/会话页一键进入对应链路

**非目标**
- 不做服务端埋点接入（M2 决策 D1）
- 不做跨会话的用户级长期行为画像（用户会话页已覆盖列表场景）
- 不替代回放：链路与回放是互补入口，互相跳转

## 3. 用户故事

- 作为排障工程师，我拿到用户反馈"下单失败"，输入其用户 ID，看到时间线上 `点击支付 → API /pay 422 → JS 报错`，直接定位。
- 作为客服，用户给出手机号，我查到其最近会话，点击节点看到设备/版本/IP(脱敏)，判断是兼容性问题后转研发并附链路链接。
- 作为研发，从错误详情点"查看链路"，直接看到错误发生前 30 秒的用户操作序列。

## 4. 功能需求

### FR-1 检索区

| 字段 | 类型 | 规则 |
|---|---|---|
| 标识类型 | 枚举 | 用户ID / 设备ID / 会话ID / traceId |
| 标识值 | text | 必填；精确匹配；支持粘贴带空格自动 trim |
| 时间范围 | datetime range | 默认最近 24h，最大 7 天 |
| 应用筛选 | select | 默认当前全局筛选 appId |

- 「查询」按钮触发；查询后 URL 携带参数（可分享、可刷新）
- 空结果：展示空态 + 建议（放宽时间/换标识类型）

### FR-2 会话列表（左栏）

- 列：用户/会话标识、事件数、错误标记（有 error 事件显示 ⚠N）、最近时间
- 默认按最近时间倒序；点击选中 → 中栏加载该会话时间线
- 分页：每页 30，滚动加载
- 顶部统计：会话数、总事件数、异常会话数

### FR-3 事件时间线（中栏）

- 数据源合并（按 ts 升序）：

| 事件类别 | 数据表 | 图标/颜色 | 节点摘要 |
|---|---|---|---|
| 页面浏览 pv | events(type=pv) | 📄 蓝 | path + title |
| 行为事件 | events(behavior/click/exposure) | 🖱 紫 | 事件名 + 关键属性 |
| JS 错误 | events(type='error') + issues(聚合视图) | ❌ 红 | 错误名前 60 字；可点击跳错误详情 |
| API 请求 | spans(kind=CLIENT)，经 trace_id 关联会话（spans 无 session_id 字段，见 §5.3 决策） | 🔗 青色；4xx/5xx 红色 | method + url + 状态码 + 耗时 |
| 日志 | events(type='log') | 📝 灰 | level + 消息前 60 字 |
| 性能 | events(type='perf') | ⏱ 绿 | 指标名 + 值 |

- **同批折叠**：同一上报批次（batch_id 或 ts 相差 <50ms 且同 transport 批次）折叠显示"同批 N 条"，展开逐条（借鉴参考系统"同批接收"标注）
- **操作时段分组**：间隔 >30 分钟的相邻事件之间插入"时段分隔线"（借鉴参考系统"操作时段"）
- 时间线节点点击 → 右栏显示节点详情
- 顶部会话摘要卡：身份链路（匿名ID→登录用户）、会话时长、错误数、应用/SDK 版本、设备/网络、浏览器、会话 ID（可复制）

### FR-4 节点详情（右栏）

- 字段级展示：事件名、类别、时间（发生/接收）、页面、应用/版本、SDK 版本、设备/OS/浏览器、网络、IP（按数据等级脱敏，见 07）、自定义属性（context_json 格式化 JSON，可折叠、可搜索）
- 关联跳转：错误节点 → 错误详情；API 节点 → Trace 详情；会话 → 回放页（若已录制，标注"有回放"角标）
- 每个节点「复制 JSON」按钮

### FR-5 入口打通

| 入口位置 | 跳转参数 |
|---|---|
| 错误详情抽屉 | `/journey?sessionId=&ts=` （时间线自动定位到该错误节点并高亮） |
| 会话回放页 | `/journey?sessionId=` |
| 用户会话列表行操作 | `/journey?sessionId=` |
| Trace 详情 | `/journey?traceId=` |

### FR-6 AI 分析（差异化能力）

- 时间线右上「AI 分析此会话」按钮 → 将时间线摘要（事件序列 + 错误 + 慢请求）作为上下文调用现有 diagnoser
- 结果面板：异常点定位、可能原因、建议操作；一键"沉淀到知识库"（复用 feedback 链路）

## 5. 接口设计

### 5.1 会话检索

```
GET /api/journey/sessions?type=user|device|session|trace&value={id}
    &appId=&start=&end=&page=&pageSize=30

200 {
  "total": 42,
  "sessions": [{
    "sessionId": "b7fc4f37-...",
    "userId": "userNo 1770108161", "anonymousId": "c30bf6b1-...",
    "eventCount": 25, "errorCount": 2,
    "startedAt": 1756177600000, "lastAt": 1756180030000,
    "appId": "h5", "sdkVersion": "0.1.0-alpha.59",
    "device": "desktop", "browser": "edge 151", "hasReplay": true
  }]
}
```

### 5.2 时间线

```
GET /api/journey/timeline?sessionId=&start=&end=&limit=500

200 {
  "session": { ...摘要卡字段, "identityChain": ["c30bf6b1(匿名)", "userNo 1770108161(登录)"] },
  "events": [{
    "id": "evt-1", "ts": 1756177600123, "category": "pv|behavior|error|api|log|perf",
    "name": "click", "summary": "提交订单按钮",
    "level": "info|warn|error",
    "batchId": "b-991", "detail": { ...原始字段, "context": {...} },
    "refs": { "errorId": "...", "traceId": "...", "replayAvailable": true }
  }],
  "truncated": false
}
```

### 5.3 实现要点

- 存储模型实况（已核对 db.js）：**无独立 errors/logs 表**——日志为 events(type='log')，错误明细入 events(type='error')、聚合同版 issues 表。时间线合并 = events（按 category 映射 type 条件过滤）UNION spans（仅 API 节点），按 ts 内存排序分页
- API 节点关联决策（原开放问题 1 升级）：spans 表仅有 trace_id/service_name 等列，**无 session_id/app_id 字段**。M1 以 trace_id 关联：取该会话事件携带的 trace_id 集合反查 spans；trace_id 缺失的事件挂不上 API 节点，将「事件 trace_id 覆盖率」列为上线观察指标。SDK 在 span attributes 补 session_id 列为 M2 可选增强
- 同批折叠依据（原开放问题 2 结论）：服务端 events 已有 batch_id 列（P0-5 信封字段），折叠优先按 batch_id 精确分组；缺失时回退 ts 相差 <50ms 且同 transport 的窗口近似
- 性能：idx_events_session(session_id, ts) 已存在，满足检索与时间线查询；单会话 limit 500，超出返回 truncated=true 并提示收窄时间
- 能力开关：`/api/capabilities` 增加 `userJourney: true`（双端一致，呼应既有 P0）

## 6. 边界与异常

| 场景 | 行为 |
|---|---|
| 标识无任何数据 | 空态："未找到该标识的数据，请确认标识类型与时间范围" |
| 会话事件 >500 | truncated=true，时间线顶部提示"仅展示前 500 条，请收窄时间范围" |
| 跨天会话（>24h） | 正常展示；时段分隔线自动切分 |
| 回放未录制 | 摘要卡 hasReplay=false，回放按钮置灰 |
| 检索值含 SQL 特殊字符 | 参数化查询，无注入面 |

## 7. 权限与安全

- IP 字段按数据访问等级（PRD 07）脱敏；07 未落地前统一脱敏为 `IP(归属地)`
- userId/手机号按现有 PII 策略处理
- 无写操作；只读聚合

## 8. 成功指标

- 错误详情 → 链路页跳转率 ≥40%（排障主路径成立）
- 链路页 → 回放页跳转率 ≥25%
- 平均排障会话时长（错误发现到关闭）环比下降 20%
- 基线前置：上线前 2 周采集现状数据（错误详情人工拼接耗时、排障会话时长基线），否则环比目标无从度量

## 9. 里程碑

| 阶段 | 内容 |
|---|---|
| M1-a | 检索 + 会话列表 + 时间线（pv/behavior/error/api）+ 节点详情 |
| M1-b | 同批折叠、时段分组、入口打通（4 处）、AI 分析 |
| M2 | 服务端事件接入（决策 D1）、日志/性能类别完善 |

## 10. 开放问题

1. ~~spans 是否带 session_id~~ 已核实：不带（db.js spans 建表仅 trace_id/service_name 等）。处理方案见 §5.3 关联决策
2. ~~批次 ID~~ 已核实：服务端 events.batch_id 列已存在（P0-5 信封字段），同批折叠优先用之
3. 用户链路页是否纳入移动端响应式（当前控制台以桌面为主，建议 M1 不做）
