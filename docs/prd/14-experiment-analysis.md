# PRD 14：A3 实验分析（A/B 实验平台：Feature Flag + 变体分流 + 实验报告）

> 状态：Draft（简单 PRD） · 优先级：P1 · 作者：PM · 预估：后端 5d + SDK 2d + 前端 3d
> 上游：A3 实验分析需求；复用 PRD 04 远程配置下发链路与现有 events/session 数据
> 原则：双后端一致（Node/PG + Cloudflare/D1 同表同接口同能力位，README 原则 #4）；`experiments` 能力位默认 false，Worker env 门禁（slo/synthetic/dsr 同范式）；未开启时显式「当前部署不支持实验分析」而非静默隐藏。
> **范围红线（用户明确原则）**：SDK 仍是通用技术底座，**实验业务契约不进 SDK 核心**。SDK 侧只新增两个通用原语——「配置化变体消费（稳定分桶）+ 曝光上报」，不知道"实验"语义；实验的定义/管理/分析全部在后端与应用层。

## 1. 背景与现状锚点（代码核实结论）

- 现状缺口：平台有完整的被动观测（错误/性能/会话/漏斗），但接入方发版只能"全量一刀切"——无法回答"新方案 vs 旧方案哪个转化率更高/错误率更低"，也没有灰度放量与对照归因的载体。
- 已有可复用基建（本 PRD 全部写明复用关系，不重复造轮子）：

| 基建 | 位置 | A3 复用方式 |
|---|---|---|
| 配置下发链路 | `GET /sdk-config`（SDK `packages/sdk/src/config/remote-config.js` 启动 + 每 5min ETag 轮询，normalize 白名单钳位） | 实验定义随 collect-config 的 `experiments` 块搭车下发（per-app 静态数据，保住共享 ETag 304 缓存） |
| 稳定分桶素材 | SDK 双 ID 模型：`deviceId/anonymousId`（localStorage 持久，`utils/id.js getId`）+ `sessionId`（sessionStorage）；已用于确定性采样（U06 一致性采样同思想） | 分桶哈希键复用 `anonymousId`（跨会话稳定，转化归因不漂移），降级 `sessionId` |
| 曝光事件 | behavior 插件已有 `exposure` 子类型（`core/event.js:54`，独立分类、独立采样位）+ exposure 插件开关（`collect-config.js PLUGIN_KEYS`） | 变体曝光复用 `exposure` 事件通道，`props` 带 `experiment_key`/`variant` |
| 能力位 | `packages/deployment-capabilities.js`（CAPABILITY_KEYS + NODE_/WORKER_CAPABILITIES + buildCapabilities overrides）；Worker `/api/capabilities` override（`worker.js:424`，synthetic/dsr 同范式） | 新增能力位 `experiments`，Worker env `EXPERIMENTS_ENABLED=1` 门禁 |
| RBAC | `packages/rbac.js` ROLE_MATRIX（camelCase 键，owner 恒放行） | 新增 `expView/expCreate/expUpdate/expArchive` |
| 数据底座 | `events`/`sessions`（双栈同构，app_id varchar(64)）；事件 `type/name/props_json`；错误/会话时长口径已有 | 目标指标直接在曝光 cohort 上聚合，不新建指标采集 |
| 前端范式 | `apps/web/src/views/monitor/synthetic/`（列表 index.vue + 详情 detail.vue）；长文本 `<OverflowTip>`（EP 2.14 红线，禁用原生 show-overflow-tooltip） | `/experiments` 两页 + 抽屉表单沿用 |
| 表迁移 | `cloudflare/migrations/` 最新 0033_dsr_tables | 新增 `0034_experiments.sql`（experiments + experiment_exposures） |

## 2. 产品目标

让接入方在平台内完成「建实验 → SDK 按变体分流 → 曝光与业务数据自动汇聚 → 对照分析报告」的 A/B 闭环，**零新增采集链路**。

- **G1 分流可信**：同一访客稳定命中同一变体（一致性哈希），流量百分比分流准确可复核（曝光数据反验实际分流比）。
- **G2 分析可读**：实验详情页按变体对比 会话数 / 错误率 / 目标转化率，附样本量提示，避免在小样本上误判。
- **G3 治理可控**：能力位 + RBAC 门禁，同一 key 全局仅一个 running 实验防打架，实验全生命周期状态机留痕。

## 3. 用户故事

- As a **接入方开发者**, I want 在平台创建实验（key + 2~3 个变体 + 流量百分比），并拿到 SDK 消费代码片段, so that 业务代码 `if (variant === 'B')` 渲染新方案且改动最小。
- As a **接入方开发者**, I want 同一访客刷新/跨会话始终命中同一变体, so that 用户不出现"方案闪变"，归因不串组。
- As a **数据分析师**, I want 实验详情页看到各变体的曝光数/会话数/错误率/目标事件转化率对比, so that 我能判断哪个变体胜出、样本是否足够。
- As a **平台管理员**, I want 实验有 draft→running→paused→completed→archived 状态机，且同一 key 只能有一个 running, so that 不会出现两个实验抢同一业务开关的打架事故。
- As a **自托管部署者**, I want Worker 部署上实验能力默认关闭（env 门禁）, so that 未验证能力不静默暴露给存量客户。

## 4. 核心概念定义

| 概念 | 定义 |
|---|---|
| 实验 experiment | 同一 app_id 下围绕一个业务 key（如 `checkout-button`）的对照试验，含变体集合、分流比例、目标指标、状态机 |
| 变体 variant | 实验的一个分组，**必含 `control`（对照组，即现状）**，可加 1~2 个 treatment；SDK/业务代码按 variant 名执行不同逻辑 |
| 分流 allocation % | 每变体的流量百分比（合计 ≤100%，未分配部分=不参与实验）；按一致性哈希稳定分桶 |
| 目标指标 goal metric | 复用现有数据的度量：①转化事件（指定 event name 在曝光后出现）②错误率（曝光会话中 error 事件占比）③会话时长。首版三选一 |
| 曝光 exposure | 访客首次被判定命中某变体并实际消费该变体时上报的 `exposure` 事件（props 带 `experiment_key`/`variant`），是分析的最小归因单元 |

## 5. 需求池

### P0（Must have）

| # | 需求 | 说明 |
|---|---|---|
| P0-1 | 实验表 `experiments` + 曝光表 `experiment_exposures`（双栈同构） | 见 §7.1；迁移 `0034_experiments.sql`；Node 侧 PG 同构建表 |
| P0-2 | 实验 CRUD + 变体管理 | 创建/编辑：key（`^[a-z0-9_-]{2,64}$` 全局唯一）、name、变体列表（必含 control，name 唯一，weight 合计校验）、traffic_pct、goal_metric（type + event_name）；删除仅 archived 可物理删（级联删曝光） |
| P0-3 | SDK 通用原语：配置化变体消费 | collect-config 新增 `experiments` 块（running 实验的 key/salt/traffic/variants）；SDK `remote-config.js` normalize 白名单透传；新增通用 API `getVariant(key)`：fnv-1a(`salt:key:bucketingId`) % 10000 → 桶号 → 累积权重落段判定；不含任何实验业务语义 |
| P0-4 | SDK 通用原语：曝光上报 | `getVariant` 首次命中非空变体时经现有 exposure 事件通道上报（props：`experiment_key`/`variant`/`bucketing`），复用 behavior 采样与限流，无新增上报端点 |
| P0-5 | 曝光入库 | 采集端识别 `exposure` 事件且 props 含 `experiment_key` 且实验 running → 写 `experiment_exposures`（同一 visitor 同实验仅记首条，冲突忽略）；experiments 能力位关闭时仅按普通事件入库不建曝光记录 |
| P0-6 | 实验详情分析 | 按变体聚合曝光 cohort：曝光数 / 去重访客数 / 关联会话数 / 错误率 / 目标转化率（各变体列对比 + 相对差值）；样本量低于阈值（默认每变体 ≥ 100 曝光）显示"样本不足"提示条，**不做显著性判定**（防伪科学） |
| P0-7 | 能力位 `experiments` | CAPABILITY_KEYS 登记；Node 默认 true；Worker 默认 false + `EXPERIMENTS_ENABLED=1` 门禁（worker.js:424 buildCapabilities override，dsr 同范式）；采集端 exposure 入库路由同样门禁 |
| P0-8 | RBAC 权限点 | `expView: ['admin','member','viewer']`；`expCreate/expUpdate: ['admin','member']`；`expArchive: ['admin']`（owner 恒放行，rbac.js ROLE_MATRIX） |
| P0-9 | accounts 安全 | 复用 D2：按 `applications.team_id` 过滤，跨 team 403；accounts=false 时单租户全局可见 |

### P1（Should have）

| # | 需求 | 说明 |
|---|---|---|
| P1-1 | 状态机 | draft → running → paused ⇄ running → completed → archived；仅 running 产生曝光与下发；每次迁移写 updated_by，非法迁移服务端拒绝 |
| P1-2 | 防打架 | 同一 app_id + key 仅允许一个 running；置 running 时服务端校验冲突（含 paused 复活场景），拒绝并返回冲突实验信息 |
| P1-3 | 分析时间序列 | 详情页按天时间序列（各变体曝光数/转化率折线，复用 MiniLineChart 范式），保留期随 events 30d 口径 |
| P1-4 | 代码片段生成 | 详情页输出该实验的接入示例片段（getVariant 调用 + 分支模板），降低接入成本 |

### P2（Nice to have）

| # | 需求 | 说明 |
|---|---|---|
| P2-1 | 自动显著性判定 | 样本量充足时计算置信区间/双比例检验，明确标注统计口径与前置条件 |
| P2-2 | 分层实验 / 互斥组 | 实验分层（layer）使不同层实验正交分流，同层互斥 |
| P2-3 | 可视化变体编辑器 | 所见即所得配置变体差异（依赖业务侧埋点约定，先不做） |

## 6. 关键设计决策

### 6.1 分流下发：定义走 `/sdk-config`，分桶在 SDK 客户端完成（默认决策）

**倾向：合并进 `/sdk-config` collect-config + 客户端一致性分桶**，理由：

1. `/sdk-config` 已被 SDK 每 5min ETag 轮询，实验**定义**（key/salt/权重）是 per-app 静态数据，搭车零新增请求；若走独立 `GET /api/experiments/assignment?visitor_id=...`，则命中结果是 per-visitor 的——ETag 共享缓存失效、D1 每请求查实验表、高频访客下成本和时延都不可控。
2. 一致性哈希分桶是确定性计算，**不需要服务端裁决**：SDK 拿到定义即可本地算出稳定变体，离线/降级安全（拉不到配置 → `getVariant` 返回 null，业务走默认逻辑，符合 PRD 04 失效安全契约）。
3. 服务端通过曝光数据反验实际分流比（详情页展示"配置比例 vs 实际比例"），漂移即暴露——监控闭环替代强一致裁决。

**代价与边界**：客户端分桶意味着"命中"依赖配置新鲜度（实验刚置 running 时最多 5min 内部分访客拿旧配置未命中，曝光 cohort 从生效起算，不影响对照公平性）；若未来需要"服务端强裁决/跨端一致"，独立 assignment 接口作为 P2 演进（见 §9 Q2）。

### 6.2 分桶算法（双栈与 SDK 三端一致，纯函数抽 `packages/experiment-bucket.js` 共享）

```
bucket = fnv1a32(`${salt}:${experiment_key}:${bucketing_id}`) % 10000   // 0..9999
cum = 0; 遍历 variants（按 weight 降序，control 优先）
  cum += weight * traffic_pct / total_weight
  if bucket < cum*100 → hit variant
若 bucket ≥ traffic_pct*100 → 未命中（不参与实验，返回 null）
```

- `bucketing_id` 默认 `anonymousId`（localStorage 持久、跨会话稳定、转化归因不漂移）；storage 不可用降级 `sessionId`（仅当次会话稳定）。不使用 `userId`（登录前即需分流，且引入 PII 关联面）。
- 同一 visitor 任意次请求/刷新结果一致；权重或 traffic_pct 变更视为**实验修改**（仅 draft 可改，running 修改需走 paused → 编辑 → running，P1 状态机保证 cohort 内不漂移）。

### 6.3 目标指标口径（全部在曝光 cohort 内计算，零新增采集）

| 指标 | 口径 |
|---|---|
| 曝光数 / 访客数 | experiment_exposures 按变体 count / count(distinct visitor_id) |
| 会话数 | 曝光访客在曝光时刻后产生的 sessions 数（session_id 关联） |
| 错误率 | 曝光会话中含 `type='error'` 事件的会话占比（复用现有错误口径） |
| 目标转化率 | goal_metric=conversion_event：曝光后 T 窗口内（默认 7d）出现指定 event name 的访客占比；=session_duration：曝光会话平均时长 |

## 7. 数据模型与接口契约

### 7.1 `experiments`（双栈同构）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | varchar(32) PK | `exp_` + random |
| app_id | varchar(64) not null | 挂靠应用 |
| team_id | varchar(32) | 继承 applications.team_id |
| key | varchar(64) not null | 实验 key，app 内唯一；同一时刻仅一个 running |
| name | varchar(80) not null | 展示名 |
| description | varchar(512) | 可选说明 |
| status | varchar(16) | draft/running/paused/completed/archived |
| salt | varchar(32) not null | 分桶盐（创建时生成，防 key 可预测） |
| traffic_pct | integer | 0–100，参与实验的流量占比 |
| variants_json | text(JSON) | `[{name:'control',weight:50},{name:'treatment_b',weight:50}]`，control 必含 |
| goal_metric_json | text(JSON) | `{type:'conversion_event'\|'error_rate'\|'session_duration', event_name?, window_days?}` |
| started_at / ended_at | bigint | running/completed 时间 |
| created_by / updated_by | varchar(64) | accounts 开启时记录 |
| created_at / updated_at | bigint | — |

### 7.2 `experiment_exposures`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | varchar(32) PK | |
| experiment_id | varchar(32) not null | FK → experiments |
| app_id / team_id | varchar | 冗余，便于过滤 |
| visitor_id | varchar(64) not null | 分桶 ID（anonymousId） |
| session_id | varchar(64) | 首次曝光所在会话 |
| variant | varchar(32) not null | 命中变体名 |
| exposed_at | bigint | 曝光时刻（索引列；`(experiment_id, variant, exposed_at)` 联合索引） |

唯一约束（去重）：`(experiment_id, visitor_id)`——同一访客只记首条。过期清理挂现有 cleanup cron（17 3 * * *），默认保留 30d（与 events 对齐）。

### 7.3 接口（Node 与 Worker 同路径同契约；`experiments` 能力位 guard 包裹）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/experiments` | `expCreate` | 创建/更新（body 带 id 即更新，saveFunnel 风格）；running 状态不可改定义 |
| GET | `/api/experiments` | `expView` | 列表（app_id 过滤 + team 过滤），含 status/曝光数摘要 |
| GET | `/api/experiments/:id` | `expView` | 详情 |
| GET | `/api/experiments/:id/report` | `expView` | 分析报告：各变体指标对比（§6.3）+ 样本量提示 + 配置比 vs 实际比 |
| POST | `/api/experiments/:id/status` | `expUpdate` | 状态迁移（P1 状态机校验 + 防打架校验） |
| DELETE | `/api/experiments/:id` | `expArchive` | 仅 archived 可删，级联删曝光 |

SDK 侧无新端点：定义走 `/sdk-config`，曝光走 `/api/collect`。能力未开启时接口返回 `{ error: '实验分析能力未启用' }`。

## 8. UI 设计稿描述（`/experiments`，`apps/web/src/views/experiment/`，沿用 synthetic 列表+详情范式）

- **实验列表页 `index.vue`**：顶部 KpiGrid（running 数 / 本周新增曝光 / 样本不足实验数）+ El-Table（列：name（OverflowTip）/ key（OverflowTip）/ 状态 tag（draft 灰·running 绿·paused 橙·completed 蓝·archived 灰）/ traffic_pct / 变体数 / 曝光数 / 目标指标 / 开始时间 / 操作（编辑·启停·归档·删除））。新建/编辑走抽屉表单：基本信息（key 自动生成 slug 可改）→ 变体管理（动态行编辑 name/weight，control 固定首行禁删，合计权重实时校验）→ 分流与目标（traffic_pct 滑块 + goal_metric 三选一联动 event_name 输入）。能力位 false 显示「当前部署不支持实验分析」占位（不静默隐藏）。
- **实验详情/分析页 `detail.vue`**：头部状态操作条（状态机按钮，防打架冲突时 toast 冲突实验名）+ 各变体指标对比表（行=变体，列=曝光数/访客数/会话数/错误率/目标转化率/相对 control 差值，胜出高亮；表上方「样本量不足」提示条 el-alert）+ 配置比 vs 实际比一致性条形图（漂移 >5pp 标黄）+ P1：按天时间序列折线（MiniLineChart 范式）+ 接入代码片段卡（复制按钮）。
- **交互约定**：长文本一律 `<OverflowTip>`；所有统计页页头展示口径说明（README 原则 #3：cohort=曝光访客、转化窗口 7d 等）。

## 9. 待确认问题（均给默认决策）

1. **Q1 分桶哈希键用 visitor_id 还是 session_id？** 默认决策：**anonymousId（持久设备 ID）**——跨会话稳定、转化归因不漂移；sessionId 仅作 storage 不可用时的降级。跨设备一致（登录用户合并分桶）为 P2。
2. **Q2 命中结果走 `/sdk-config` 合并下发还是独立 assignment 接口？** 默认决策：**定义合并 `/sdk-config` + SDK 客户端分桶**（§6.1，保 ETag 缓存与失效安全）；独立 `GET /api/experiments/assignment`（服务端强裁决）作 P2 演进项，仅在出现跨端一致或防作弊需求时立项。
3. **Q3 最小样本量怎么提示？** 默认决策：P0 只做**提示不做判定**（每变体曝光 < 100 显示"样本不足，暂勿下结论"提示条）；显著性检验 P2（含口径前置条件），避免上线即"伪显著"误导。
4. **Q4 running 实验能否改权重？** 默认决策：不可直接改——需 paused → 编辑 → running，且修改会导致分桶漂移，详情页标注"配置于 X 日变更过"（updated_at 快照）；如需无漂移调权重，P2 支持只增不减的流量爬坡（ramp-up）。
5. **Q5 曝光去重键冲突（配置未新鲜期）**：访客在实验 running 前已按旧配置未命中、后拉到新配置命中——正常补记首条曝光即可；已记录曝光的访客变体**永不改写**（服务端插入冲突忽略），保证 cohort 内恒定。

## 10. 范围红线（明确不做）

- **SDK 核心不引入实验业务契约**：SDK 不知道"实验"是什么，只提供「给定配置块 + 稳定 ID → 稳定变体」的通用消费原语与曝光上报通道；实验的定义、校验、状态机、分析全部在平台后端/前端。业务方在自己的应用代码里消费 `getVariant(key)` 做分支——SDK 不代埋业务分支、不做服务端渲染注入。
- 不做服务端（Node 应用侧）SDK 的实验分桶（仅 Web 端）；不做跨应用/跨团队实验；不自动停止"显著劣化"的实验（P2 显著性落地后再议）。

## 11. 成功指标

- 上线 1 月：接入应用群（account-shop-admin / app-ts / nuxt）中 ≥ 2 个应用创建过实验，≥ 1 个实验完整走完 running → completed。
- 分流准确性：运行中实验的「实际分流比 vs 配置比」偏差 ≤ 3pp（曝光数据反验）。
- 分析可用性：实验详情页无需导出即可回答"哪个变体错误率/转化率更优、样本是否足够"。
