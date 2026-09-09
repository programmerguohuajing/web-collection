# PRD 11：SLO / 错误预算 & 可用性看板（SLO / Error Budget Dashboard）

> 优先级：P1 ｜ 里程碑：M4（Next·P1）｜ SDK 改动：无
> 关联：上位 `outputs/capability-opportunities-next-horizon.md` §B2；复用错误/性能聚合（analytics-service.js + Worker `/api/analytics/*`、`/api/monitoring/*`）、告警中心（alert_channels + alert_deliveries + QStash 投递）、账号/团队地基（D2，`accounts` 能力位）。与 B3 合成监控、E2 API 健康视图天然互补。
> 参考：Google SRE 书《Multi-Window Multi-Burn-Rate Alerts》；参考系统「SLO/可用性」为企业采购硬通货。
> 原则：双后端一致（Node/PG + Cloudflare/D1 同表同接口同能力位，README 原则 #4）；`accounts=false` 时页面/接口不得崩溃；能力未开启须显式「当前部署不支持 SLO」而非静默隐藏（deployment-capabilities 原则）。

## 1. 背景与问题

- 平台已采集错误率、Web Vitals、请求耗时，但只有「单点看板」，技术团队无法向管理层/客户承诺「月度可用性 99.9%」并持续盯预算消耗；
- SRE/技术负责人采购决策的关键依据是 SLO + 错误预算（Google SRE 范式），当前缺失；
- 燃尽告警需求存在，但应复用已建告警中心（飞书/钉钉/企微/Webhook，C2 将加 Slack/PagerDuty），不应另起通道。

**现状盘点（写本 PRD 前已核实，避免重造）**：

- 错误/性能聚合入口已存在：Node `apps/api/src/services/analytics-service.js`（错误率/Web Vitals 聚合）、Worker `/api/analytics/*`、`/api/monitoring/*`；数据源统一为 `events` 表（`type='error'` / `type='perf' metric∈{lcp,fcp,cls,inp}` / `type='perf' metric in ('fetch','xhr')` + `props.status`）。
- 告警中心已存在：`alert_channels` 表（id/type/enabled/config_json/secret_ciphertext/app_ids_json/levels_json/metrics_json）+ `alert_deliveries` + QStash 投递（packages/alerting.js 的 sendChannel/publishDelivery），`alert_history(metric,level,value,app_id,...)` 承载告警记录。
- 账号/团队地基（D2，见 `09-account-team.md`/`10-account-team.md`）已落地：`accounts` 能力位默认 false；`applications.team_id` 已加；跨团队 403/未登录 401 中间件就位；新能力须默认 false 并经 `/api/capabilities` 下发。
- 迁移约定（D1）：自动迁移在 `cloudflare/migrations/` 顺序编号（最新 0025_account_team）；方言 jsonb→TEXT(JSON)、boolean→integer(0/1)、bigserial→INTEGER PRIMARY KEY AUTOINCREMENT；大表索引拆分至 `cloudflare/migrations-manual/`。
- **本 PRD 不新建聚合引擎、不新建告警通道、不新建采集**——全部复用。

## 2. 目标 / 非目标

**目标**

- G1 让技术团队定义并持续盯 SLO（objective / window / SLI 信号），把「错误率/性能达标率」翻译成可用性承诺
- G2 量化可用性：错误预算剩余量 + 多窗口多燃烧率（burn rate），一眼看出「还能烧多久」
- G3 燃烧过快及时告警：复用现有告警通道（飞书/钉钉/企微/Webhook，C2 Slack/PagerDuty）投递 SLO 燃尽告警
- G4 `accounts=false` 时页面/接口不崩溃；能力未开启显式「当前部署不支持」，不静默隐藏（deployment-capabilities 原则）

**非目标**

- 不做全链路 APM（trace 拓扑 / 链路级 SLO 编排属 E2/B3 延伸，不在本期）
- 不做业务 SLO 编排工具（多 SLO 组合、错误预算跨团队调配、SLO 即代码 CI 校验——留 P2/后续）
- 不做合成监控探测（B3 独立交付，与 B2 互补，不合并）

## 3. 用户故事

- 作为 SRE，我定义一个「checkout 应用 30 天窗口、错误率 SLO 99.9%」，以便向管理层承诺可用性并持续盯预算。
- 作为 SRE，我查看某 SLO 的剩余错误预算与当前燃烧率，以便判断「这次故障会不会把月度预算烧光」。
- 作为 技术负责人，我看达标率趋势时序图（按日），以便周报引用「本月 SLO 达成 99.94%」。
- 作为 on-call，燃烧率突破 14.4× 阈值时通过飞书收到燃尽告警（page 级），以便立即介入止损。
- 作为 前端负责人，我按应用/版本/环境拆分 SLO（如 prod vs canary），以便灰度发布不影响主 SLO 判定。

## 4. 需求池

> P0 = 首版交付；P1 = 应做；P2 = 长尾。⚠️ = 依赖后端双栈改造（Node/PG + Cloudflare/D1，同表同接口同能力位，原则 #4）。每条标注 复用/新建。

### P0 · SLO 定义 + 预算 + 燃尽告警（核心）⚠️

- **FR-1 SLO 定义 CRUD（新建表，复用 events 聚合）**：objective(%)，window(28d/30d)，sli_type ∈ {error_rate, latency_threshold, availability}，sli_config jsonb（信号参数）。列表/详情/编辑/删除。⚠️
- **FR-2 错误预算计算（复用 events 聚合）**：预算 = 1 − objective（如 99.9% → 0.1%）；窗口内已消耗 = (1 − 实际达标率) × 窗口；剩余预算 = 预算 − 已消耗。达标率由 events 现聚合算出（映射见 §6）。⚠️
- **FR-3 多窗口多燃烧率（Multi-Window Multi-Burn-Rate，复用 alert_history + alert_channels 投递）**：内置 Google SRE 书阈值表（1h×14.4、6h×6、3d×3、30d×1，配长短窗口）；燃烧率 = (1 − 实际达标率)/(1 − objective)。突破即写 `alert_history(metric='slo_burn', level=warning|critical)` 并复用 sendChannel 经现有通道投递。⚠️
- **FR-4 燃尽告警复用现有告警通道（复用，不新建通道）**：SLO 燃尽告警绑定现有 `alert_channels`（按 channel 的 metrics_json 含 `slo_burn` + levels_json 过滤 severity + app_ids_json 过滤应用）；C2 的 Slack/PagerDuty 自动覆盖。⚠️
- **FR-5 `slo` 能力位（复用 accounts 机制，默认 false）**：`CAPABILITY_KEYS` 登记 `slo`，`NODE_CAPABILITIES`/`WORKER_CAPABILITIES` 默认 false；前端按 `slo=false` 显式「当前部署不支持」而非隐藏入口。⚠️
- **FR-6 `accounts=false` 安全（复用 accounts 中间件）**：`/api/slo*` 未开启 accounts 时按单租户（app_id 全局可见）；开启时按 team_id 过滤（applications.team_id）；跨 team → 403。⚠️
- **FR-7 SLI 信号映射（复用 events 聚合，映射规则见 §6 + 开放问题 Q1）**：error_rate / latency_threshold / availability 三种信号均从 events 现聚合派生，无新采集。⚠️

### P1 · 可视化 + 拆分 ⚠️

- **FR-8 SLO 列表页（新建前端，复用列表组件）**：列 名称 / 目标 / 窗口 / 剩余预算 / 状态（达标·告警·燃尽）；长文本用 `<OverflowTip>`（禁原生 show-overflow-tooltip，EP 2.14 红线）。
- **FR-9 SLO 详情页（新建前端，复用图表组件）**：错误预算燃烧率图 + 达标率趋势时序图（按日）+ 告警策略配置卡。
- **FR-10 达标率趋势时序（复用 events 聚合，按日桶）**：近 30 天达标率曲线；页头口径条展示 SLI 定义与分母。
- **FR-11 预算燃尽消耗条/甘特（新建前端组件）**：窗口内预算消耗进度 + 预测燃尽时刻。
- **FR-12 按应用/版本/环境维度拆分（复用 release_name / 采集端维度）**：SLO 可绑定 app_id + 可选 release_name/环境过滤，详情页支持维度切换。

### P2 · 联动 + 导出

- **FR-13 SLO ↔ 现有告警规则一键转换（复用 alert_channels 规则模型）**：把 SLO 燃烧率阈值一键生成 alert rule（复用现有阈值告警定义结构）。
- **FR-14 导出（复用现有导出脱敏规则，受 07 等级约束）**：SLO 列表/详情 CSV 导出；L2 及以下受 07 等级裁剪。

## 5. 接口设计

```
POST   /api/slo                     → 创建/更新（body 带 id 即更新，沿用 saveFunnel 风格）
GET    /api/slo                     → 列表（按 app_id；accounts 下按 team_id 过滤）
GET    /api/slo/{id}                → 详情（当前预算/燃烧率/状态）
DELETE /api/slo/{id}                → 删除
GET    /api/slo/{id}/budget?window= → 错误预算 + 燃烧率（快照或查询时计算，见开放问题 Q2）
GET    /api/slo/{id}/trend?start=&end= → 达标率时序（按日桶）
POST   /api/slo/{id}/alert-policy   → 多窗口多燃烧率告警策略（severity 阈值 + 绑定 channel_ids）
```

- 双后端一致：Node(PG) 与 Cloudflare(D1) 同路由同步实现；`slo` 能力位未开时接口返回 `{ error:'SLO 能力未启用' }` 且前端显式提示，不静默失败。
- 燃尽告警不新增通道：突破阈值 → 写 `alert_history(metric='slo_burn', level, value, app_id, slo_id)` → 复用 `sendChannel` + QStash 投递至 metrics_json 含 `slo_burn` 的通道。

## 6. 数据模型

```sql
-- 0027_slo_definitions.sql（自动迁移；D1 方言：jsonb→TEXT(JSON)，boolean→integer(0/1)）
create table if not exists slo_definitions (
  id           varchar(32) primary key,
  app_id       varchar(32) not null,
  team_id      varchar(32),                -- 复用 D2 applications.team_id 归属；accounts=false 时 NULL
  name         varchar(80) not null,
  objective    real not null,             -- 0.999 等
  window_days  integer not null default 30,   -- 28 | 30
  sli_type     varchar(16) not null,       -- error_rate | latency_threshold | availability
  sli_config   text not null default '{}', -- jsonb→TEXT(JSON)；见下映射
  alert_policy text not null default '{}', -- 多窗口燃烧率阈值 + channel_ids（severity→[channelId]）
  created_by   varchar(32),
  created_at   bigint not null,
  updated_at   bigint not null
);
-- 0028_slo_burn_snapshots.sql（见 Q2 推荐：定时 Worker 写入，供趋势/仪表盘/告警判定）
create table if not exists slo_burn_snapshots (
  id           varchar(32) primary key,
  slo_id       varchar(32) not null,
  snap_at      bigint not null,           -- 快照时刻
  window_start bigint not null,
  window_end   bigint not null,
  good_ratio   real not null,             -- 窗口内实际达标率
  budget_used  real not null,             -- 已消耗预算比例(0~1+)
  burn_rate    real not null,             -- 当前燃烧率
  status       varchar(12) not null       -- healthy | warning | burnt
);
-- 大表索引拆分 → cloudflare/migrations-manual/0029_slo_indexes.sql
--   idx_slo_team_app(team_id, app_id, updated_at desc)、idx_burn_slo(slo_id, snap_at desc)
```

**SLI 信号 → events 映射（复用现聚合，默认口径；细节见开放问题 Q1）**

| sli_type | 分子（bad） | 分母（total） | 来源 events |
|---|---|---|---|
| error_rate | `count(type='error')` | `count(type='page_view')`（或 distinct session_id） | `type='error'` / `type='page_view'` |
| latency_threshold | 样本数 − `value ≤ 阈值` 的样本 | Web Vitals 样本数 | `type='perf' metric∈{lcp,fcp,cls,inp}` |
| availability | `props.status ≥ 400` 的 fetch/xhr 请求数 | fetch/xhr 请求总数 | `type='perf' metric in ('fetch','xhr')`（与 E2 api-health 同源） |

- `latency_threshold` 默认阈值（Google "good"，可于 sli_config 按 SLO 覆盖）：LCP ≤ 2500ms、FCP ≤ 1800ms、CLS ≤ 0.1、INP ≤ 200ms。
- 窗口内达标率沿用 analytics-service.js 现有聚合（错误率 / Web Vitals value 过滤），不重写。
- 计算策略 Q2 给出推荐：定时 Worker 写 `slo_burn_snapshots`（仪表盘/趋势快读、告警判定解耦），查询时计算作为 ad-hoc 长窗口补充。

**多窗口多燃烧率阈值表（Google SRE 书，FR-3 内置）**

| 预算消耗 | 长窗口 | 长燃烧率 | 短窗口 | 短燃烧率 | 严重级（level） |
|---|---|---|---|---|---|
| 2% / 1h | 1h | 14.4 | 5m | 19 | critical（page） |
| 5% / 6h | 6h | 6 | 30m | 12 | critical（page） |
| 10% / 3d | 3d | 3 | 2h | 6 | warning（ticket） |
| 100% / 30d | 30d | 1 | — | — | warning（ticket） |

## 7. 边界与异常

| 场景 | 行为 |
|---|---|
| accounts=false | 单租户全局可见；`/api/slo*` 不校验 team；页面正常渲染 |
| slo=false（能力未开） | 接口返回明确错误；前端显式「当前部署不支持 SLO」，不隐藏入口、不崩溃 |
| events 窗口无数据 | 达标率按 100%（无坏样本）或标注「无数据」，不做假数据；预算视为未消耗 |
| 窗口 > events 保留期（30d，README 原则 #6） | 仅支持 28d/30d；>30d 拒绝并提示 |
| 燃烧率计算延迟 | 用最近一次 snapshot；标注「数据延迟 N 分钟」 |
| 告警通道故障 | 复用现有 alert_deliveries 重试/QStash；不新建重试逻辑 |

## 8. 成功指标

- 上线 1 月：创建 SLO ≥ 3 个、周活跃查看 ≥ 5 次（SRE/技术负责人）
- 燃尽告警 → 飞书/钉钉投递成功率 ≥ 99%（复用通道 SLA）
- 通过 SLO 看板发现的可用性风险数（定性收集，进入客户采购对话）

## 9. 里程碑

- M4-a（P0）：SLO 定义 CRUD + 预算计算 + 多窗口多燃烧率 + 燃尽告警复用通道 + `slo` 能力位 + accounts 安全。
- M4-b（P1）：列表/详情页 + 达标率趋势 + 燃尽消耗条 + 维度拆分。
- M4-c（P2）：SLO↔告警规则一键转换 + 导出。

## 10. 开放问题（Open Questions）

1. **Q1 SLI 信号映射口径**：error_rate 分母用「页面视图事件数（type='page_view'）」还是「会话去重数（distinct session_id）」？latency_threshold 用单次样本达标率还是会话级？建议 error_rate 用页面视图事件数（简单、与现错误率看板一致），latency_threshold 用样本级（Web Vitals 本就是样本指标）；需用真实数据验证分母选择对预算的影响。
2. **Q2 燃烧率计算时机**：定时 Worker 写 `slo_burn_snapshots`（推荐）vs 查询时计算。**推荐定时快照**：仪表盘/趋势快读、告警判定与查询解耦、短窗口燃烧率（5m/30m）可在告警 cadence 稳定评估；代价是存储增量 + 快照延迟（标注）。查询时计算仅作 ad-hoc 长窗口补充。调度复用现有 QStash（与 alert deliveries 同链路）。
3. **Q3 与 D2 团队归属/可见性**：SLO 是否强制带 team_id？建议 SLO 继承 app_id 的 team_id（applications.team_id），不单独建 team 绑定；accounts=false 时 team_id=NULL 全局可见。`created_by` 取自成员，未登录时 NULL。
4. **Q4 accounts=false 时的可见性**：存量自托管（accounts=false）SLO 页是否默认可见？建议可见（单租户无隔离需求），仅 `slo` 能力位控制入口；accounts 开启后按 team 过滤。
5. **Q5 与 B3/E2 的关系**：B3 合成监控可用性可直接作为 availability SLO 的 SLI 来源（复用），E2 API 健康视图与 availability SLO 共享请求聚合——是否在本期接入 B3 探针数据？建议首版仅用 RUM events（error_rate/latency/availability from fetch·xhr），B3 探针数据作为后续 SLI 源接入。
