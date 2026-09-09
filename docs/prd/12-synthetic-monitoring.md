# PRD 12：合成监控（Synthetic Monitoring / 主动探针）

> 优先级：P1 ｜ 里程碑：M4（Next·P1）｜ SDK 改动：无
> 关联：上位 `outputs/capability-opportunities-next-horizon.md` §B3；与 B2 SLO（被动 RUM 口径的可用性承诺）、E2 API 健康视图（真实用户流量口径）互补——B3 用**主动探针**补盲区：无真实用户流量的时段（深夜）、地域、接口。
> 原则：双后端一致（Node/PG + Cloudflare/D1 同表同接口同能力位，README 原则 #4）；`synthetic` 能力位默认 false，未开启时显式「当前部署不支持合成监控」而非静默隐藏（deployment-capabilities 原则，参考 B2 `guardSlo` 范式）。

## 1. 背景与问题（含复用盘点）

平台被动 RUM 已覆盖真实用户的错误/性能/API 健康，但存在三类盲区：**无流量时段**（夜间服务挂了没人发现）、**无用户覆盖的地域/接口**（低频接口坏了没人踩）、**无法区分「服务挂了」vs「没人访问」**。合成监控以主动探针解决，是企业级可观测性采购的标准能力。

**现状盘点（写 PRD 前已核实，不重复造轮子）**：

- **执行时机**：Worker crons 已有 `*/5 * * * *` tick（`worker.js scheduled()`，B2 SLO 快照在用）——探针调度**挂载该 tick**，不新增 cron。
- **告警通道**：`packages/alerting.js` feishu/dingtalk/wecom/email/sms/webhook/slack/pagerduty 全齐；投递复用 `alert_history` + `createAlertDeliveries`（30min 冷却去重），B2 已有 `metric='slo_burn'` 范式——B3 直接新增 `metric='synthetic'`。
- **能力位机制**：`packages/deployment-capabilities.js`（`CAPABILITY_KEYS` / `NODE_CAPABILITIES` / `WORKER_CAPABILITIES`）+ Worker 侧 env 门禁默认 false 兜底（`guardSloW` 范式）→ 新增能力位 `synthetic`。
- **应用归属**：`applications` 表（`app_id varchar(64)`）+ D2 `applications.team_id`，探针按 app_id 挂靠，team 过滤复用 accounts 中间件。
- **定时任务先例**：Node 侧 `slo-scheduler.js`；探针手动触发可参考 Node 侧执行（fetch 无外部依赖）。
- **本 PRD 不新建告警通道、不新建调度器、不新建采集**——只新建探针定义/结果两张表 + Worker 探测执行 + Node 手动触发 + 前端两页。

## 2. 产品目标

- **G1 主动补盲**：对任意 HTTP(S) 端点做分钟级定时可用性探测（状态码/超时/关键词断言 + 时延阈值），覆盖无真实用户流量的时段与接口。
- **G2 故障可量化**：探针结果落库，提供最近 N 次时间线 + 窗口内可用率/时延统计，形成「主动视角」可用性证据。
- **G3 故障必达**：连续 N 次失败触发告警，完全复用现有告警通道栈与冷却去重，零新增通道运维。

## 3. 用户故事

- 作为 SRE，我为支付接口配置一条每 60s 的探针（期望 200 + 关键词 `"ok"`），以便在无真实用户访问的深夜也能第一时间发现接口挂掉。
- 作为 on-call，我配置「连续 3 次失败 → critical」，以便通过飞书收到告警且不被单次抖动打扰（30min 冷却去重）。
- 作为 技术负责人，我看探针详情页的最近 50 次时间线与近 24h 可用率/P95 时延，以便周报引用「主动探测可用性 99.97%」。
- 作为 前端负责人，我在探针列表点「立即探测」，以便配置后不等下一个周期立刻验证配置是否正确。
- 作为 自托管用户，我未开启 `synthetic` 能力位时页面显示「当前部署不支持合成监控」，以便明确知道需要开启而非以为功能坏了。

## 4. 需求池

> P0 = 首版交付；P1 = 应做；P2 = 长尾。⚠️ = 双栈改造（Node/PG + Cloudflare/D1，同表同接口同能力位）。每条标注 复用/新建。

### P0 · 探针定义 + 执行 + 失败告警（核心）⚠️

- **FR-1 探针定义 CRUD（新建表 `synthetic_checks`）**：name / url / method(GET,默认) / interval_seconds(60|300|600，分钟级) / timeout_ms(默认 10000) / expected_status(默认 200) / keyword(可选关键词断言，命中响应体即通过) / latency_threshold_ms(可选，超阈值记 warning) / enabled(启停)。⚠️
- **FR-2 Worker 定时探测（复用 `*/5` cron tick，不新增 cron）**：tick 时对 enabled 且到期的探针执行 fetch（fetch 自带 AbortController 超时控制），判定规则见 §5.2；结果写 `synthetic_results` 并更新 checks 的 last_status/last_run_at/consecutive_failures。⚠️
- **FR-3 Node 侧手动触发（新建 `POST /api/synthetic/{id}/run`）**：Node(PG) 侧直接执行单次探测并返回结果；Worker 侧同路由执行等价探测（fetch 可用）。用于配置后即时验证与排障。⚠️
- **FR-4 失败告警（复用 alerting.js，metric='synthetic'）**：`consecutive_failures ≥ threshold（探针级配置，默认 3）` → 写 `alert_history(metric='synthetic', level=warning|critical)` → 复用 `createAlertDeliveries`（30min 冷却去重）投递至 metrics_json 含 `synthetic` 的现有通道；恢复（连续成功）可选发恢复通知（复用同链路，P1）。⚠️
- **FR-5 `synthetic` 能力位（复用 deployment-capabilities，默认 false）**：`CAPABILITY_KEYS` 登记 `synthetic`；`NODE_CAPABILITIES` / `WORKER_CAPABILITIES` 默认 false；Worker 侧 env 门禁（`SYNTHETIC_ENABLED`，`guardSlo` 范式）+ 默认 false 兜底；未开启时路由 guard 直接拒绝。⚠️
- **FR-6 accounts 安全（复用 D2 中间件）**：`accounts=false` 时单租户全局可见；开启时按 `applications.team_id` 过滤，跨 team → 403。⚠️

### P1 · 可视化（前端两页）⚠️

- **FR-7 探针列表页（新建，复用列表/表单组件）**：列 name / url / interval / 最近状态(成功·失败·超时·未跑) / 连续失败数 / 最近可用率 / 启停开关 / 操作(编辑·立即探测·删除)；新建/编辑走抽屉表单。长文本用 `<OverflowTip>`（EP 2.14 红线）。
- **FR-8 探针详情页（新建，复用图表组件）**：最近 N 次（默认 50）结果时间线（成功/失败点图 + 失败原因 tooltip）+ 可用率/时延统计卡（近 1h/24h 可用率、P50/P95 时延）。
- **FR-9 结果存储与统计（复用 events 清理机制）**：`synthetic_results` 保留期内聚合可用率/时延；过期清理挂到现有 `cleanup`（cron `17 3 * * *`），默认保留 30d。

### P2 · 联动 + 扩展

- **FR-10 B2 SLO 联动**：探针可用率可作为 availability SLO 的 SLI 源（呼应 PRD 11 Q5 决策——首版 RUM，B3 数据后续接入）。
- **FR-11 探针组/多地域**：多探针组编排、拨测地域维度（Cloudflare 多 PoP 天然具备，本期单点）。

## 5. 接口契约

### 5.1 路由（双栈同构，`synthetic` 能力位 guard 包裹）

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/synthetic` | 创建/更新（body 带 id 即更新，沿用 saveFunnel 风格） |
| GET | `/api/synthetic` | 列表（按 app_id；accounts 开启时按 team 过滤），含最近状态摘要 |
| GET | `/api/synthetic/{id}` | 详情（定义 + last_status/last_run_at/consecutive_failures） |
| DELETE | `/api/synthetic/{id}` | 删除（级联删 results） |
| POST | `/api/synthetic/{id}/run` | 立即探测（同步执行单次，返回结果） |
| GET | `/api/synthetic/{id}/timeline?limit=50` | 最近 N 次结果时间线 |
| GET | `/api/synthetic/{id}/stats?window=24h` | 可用率 + P50/P95 时延（窗口 1h/24h/7d） |

能力未开启时接口返回 `{ error: '合成监控能力未启用' }`，前端显式提示。

### 5.2 判定规则（双栈一致）

| 顺序 | 判定 | 结果 |
|---|---|---|
| 1 | fetch 超时/DNS 失败/网络错误 | fail，error 记原因 |
| 2 | `status_code ≠ expected_status` | fail |
| 3 | 配置 keyword 且响应体不含 | fail |
| 4 | 通过，但 `latency_ms > latency_threshold_ms`（已配置时） | success 但记 `latency_exceeded=1`（统计时单独展示，不计入失败） |

### 5.3 字段契约

**synthetic_checks（新建表）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | varchar(32) PK | nanoid |
| app_id | varchar(64) not null | 挂靠应用 |
| team_id | varchar(32) | 继承 applications.team_id；accounts=false 时 NULL |
| name | varchar(80) not null | 探针名称 |
| url | varchar(512) not null | 仅允许 http/https |
| method | varchar(8) default 'GET' | 首版仅 GET |
| interval_seconds | integer not null default 300 | 60/300/600 |
| timeout_ms | integer default 10000 | 1000–30000 |
| expected_status | integer default 200 | 期望状态码 |
| keyword | varchar(256) | 可选关键词断言 |
| latency_threshold_ms | integer | 可选时延阈值 |
| fail_threshold | integer default 3 | 连续失败 N 次告警 |
| enabled | integer(0/1) / boolean | 启停 |
| last_status | varchar(12) | success/fail/timeout/unknown |
| last_run_at | bigint | 上次执行 |
| consecutive_failures | integer default 0 | 连续失败计数（恢复归零） |
| created_at / updated_at | bigint | — |

**synthetic_results（新建表；大表索引拆至 migrations-manual）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | varchar(32) PK | nanoid |
| check_id | varchar(32) not null | FK → synthetic_checks |
| ok | integer(0/1) / boolean | 通过与否 |
| outcome | varchar(12) | success/fail/timeout |
| status_code | integer | 响应码（网络错误为 NULL） |
| latency_ms | integer | 耗时 |
| latency_exceeded | integer(0/1) | 超时延阈值 |
| error | varchar(256) | 失败原因摘要 |
| checked_at | bigint | 探测时刻（索引列） |

**告警写入（复用，不新建通道）**：`alert_history(metric='synthetic', level, value=连续失败次数, app_id, ref_id=check_id)` → `createAlertDeliveries`（30min 冷却）→ metrics_json 含 `synthetic` 的通道。

## 6. 边界与异常

| 场景 | 行为 |
|---|---|
| synthetic=false | 接口 guard 拒绝；前端显式「当前部署不支持合成监控」，不隐藏入口 |
| 探针 URL 非 http/https / 指向内网地址 | 创建时校验拒绝；执行时兜底拒绝（SSRF 防护） |
| Worker tick 单次超量 | 每次 tick 最多执行 20 条到期探针，超出顺延下一 tick |
| 告警冷却 | 复用 30min 冷却；恢复通知同链路（P1） |
| results 过期 | 挂现有 cleanup cron（17 3 * * *），默认保留 30d |
| accounts=false | 单租户全局可见，team_id=NULL |

## 7. 成功指标

- 上线 1 月：创建探针 ≥ 5 条，其中 ≥ 2 条覆盖无真实用户流量的低频接口
- 故障发现时间：夜间故障通过探针告警发现（对比 RUM 零流量盲区）
- 探针告警投递成功率 ≥ 99%（复用通道 SLA）

## 8. 开放问题（附默认决策）

1. **Q1 探针调度密度 vs cron 粒度**：现有 tick 为 5 分钟，60s 间隔探针如何实现？**默认决策**：首版 tick 内每分钟逻辑由「到期判断」近似（interval=60 的探针每 tick 必跑，标注实际精度为 5min）；wrangler.jsonc 增加一条 `* * * * *` cron 作为可选增强（能力位开启才生效），避免未开启用户多付调用费。
2. **Q2 SSRF 边界**：探针由服务端发起，存在被用于内网探测的风险。**默认决策**：创建时校验协议 + 拒绝私有 IP 段/localhost（解析后校验）；自托管部署信任边界内文档声明即可，不强做。
3. **Q3 keyword 断言的隐私**：响应体仅在服务端匹配，不落库原文。**默认决策**：仅存 `ok/latency/error 摘要`，不存响应体（与平台数据最小化原则一致）。

## 9. 里程碑

- M4-a（P0）：探针 CRUD + Worker tick 探测 + Node 手动触发 + 连续失败告警（metric='synthetic'）+ `synthetic` 能力位 + accounts 安全。
- M4-b（P1）：列表页 + 详情页（时间线/可用率/时延统计）+ 恢复通知。
- M4-c（P2）：SLO SLI 接入 + 探针组/多地域。
