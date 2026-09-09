# PRD 15：D3 用量计量 & 套餐 / 定价（Usage Metering & Plans）

> 状态：Draft（简单 PRD） · 优先级：P2（商业化前置） · 作者：PM · 预估：后端 4d + 前端 2d
> 上游：`outputs/capability-opportunities-next-horizon.md` D3 行（Why：要商业化必须能"按量计费"。当前 ingestion 有自监控，但无对用户的用量计量与套餐。Scope：事件/回放/席位计量、套餐档位、超限提醒、账单/用量页。工作量：后端 4d + 前端 2d）
> 原则：双后端一致（Node/PG + Cloudflare/D1 同表同接口同能力位，README 原则 #4）；`metering` 能力位 Node `true`、Worker 默认 `false` + `METERING_ENABLED=1` env 门禁（dsr / experiments 同范式）；未开启时显式「当前部署不支持用量计量」而非静默隐藏。
> **范围红线（用户明确原则）**：本批只做**计量与配额的展示与提醒**，不做真实支付/开票/扣费；SDK 仍是通用技术底座，计量是**服务端聚合**，不在 SDK 核心加计费语义。

## 0. 一句话定位

把"平台到底为这个团队存了多少数据、用了多少席位"变成**可核、可查、可预警**的一等公民指标——先把计费的地基（计量 + 套餐档位 + 超限提醒）铺好，支付/开票留给后续批次。

## 1. 背景与现状锚点（代码核实结论）

- 现状缺口：平台有完整的入库自监控，但那是**平台自己的健康度指标**，不是**对客户的用量账本**：
  - `cloudflare/worker.js:23-43` `ingestionMonitor` 是**内存计数器 + 10min 滚动窗口**，窗口到期即 `reset()`（line 40-42），隔离冷启动归零；
  - `GET /api/monitoring/ingestion`（`worker.js:104-121`，路由 `worker.js:174`）只暴露 `received/eventsAccepted/written/failed/failureRate/lastWriteTs`，**无按团队/按应用/按天维度，无持久化，无配额概念**。
  - 结论：**自监控不能直接当计量源**（不可核、不可回溯、无租户维度），只能作为健康度诊断与计量对账的参考。
- 已有可复用基建（本 PRD 全部写明复用关系，不重复造轮子）：

| 基建 | 位置 | D3 复用方式 |
|---|---|---|
| 事件表 | `events`（`cloudflare/migrations/0001_init.sql:1`；`ts/type/app_id/session_id`，双栈同构）；Node 写入点 `apps/api/src/repositories/events-repo.js:14`；Worker 写入点 `record()`（`worker.js:300-330`），成功计数点位 `worker.js:215`（`written++`） | `events` 计量维度的落库事实源 |
| 回放表（**双栈表名不同，口径须对齐**） | D1：`replays`（`0001_init.sql:6`，一行 = 一个**回放会话段**，含 `base_session_id` 分段续传；Worker 写入 `worker.js:328`；列表按 `group by app_id, session_id` 聚合，`worker.js:682`）。PG：`replay_events`（`apps/api/src/db.js:155`，一行 = 一段回放事件，含 `segment_id`/`base_session_id`；写入 `apps/api/src/repositories/replays-repo.js:116`；会话按 `group by app_id, session_id` 聚合） | `replay_sessions` 计量维度 = **去重后的回放会话数**（见 §4；分段续传不重复计） |
| 团队/成员 | `teams` / `team_members`（`0025_account_team.sql`，`team_members.status: active\|invited\|disabled`） | `seats` 计量维度 = `status='active'` 的去重 `user_id` 数 |
| 日聚合范式 | `metric_daily_stats`（`0022_metric_daily_stats.sql`，PK `(app_id, metric, day yyyyMMdd)` + `value/samples`） | `usage_daily` 同范式建表（加 `team_id`、改 PK 为四元组）；注意该表**当前无 writer**（`packages/ai/baseline.js:110` 读、缺则降级 events 滚动窗口），本 PRD 的 writer 可后续顺带补齐（P2，不在本批） |
| 自监控 | `ingestionMonitor` + `/api/monitoring/ingestion`（`worker.js:23-43/104-121`） | 计量**不复用其计数**，但复用其"写入成功"点位（见 §6.1）；两者做对账：日计量 vs 当日 `written` 量级偏差过大即提示聚合异常 |
| 治理 retention | `apps/api/src/governance.js` `cleanupExpiredData()` + Node `setInterval(CLEANUP_INTERVAL_MS\|\|3600000)`（`apps/api/src/index.js:795`）+ `/api/maintenance/cleanup`（`index.js:691`）；Worker `scheduled()` `17 3 * * *` → `cleanup(env)`（`worker.js:187-189`，`wrangler.jsonc` triggers） | 计量表**必须排除**在 retention 清理之外（账单凭证不能随业务数据过期，见 §9 Q4）；手工重算端点复用 `/api/maintenance/*` 的运维入口范式 |
| 告警通道 | `packages/alerting.js`（`channelTypes: email/sms/feishu/feishu_app/wecom/dingtalk/webhook`；`sendChannel` `channelMatches` `normalizeChannel`；`alertMetrics` 白名单 line 5/78） | 超限提醒**复用现有通道投递**，写 `alert_history`（`metric='quota'`）；需在 `alertMetrics` 登记 `'quota'`（否则 `normalizeChannel` 会静默过滤掉该订阅，line 78） |
| 能力位 | `packages/deployment-capabilities.js`（`CAPABILITY_KEYS` 18-36 / `NODE_CAPABILITIES` 45-68 / `WORKER_CAPABILITIES` 75-99 / `buildCapabilities` 108-117）；Worker override `worker.js:431`；守卫范式 `guardDsrW`（`worker.js:1865-1867`）、`guardSyntheticW`（1627）、experiments（2499-2502）；Node 守卫 `apps/api/src/index.js:558-580` | 新增能力位 `metering`；Worker `METERING_ENABLED=1` 门禁；双端 guard 复刻 |
| RBAC | `packages/rbac.js` `ROLE_MATRIX`（camelCase 键，owner 恒放行，line 12-31/49-52） | 新增 `meterView` / `meterManage` |
| 前端范式 | `apps/web/src/views/experiment/index.vue`（KpiGrid + El-Table + 抽屉表单 + 能力位 false 的 `el-alert` 占位，line 245）；`components/KpiGrid.vue`、`components/MiniLineChart.vue`、`components/OverflowTip.vue`（EP 2.14 红线，禁用原生 show-overflow-tooltip） | `/usage` 页沿用；能力位 flag 经 `apps/web/src/composables/useAuth.ts`（line 96-104 现有 `dsrEnabled/experimentsEnabled` 同款 computed）暴露 |
| 表迁移 | `cloudflare/migrations/` 最新 `0034_experiments.sql` | 新增 `0035_metering.sql`；Node 侧 `apps/api/src/db.js` `ensureSchema` 追加同段（对齐 `0033/0034` 注释范式，db.js:692-757） |

- 现实约束：
  1. `accounts` 能力位 Worker 侧为 `false`（`WORKER_CAPABILITIES.accounts = false`），**无团队维度**——Worker 侧计量按 `team_id = ''`（单租户）聚合，团队/席位维度在 Node 侧才有意义（P0 表格保留 team_id 列，Worker 恒空串，双栈同形状）。
  2. 采集写入是**热路径**（`worker.js:205-222`），计量 upsert 必须 O(1) 且不能因失败阻断入库（计量失败只记日志，绝不吞掉用户数据）。

## 2. 产品目标

让"用了多少 / 还剩多少 / 超限了怎么办"在平台内有唯一可核的答案，为后续按量计费铺好地基。

- **G1 可核**：用量来自持久化日聚合表（`usage_daily`），可回溯任意历史自然月；与入库自监控量级可对账，杜绝"内存计数器当账本"。
- **G2 可读**：用量页一屏回答"本周期各维度用了多少 / 配额多少 / 百分比 / 哪天冲高 / 哪个应用占大头"。
- **G3 可控**：套餐档位与配额是**配置不是代码常量**（改档位不发版）；soft/hard 双阈值提醒复用现有告警通道，不新建告警子系统。

## 3. 用户故事

- As a **平台管理员（owner/admin）**, I want 在用量页看到当前自然月的事件数/回放会话数/席位数及其配额与进度, so that 我能在客户或老板问"这个月用了多少"时秒答，不用导数据算。
- As a **平台管理员（owner/admin）**, I want 按应用拆分用量并看按日趋势, so that 我能定位"是哪个应用把配额吃掉的"，并据此调采样率或升级档位。
- As a **接入方负责人（团队 owner/admin）**, I want 在用量达到配额 80%（soft）时收到平台告警通知（复用我配好的飞书/邮件通道），到 100%（hard）时页面红色警示, so that 我能在被限流/被拒收之前主动处理，而不是事后才发现。
- As a **接入方开发者（member/viewer）**, I want 看到本团队本周期用量, so that 我在排查"数据怎么少了"时能自助确认是不是配额问题，不用找管理员。
- As a **财务/运营**, I want 导出指定月份的用量明细（CSV）, so that 我能与合同/账单核对，或对内进行成本分摊（P1）。
- As a **自托管部署者**, I want Worker 部署上计量能力默认关闭（env 门禁）, so that 未验证的计量聚合不会在采集热路径上引入风险。

## 4. 核心概念定义

| 概念 | 定义 |
|---|---|
| **计量维度 metric** | `events`（落库事件行数）/ `replay_sessions`（落库回放会话行数）/ `seats`（团队活跃成员数）/ `retention_days`（**非计量，是套餐能力项**） |
| **events** | 一个自然月内**实际写入 `events` 表成功**的事件行数。客户端采样丢弃、被限流、被 `rules_json.blockedTypes/blockedNames` 过滤、入库失败的事件**均不计**（理由与默认决策见 §9 Q1） |
| **replay_sessions** | 一个自然月内**去重后的回放会话数**（长会话分段续传只算一次）：D1 用 `count(distinct coalesce(base_session_id, session_id))` over `replays`；PG 用 `count(distinct (app_id, session_id))` over `replay_events`。**不是**回放内部 rrweb 事件条数，也**不是**段行数 |
| **seats** | 团队 `team_members` 中 `status='active'` 的去重 `user_id` 数，**按日快照**（不实时 join，避免历史波动导致旧账单被追溯改写） |
| **retention_days** | 套餐能力项（数据保留天数），对齐治理 retention 配置；本批只作档位展示与约束说明，**不做强制清理联动**（P2） |
| **套餐档位 plan** | 一组配额的集合（`free` / `pro` / `enterprise`），含各维度 quota、soft 阈值百分比、hard 动作策略 |
| **软限 soft limit** | 用量达配额 `soft_limit_pct`（默认 80%）→ 发一次提醒（复用告警通道）+ 页面橙色提示；**不影响数据接收** |
| **硬限 hard limit** | 用量达配额 100% → 页面红色警示 + 一次 critical 提醒；**P0 不阻断接收**（`hard_action='none'`），P1 才支持 `reject` / `sample_down`（默认决策见 §9 Q2） |
| **用量周期** | **自然月（UTC）**，`period_key='YYYY-MM'`；日粒度存储、月粒度累加查询；日切口径 `day = floor(ts / 86400000)`（与 `apps/api/src/services/retention-service.js` 的日切口径一致） |
| **用量快照** | `usage_daily` 中 `(team_id, app_id, metric, day)` 唯一行的累计值——是本 PRD 的**唯一权威源**；月用量 = 该月所有日快照求和（不落月度冗余表，避免双写不一致） |

## 5. 需求池

### P0（Must have）

| # | 需求 | 说明 |
|---|---|---|
| P0-1 | 用量日聚合表 `usage_daily`（双栈同构） | 见 §7.1；迁移 `0035_metering.sql`；Node 侧 `apps/api/src/db.js` ensureSchema 追加同段 |
| P0-2 | 采集热路径计量 upsert | `events`：在写入成功点位（Worker `worker.js:215` `written++` 同层；Node `apps/api/src/repositories/events-repo.js:14` 同层）对 `usage_daily` 做 `insert ... on conflict do update set value = value + 1`。`replay_sessions`：**先点查该会话当日是否已计过**（D1 `select 1 from replays where app_id=? and session_id=? limit 1`；PG 同构查 `replay_events`），未计过才 +1——保证分段续传不重复计（回放写入频率远低于事件，多一次索引点查成本可接受）。**计量失败只 `console.error`，绝不阻断入库**（计量丢 1 条可重算，用户数据丢 1 条不可逆） |
| P0-3 | 席位日快照 | 在日聚合写入时（或每日一次）计算 `team_members.status='active'` 去重数写入 `usage_daily(team_id, app_id='', metric='seats', day)`；`accounts=false` 的单租户部署不写该维度 |
| P0-4 | 套餐档位表 `plans` + 团队绑定 `team_plans` | 见 §7.1；内置 `free`/`pro`/`enterprise` 种子数据；档位是**配置不是代码常量**（改档位不发版）；支持 per-team `quota_override_json` 覆盖（enterprise 议价场景） |
| P0-5 | 用量查询 API | `GET /api/metering/usage`（当前周期：各维度用量 + 配额 + 百分比 + 剩余天数 + 超限标记）、`GET /api/metering/usage/daily`（按日序列，MiniLineChart 数据源）、`GET /api/metering/usage/by-app`（按应用拆分）；见 §7.2 |
| P0-6 | 用量/套餐页 `/usage` | 见 §8；KpiGrid + 配额进度条 + 超限告警条 + 按日折线 + 按应用拆分表 + 套餐卡与档位对比 |
| P0-7 | 能力位 `metering` | `CAPABILITY_KEYS` 登记；Node `true`；Worker 默认 `false` + `METERING_ENABLED=1`（`worker.js:431` buildCapabilities override 追加 `metering: env.METERING_ENABLED === '1'`）；双端 guard 复刻 `guardDsrW` / Node `guardDsr` 范式，未开启统一 503 |
| P0-8 | RBAC 权限点 | `meterView: ['admin','member','viewer']`（用量对本团队全员可见，自助排障）；`meterManage: ['admin']`（改套餐/改配额覆盖/触发重算）；owner 恒放行（`packages/rbac.js` ROLE_MATRIX） |
| P0-9 | 超限提醒（复用告警通道） | soft/hard 触发时：写 `alert_history`（`metric='quota'`，`level='warning'/'critical'`，`fingerprint='quota:{team}:{metric}:{period}:{level}'` 抑制重复）+ 经 `packages/alerting.js` `sendChannel`/`channelMatches` 投递到已配置通道；**需在 `alerting.js:5` `alertMetrics` 登记 `'quota'`**（否则 line 78 会静默过滤订阅）；超限事件留痕另写 `quota_events`（因其需跨 retention 长期保留，见 §7.1） |

### P1（Should have）

| # | 需求 | 说明 |
|---|---|---|
| P1-1 | 硬限动作 | `plans.hard_action`：`none`（默认）/ `reject`（events 返回 429）/ `sample_down`（按 `sample_rate` 再降一档、replays 停录）；仅对 `events`/`replay_sessions` 生效；**默认 none**，先在 free 档灰度验证再放开（默认决策 §9 Q2） |
| P1-2 | 用量导出 CSV | `GET /api/metering/usage/export?period=YYYY-MM`：按应用 × 按日明细，复用 `exportCsv` 风格（财务对账/成本分摊） |
| P1-3 | 历史账单页 | 按自然月列表（用量 + 档位快照 + 是否超限），支持回溯 24 个月；依赖 `usage_daily` 保留期（§9 Q4） |
| P1-4 | 重算与对账 | `POST /api/metering/recompute?day=YYYYMMDD`：从 `events` 真实 COUNT 与 `replays`/`replay_events` 的**去重会话 COUNT**（§4 口径）重建当天快照（幂等，修复热路径 upsert 丢失）；运维入口对齐 `/api/maintenance/cleanup`（`apps/api/src/index.js:691`） |
| P1-5 | retention_days 档位联动提示 | 档位 retention_days 与实际治理 retention 配置不一致时，用量页给出提示（**只提示不强制改**，避免误伤存量清理策略） |

### P2（Nice to have）

| # | 需求 | 说明 |
|---|---|---|
| P2-1 | 真实计费对接 | 支付网关、账单生成、开票、欠费停用——**本批明确不做**（§10 红线） |
| P2-2 | 按量阶梯计价 / 超额单价 | 阶梯价与超额计费（overage），依赖 P2-1 账单体系 |
| P2-3 | 应用级配额 | 配额下放到单个 `app_id`（当前仅团队级） |
| P2-4 | 补齐 `metric_daily_stats` writer | 顺带为该表补 EOD 写入器（`packages/ai/baseline.js:110` 当前缺 writer 时降级 events 滚动窗口） |

### 非目标（明确不做）

- 不做跨团队/跨租户的聚合计费主体（计量按 `team_id` 边界内统计；`accounts=false` 单租户部署 `team_id=''`）；
- 不做"按用户数/按 PV 数/按自定义事件名"等更细维度的计价拆分（首版只四个维度）；
- 不改造 SDK 采集语义（见 §10）。

## 6. 关键设计决策

### 6.1 计量权威源：`usage_daily` 持久化日表，而非 `ingestionMonitor` 内存计数（默认决策）

**倾向：新建 `usage_daily` 表，在采集写入成功点位做 O(1) upsert**，理由：

1. `ingestionMonitor`（`worker.js:23-43`）是 **10min 滚动窗口的内存计数器**，`tick()` 超窗即 `reset()`（line 40-42），Worker 隔离冷启动也归零——它回答"最近 10 分钟入库健康吗"，**回答不了"这个团队上个月用了多少"**。拿内存计数当账本 = 不可核、不可回溯、多实例各算一份。
2. 自监控指标是**全局无租户维度**的（`/api/monitoring/ingestion` 输出 `received/written/failed` 全平台总量），而计费必须按 `team_id`（+ `app_id`）拆分。
3. 结论分工：**自监控继续做健康度诊断；计量走独立 `usage_daily`**。两者做对账——若某天 `usage_daily.events` 与自监控 `written` 量级偏差 > 20%，用量页顶部给"计量疑似异常，建议重算"提示条（P1-4 重算端点兜底）。

**代价与边界**：热路径多一次 D1/PG upsert（`replay_sessions` 多一次会话去重点查）。默认决策是**写入路径内 upsert**（`on conflict` 幂等、单条成本可接受、无需额外定时任务即可近实时），且**计量失败绝不阻断入库**（只 `console.error`）——宁可少记一条（可重算），不可丢用户数据。D1 侧 `METERING_ENABLED≠1` 时这段逻辑首行空转、零开销。

### 6.2 双栈同构方式（Node PG ↔ Worker D1）

| 层 | Node 自托管（`apps/api`） | Cloudflare Worker |
|---|---|---|
| 建表 | `apps/api/src/db.js` `ensureSchema` 追加「D3 对齐 0035」段（复刻 692-757 的注释与列宽惯例） | `cloudflare/migrations/0035_metering.sql`（纯新建表 + 索引，对齐 0034 风格：「新表量级小可直接建索引」） |
| 列宽 | `app_id varchar(64)` 对齐 `applications`；`team_id varchar(32)` 对齐 `teams`（沿用 0033 注释红线） | 同左（D1 无长度强制但逐字对齐，保证 JSON 同形状） |
| 服务层 | `apps/api/src/services/metering-service.js`（对齐 `dsr-service.js` / `experiment-service.js` 分层） | `cloudflare/worker.js` 内联函数（`meteringUpsert` / `meteringUsage`，对齐 DSR/实验的内联风格） |
| 聚合时机 | 写入路径 upsert（PG `on conflict do update`） | 写入路径 upsert（D1 `on conflict do update`）；`METERING_ENABLED≠1` 时**首行空转返回，零开销**（复刻 `syntheticTickW` 范式） |
| 席位维度 | 有效（`accounts=true` 时 team 存在） | 恒空：`accounts=false`（`WORKER_CAPABILITIES.accounts=false`），不写 `seats` 维度，接口返回该维度 `null` 并在 UI 标「当前部署无团队维度」（不静默填 0 冒充） |
| 能力位 | `NODE_CAPABILITIES.metering = true`（随代码发布即得） | `WORKER_CAPABILITIES.metering = false`，`worker.js:431` override 注入 `metering: env.METERING_ENABLED === '1'`；待 QA 在 Worker 侧验证聚合与 `/api/metering/*` 后由 lead 翻 true（原则 #4 兜底，绝不上报未验证能力） |

### 6.3 套餐与配额边界：档位是配置，阈值是两段，提醒复用告警

- **档位入库不入码**：`plans` 表存 `code/quota_json/soft_limit_pct/hard_action`，改档位改数据不发版；`team_plans.quota_override_json` 支持 enterprise 议价覆盖（覆盖优先于档位默认值，UI 标注"已定制"）。
- **两段阈值**：soft（默认 80%）提醒、hard（100%）警示，**同一周期同一维度同一档位只提醒一次**（`quota_events` 唯一约束抑制，避免配额边缘反复刷屏）。
- **提醒通道复用而非新建**：投递走 `packages/alerting.js` `sendChannel` + `channelMatches`（用户已有的飞书/企微/邮件/webhook 配置直接生效）。**唯一改动**：`alerting.js:5` `alertMetrics` 数组登记 `'quota'`——否则 `normalizeChannel` line 78 会把该订阅静默过滤掉，用户配了也收不到（这是个易漏的坑，实现时必须同步改）。
- **留痕分离**：投递事件写 `alert_history`（随 retention 清理），**超限事实写 `quota_events`**（排除在清理外，长期可核）——因为"某月是否超限"是账单/争议凭证，不能随业务数据过期消失。

### 6.4 用量周期与累加：日粒度存储，月粒度求和（不落月度冗余表）

- `period_key = 'YYYY-MM'`，由查询层对 `day ∈ [月初, 月末]` 求和得到月度用量；**不建 `usage_monthly`**——日表已是权威源，再加一张月表就要双写并保证一致，是典型的账本漂移来源。
- 日切用 UTC（`day = floor(ts/86400000)`），与 `retention-service.js` 现有口径一致，避免两套"天"的定义。
- 席位按日快照：月度席位数展示为**当月每日快照的最大值**（而非求和/月末值），符合"这个月最多用过多少席位"的计费直觉。

## 7. 数据模型与接口契约

### 7.1 表结构（双栈同构，`0035_metering.sql` / `apps/api/src/db.js` 对齐）

**`usage_daily`**（权威计量表；**排除在 retention 清理之外**）

| 字段 | 类型 | 说明 |
|---|---|---|
| team_id | varchar(32) not null default '' | 归属团队；`accounts=false` 单租户恒 `''` |
| app_id | varchar(64) not null default '' | 应用；`''` = 团队级（seats 维度用） |
| metric | varchar(24) not null | `events` / `replay_sessions` / `seats` |
| day | integer not null | `yyyyMMdd`（UTC 日切） |
| value | bigint not null default 0 | 当日累计（upsert 累加；seats 为快照值，覆盖写） |
| updated_at | bigint not null | 最后更新时间 |

主键 `primary key (team_id, app_id, metric, day)`；索引 `idx_usage_team_day (team_id, day)`、`idx_usage_app_day (app_id, day)`。
写入：`events`/`replay_sessions` 用 `on conflict ... do update set value = value + 1`；`seats` 用覆盖写（`value = :n`）。

**`plans`**（套餐档位，配置式）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | varchar(32) PK | `plan_` + random（沿用 `randomToken`） |
| code | varchar(32) unique not null | `free` / `pro` / `enterprise` |
| name | varchar(64) not null | 展示名 |
| quota_json | text not null | `{"events":100000,"replay_sessions":1000,"seats":3,"retention_days":7}` |
| soft_limit_pct | integer not null default 80 | 软限百分比 |
| hard_action | varchar(16) not null default 'none' | `none`（P0 全档默认）/ `reject` / `sample_down`（P1 生效） |
| price_hint_json | text | 展示用价格提示（**P0 不参与任何计费逻辑**，仅 UI 文案；缺省不展示） |
| enabled | integer not null default 1 | 下架档位置 0（已绑定团队不受影响） |
| created_at / updated_at | bigint not null | — |

**`team_plans`**（团队 ↔ 档位绑定，含定制覆盖）

| 字段 | 类型 | 说明 |
|---|---|---|
| team_id | varchar(32) PK | 一个团队一条 |
| plan_id | varchar(32) not null | 当前档位 |
| quota_override_json | text | per-team 覆盖（enterprise 议价）；null = 用档位默认 |
| updated_by | varchar(64) | accounts 开启时记录 |
| updated_at | bigint not null | — |

**`quota_events`**（超限事实留痕，排除在 retention 清理外）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | varchar(32) PK | |
| team_id | varchar(32) not null | |
| metric | varchar(24) not null | |
| period_key | varchar(8) not null | `YYYY-MM` |
| level | varchar(8) not null | `soft` / `hard` |
| value / quota | bigint not null | 触发时快照 |
| notified | integer not null default 0 | 通道投递结果 |
| created_at | bigint not null | — |

唯一约束 `uq_quota_event (team_id, metric, period_key, level)`——**同一周期同一档位只触发一次**；索引 `idx_quota_events_team_period (team_id, period_key)`。

### 7.2 接口（Node `apps/api` 与 Worker `cloudflare/worker.js` 同路径同契约，`metering` 能力位 guard 包裹）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/metering/usage` | `meterView` | 当前（或 `?period=YYYY-MM`）周期用量：`{period, periodStart, periodEnd, daysRemaining, metrics:[{metric, used, quota, pct, level:'ok\|soft\|hard'}]}`；`seats` 在 `accounts=false` 时返回 `null` |
| GET | `/api/metering/usage/daily` | `meterView` | `?from&to&appId` → `[{day, events, replay_sessions}]`（MiniLineChart 序列） |
| GET | `/api/metering/usage/by-app` | `meterView` | `?period` → `[{appId, appName, events, replay_sessions, pct}]`（按 events 降序） |
| GET | `/api/metering/plans` | `meterView` | 档位列表（含 quota / soft_limit_pct / hard_action），用于对比表 |
| GET | `/api/metering/plan` | `meterView` | 当前团队档位 + 生效配额（含 override 标记）+ 更新时间/变更人 |
| PUT | `/api/metering/plan` | `meterManage` | 变更档位或写 `quota_override_json`；**降配额需二次确认**（前端 `ElMessageBox`，后端记录 `updated_by`） |
| GET | `/api/metering/quota-events` | `meterView` | 超限历史（按 period 过滤） |

P1 追加：`GET /api/metering/usage/export`（CSV）、`POST /api/metering/recompute?day=YYYYMMDD`（`meterManage`）。
能力未开启时统一 503：`{ error: '用量计量能力未启用（需设置 METERING_ENABLED=1）' }`（复刻 `guardDsrW` 文案范式）。

### 7.3 权限点（`packages/rbac.js` ROLE_MATRIX 追加）

```
// D3 · 用量计量与套餐（PRD 15 §5 P0-8）：用量对本团队全员可见（自助排障）；套餐/配额变更仅 Admin+（owner 恒允许）
meterView:   ['admin', 'member', 'viewer'],
meterManage: ['admin']
```

## 8. UI 设计稿描述（`/usage`，`apps/web/src/views/billing/`，沿用 experiment 列表页范式）

- **用量 Tab `views/billing/usage/index.vue`**：
  - 顶部工具栏：周期选择器（自然月下拉，默认当前月，可回溯；禁用未来月）+ 「口径说明」行（README 原则 #3：自然月 UTC 口径、events=落库事件数、采样丢弃与入库失败不计）。
  - KpiGrid 四卡：本月事件数 / 本月回放会话数 / 当前席位 / 距周期结束天数（席位卡在 `accounts=false` 时显示「—（当前部署无团队维度）」，不填 0 冒充）。
  - 配额进度区：每维度一行——名称 + `el-progress`（`<soft` 绿 / `soft~hard` 橙 / `≥hard` 红）+ 右侧「已用 X / 配额 Y（Z%）」；`quota` 为 `-1` 表示不限（enterprise 定制），文案显示「不限量」。
  - 超限告警条：soft 触发 `el-alert type="warning"`（"事件用量已达配额 82%，超出后可能影响数据接收"），hard 触发 `type="error"`（"事件用量已达配额上限" + 建议动作：升档 / 调采样率 / 联系管理员）；**P0 hard 不宣称"已停止接收"**（因为默认 `hard_action='none'`），文案必须与后端实际动作一致，不许吓唬用户。
  - 按日趋势卡：`MiniLineChart` 双序列（`events` / `replay_sessions`，注：量级差异大时提供序列单独切换）。
  - 按应用拆分表：El-Table（列：应用名 `OverflowTip` / 事件数 / 占比（迷你条） / 回放会话数 / 操作「查看该应用」）。
- **套餐 Tab `views/billing/plans/index.vue`**：
  - 当前套餐卡：档位名 + 配额表 + 定制标记（"已定制"）+ 生效时间 + 最近变更人；右上角「变更套餐」按钮（`meterManage` 才渲染）。
  - 档位对比表：三列 `free/pro/enterprise` + 行（事件数 / 回放会话数 / 席位 / 保留天数 / 软限提醒 / 超限动作），当前档列高亮「当前」+ 置灰不可选；升级/降级走抽屉 → `ElMessageBox` 二次确认（**降配额时明确提示"新配额立即生效，历史用量不做追溯减免"**）。
- **能力位约定**：`metering=false` 时页头 `el-alert`「当前部署不支持用量计量（capability: metering）」，渲染只读占位、不发起任何写请求（对齐 `views/experiment/index.vue:245` 范式）；flag 由 `apps/web/src/composables/useAuth.ts` 新增 `meteringEnabled` computed（对齐 line 96-104 现有 `dsrEnabled/experimentsEnabled`）。
- **交互约定**：长文本一律 `<OverflowTip>`；所有写操作失败 toast 展示服务端 `error` 原文（如 503 门禁文案）；`meterManage` 不足时按钮置灰 + tooltip「需要 Admin 及以上角色」。

## 9. 待确认问题（均给默认决策）

1. **Q1 计量单位的口径：事件是否含被采样丢弃/入库失败？回放按"段"还是按"会话"？** 默认决策：**事件只计实际落库的行**（`events` 写入成功才 upsert，与 `worker.js:215` `written++` 同点位）——理由：① 计费标的是"平台为你存了多少数据"；② 客户端采样丢弃与限流发生在平台边界之外，不可核、不可举证；③ 入库失败若计入等于让用户为平台故障买单。若将来要按"客户端产生量"计费，需 SDK 侧上报被丢弃计数——**那会往 SDK 加计费语义，违反本批红线**，明确不作。**回放按去重会话计**（热路径点查去重，分段续传不重复计，见 P0-2）——理由：客户认知里"一次回访"就是一条，按段计会让长会话客户被动超额，且 D1/PG 两侧段行数语义本就不同（§1），按段计无法双栈对齐。
2. **Q2 hard limit 到达后是拒收（429）还是降级采样？** 默认决策：**P0 全档 `hard_action='none'`——只告警、只警示，不阻断接收**；P1 提供 `reject`（events 返回 429）/ `sample_down`（降采样 + 停录回放）配置，且**先在 free 档灰度验证再放开**。理由：计量与聚合是新代码，一旦有 bug（重复计数、日切错位）就触发拒收，会**打挂客户生产流量且不可逆**——宁可少收钱，不可丢数据/断观测。
3. **Q3 席位如何定义？** 默认决策：`team_members` 中 `status='active'` 的去重 `user_id` 数，**不含 `invited`（未接受不占资源）与 `disabled`**；按日快照，月度展示取当月**每日快照最大值**；owner 恒计入。理由：计费直觉是"这个月最多请了多少人"，而非月末瞬时值；快照化保证历史账单不被后续成员变动追溯改写。
4. **Q4 计量数据保留多久？** 默认决策：`usage_daily` 与 `quota_events` 保留 **25 个自然月**（覆盖 2 年账单与争议期），且**显式排除在 `cleanupExpiredData()` / Worker `cleanup(env)` 的清理清单之外**（当前清理只扫 `events/issues/replays` 等业务表）。理由：账单凭证不能随业务数据过期消失；保留期随 P1-3 历史账单页的回溯范围（24 个月）取值。
5. **Q5 免费档默认值与存量团队如何挂档？** 默认决策：`free` = 事件 10 万/月、回放会话 1,000/月、席位 3、保留 7 天；`pro` = 事件 500 万/月、回放会话 5 万/月、席位 20、保留 30 天；`enterprise` = 配额走 `quota_override_json` 定制、保留 90 天。存量团队（含 `accounts=false` 的单租户部署）**默认挂 `free` 且 P0 不阻断任何行为**（只展示与提醒），避免上线即"存量客户集体超限"的惊吓。
（Worker 侧交付门禁见 §6.2：同批实现、`METERING_ENABLED=1` 默认 false，QA 验证后由 lead 翻 true。）

## 10. 范围红线（明确不做）

- **本批只做计量与配额的展示与提醒，不做真实支付/开票/扣费**：不接支付网关、不生成应收账单、不开票、不做欠费停用、不做自动扣款（P2-1/P2-2 另行立项）。`plans.price_hint_json` 仅作 UI 展示文案，**不参与任何计算**。
- **SDK 保持通用技术底座**：计量全部是服务端聚合（采集写入成功点位的 upsert + 日/月查询），**不在 SDK 核心加任何计费语义**——SDK 不知道"配额/套餐/超限"存在，不新增上报端点、不改事件 schema、不在 SDK 内做任何配额判断。（P1-1 若启用 `reject`，SDK 侧也只是沿用现有 HTTP 429 的退避处理，不新增计费逻辑。）
- 不改造现有自监控语义：`ingestionMonitor` 与 `/api/monitoring/ingestion` 保持"平台健康度"定位，不被计量复用为账本（§6.1）；不做"计量即监控"的职责合并。
- 不新建告警子系统：超限提醒只复用 `packages/alerting.js` 的通道与 `alert_history`，唯一改动是登记 `metric='quota'`（§6.3）。
- 不做强制配额执行（P0）：不自动降采样、不自动停用应用、不自动删除数据。

## 11. 成功指标

- **可核**：任意历史自然月的用量可在 `/usage` 直接查出；`POST /api/metering/recompute?day=`（P1-4）重算结果与页面展示值**完全一致**（同一权威源）。
- **可读性**：管理员在用量页**无需导出**即可回答"本月用了多少、配额多少、哪个应用占大头、哪天冲高"。
- **提醒有效性**：soft 触发后，已配置通道的团队在 1 个周期内收到**恰好一条**提醒（不重复刷屏，`quota_events` 唯一约束保证）。
- **零数据事故**：计量 upsert 失败**从不**导致 `events`/`replays` 写入失败（采集热路径解耦，可通过注入计量异常验证）。
- **门禁正确**：Worker 未设 `METERING_ENABLED=1` 时 `/api/metering/*` 全部 503、采集路径无额外写放大；前端显示「当前部署不支持用量计量」而非静默隐藏。
