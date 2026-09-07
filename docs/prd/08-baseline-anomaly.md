# PRD 08：智能基线异常检测（Baseline Anomaly Detection）

> 优先级：P0 ｜ 里程碑：AI 洞察增强批（接 M2 后，随 AI 主动诊断 P1 同批）｜ SDK 改动：无
> 修订：2026-09-03 初稿——基于 `packages/ai/findings.js` 的 `runScan` 编排与 `ai_findings` 表落地"相对历史基线偏离"检测器
> 上位文档：`outputs/capability-opportunities-next-horizon.md` 第 2 节 B1；`docs/prd/README.md` 全局设计原则
> 关联：复用 `packages/ai/findings.js`（`runScan` + 四类检测器 + `createFindingsRepo`）、`cloudflare/ai-worker.js`（`/api/ai/scan`、`/api/ai/findings`、Cron）、`apps/web/src/views/insight/ai-insights/index.vue`（洞察流）；与 `docs/prd/03-version-quality.md` 阈值/回归逻辑互补不重叠

## 0. 一句话定位

在现有 AI 洞察扫描引擎上**新增一个"相对自身历史基线偏离"检测器**（`baseline-deviation`），让系统自动发现"相比自身历史同期/滚动基线"的缓慢漂移与异常，自动写入 `ai_findings` 进入现有洞察流——**不替换阈值告警，只作为补充**。

---

## 1. 背景与定位

### 1.1 为何做

- 当前告警是**静态阈值**（`03 版本质量`的发布期阈值 + 治理页告警阈值），存在两类问题：
  - **漏报**：真实故障常是"相对自身基线缓慢漂移"（如错误率从 0.5% 一路爬到 2%，从未越过固定阈值线）；
  - **告警疲劳**：固定阈值在业务自然波动（大促、版本节奏）下频繁误报，导致运维麻木。
- AI 洞察扫描引擎（`ai_findings`）已有 `runScan` 编排 + 四类规则检测器（error-cluster / release-regression / perf-regression / metric-drop）+ 洞察流 UI，且扫描均为**廉价规则、不调用 LLM**。新增一类检测器几乎是零新架构。

### 1.2 与现有阈值告警的关系

| 维度 | 静态阈值告警（现有） | 基线偏离检测（本 PRD） |
|---|---|---|
| 判定依据 | 固定数值线 | 自身历史分布（均值/分位 + 离散度） |
| 擅长 | 突刺、明确越线 | 缓慢漂移、相对异常、自适应性 |
| 位置 | 告警中心（独立通道） | 洞察流（与四类洞察同列） |
| 关系 | **保留不动**，本能力只补充其盲区 | 互补；P1 支持"一键转阈值告警规则" |

- **非目标（明确不做什么）**
  - ❌ 不替换 / 不废弃现有阈值告警体系，只填补其漏报与疲劳盲区；
  - ❌ 不引入新的前端页面，完全复用现有 AI 洞察流 UI；
  - ❌ 不改动 SDK（零采集端改动，纯服务端规则）；
  - ❌ 不在扫描热路径调用 LLM（与现有四类检测器一致，保持廉价规则）；
  - ❌ 不做通用业务 BI——北极星仍是"缩短发现异常→定位根因"。

### 1.3 复用点（强复用，无新架构）

- **编排**：`runScan(db, { appId, sinceHours, scopes })` 直接加入 `baseline-deviation` 检测器，去重（`findOpen`）、落库（`insert`）、Cron 触发全部复用。
- **落库**：复用 `ai_findings` 表（scope / object / summary / evidence_json / detail_json / confidence / status / app_id），**无需新增字段**（见 §4）。
- **接口**：复用 `POST /api/ai/scan` 与 `GET /api/ai/findings`，无需新端点。
- **UI**：复用洞察流列表 + 详情抽屉，仅扩展 `SCOPE_LABEL` 映射。

---

## 2. 目标与用户故事

### 2.1 产品目标

- **G1**：自动发现"相比自身历史基线"的异常（错误率 / 性能 / 流量等缓慢漂移），无需人工设阈值。
- **G2**：基线类洞察与现有四类洞察同流呈现，可一键深诊断 / 推送通道 / 转告警规则。
- **G3**：口径透明——每条基线洞察展示"对比窗口、基线值、实测值、偏离 σ"，用户可信、可质疑、可反馈。

### 2.2 用户故事

- 作为 **SRE**，我看到洞察流里一条"错误率 1.8%，历史基线 0.4%±0.2%（偏离 7σ）"的基线偏离卡，而固定阈值（设 5%）从未触发，遂提前介入避免故障扩大。
- 作为 **前端负责人**，新版本灰度期间 LCP 从 1.9s 缓慢爬到 2.6s，基线检测在"还没触达体验红线"时给出趋势预警，我据此回滚灰度。
- 作为 **值班工程师**，收到基线偏离推送后一键转成阈值告警规则，后续同类越线直接走告警中心通道，避免再疲劳。

---

## 3. 需求池

> 优先级：P0 必须随首版交付；P1 应做；P2 长尾。

### P0 · 基线检测器核心（后端 3d + 前端 1d）

- **FR-1 新增检测器 `detectBaselineDeviations`**：对应用级关键指标（默认集见 D2）计算历史基线，检测当前窗口相对基线的偏离。
- **FR-2 基线计算**：滚动基线 = 取最近 `baselineWindowDays`（默认 28）天的同日/同窗口聚合，计算基线中心（均值或中位数）与离散度（标准差或 MAD）。当前窗口实测值来自最近 `sinceHours`（默认 24h）。
- **FR-3 偏离判定**：`|z| = |实测 − 基线中心| / 离散度 ≥ sensitivity`（默认 3σ，可配，见 D4）即判为异常；最小样本门槛（历史天数 / 当前窗口样本数不足则不报，见 D5 预热）。
- **FR-4 写入 `ai_findings`**：`scope='baseline-deviation'`、`object='${metric}:${appId||'global'}'`、`summary` 人话结论、`evidence`=[`metric:...`, `baseline:...`, `observed:...`, `z:...`]、`detail`={baseline, observed, z, window, method}、`confidence` 随 |z| 与样本量上升（封顶 0.95，公式见 FR-5）。
- **FR-5 置信度**：`confidence = min(0.95, 0.5 + z/10)`（z≥3 起），样本不足时下调。
- **FR-6 集成 `runScan`**：默认 `enabled` 列表加入 `'baseline-deviation'`；Cron `scheduled()` 自动纳入（不传 scopes 时全跑）。去重仍走 `findOpen`（7d 窗口，避免同基线异常反复刷屏）。
- **FR-7 UI 接入**：`SCOPE_LABEL` 加 `'baseline-deviation':'基线偏离'`；`scanScopes` 默认值含之；详情抽屉展示"基线值 / 实测值 / 偏离 σ"与"对比窗口、算法"口径注释。

### P1 · 分级、可转告警、按指标配置（后端 + 前端）

- **FR-8 置信度分级展示**：洞察流标签按 |z| 分档（如 🔴≥5σ / 🟠3–5σ），与 error-cluster 视觉区分（见 §5）。
- **FR-9 一键转阈值告警规则**：基线洞察详情提供"转为告警规则"动作，写入现有 `alert_rules`（或治理页阈值配置），复用告警中心通道（与 `03` FR-4 机制一致）。
- **FR-10 按指标类型启用/灵敏度配置**：治理台可开关各基线指标（errorRate / perfAvg / volume）与每应用灵敏度（σ 阈值、基线窗口天数），配置存 `platform_settings`。
- **FR-11 同事件去重（与阈值告警）**：基线洞察与同源阈值告警若指向同一指标异常，洞察流/告警中心可关联展示，避免双重推送疲劳（与 D6 联动）。

### P2 · 季节性、多维度、反馈学习（长尾）

- **FR-12 周期/季节性基线**：支持"同星期同时段"季节基线（需小时级预聚合，见 §4 数据模型），捕捉工作日/周末、时段节律。
- **FR-13 多维度基线**：基线按 release / page / 地域 等维度拆分（object 升维为 `${metric}:${dim}:${value}`）。
- **FR-14 误报反馈学习**：用户 `ignored` 基线洞察反馈回基线器，对其维度降权 / 放宽 σ，降低疲劳（与 `ai_feedback` 机制呼应）。

---

## 4. 数据模型与接口影响

### 4.1 `ai_findings` 表：零字段改动（关键结论）

现有表（`cloudflare/migrations/0019_ai_findings.sql`）字段已完全覆盖基线洞察所需，**无需新增列、无需迁移**：

| 字段 | 基线洞察用法 |
|---|---|
| `scope` | 固定 `'baseline-deviation'` |
| `object` | `'${metric}:${appId}'`（P2 维度扩展为 `'${metric}:${dim}:${value}'`） |
| `summary` | "错误率 1.8%，历史基线 0.4%（偏离 7σ）" |
| `evidence_json` | `["metric:errorRate","baseline:0.004","observed:0.018","z:7.1"]` |
| `detail_json` | `{ metric, baseline, dispersion, observed, z, window, method }` |
| `confidence` | `min(0.95, 0.5 + z/10)` |
| `status` / `app_id` / 时间 | 复用现有 |

去重键仍为 `(scope, object)` + `status='open'` 近 7d（`findOpen`），P0 默认 `object` 不含时间，故同一指标持续偏离每 7d 至多一条——天然抑制刷屏（如需更高频可把窗口哈希进 object，D 系列待定）。

### 4.2 基线数据源（唯一新增 DB 对象，非 `ai_findings` 字段）

基线是"历史对比"，需>30 天历史；而原始 `events` 仅保留 **30 天**（全局原则 #6）。遵循 `02/03` 既有"预聚合日表"模式，新增轻量日聚合表（双端一致，PG `jsonb` / D1 `text(JSON)`）：

```sql
-- 基线指标日聚合（与 event_daily_stats / release_daily_stats 同源维护，由 governance 定时任务批量写入）
create table if not exists metric_daily_stats (
  app_id text not null,
  metric text not null,            -- 'errorRate' | 'perfAvg' | 'volume' | ...
  day    integer not null,         -- yyyyMMdd
  value  real not null,
  samples integer default 0,
  primary key (app_id, metric, day)
);
create index if not exists idx_metric_daily_app_day on metric_daily_stats(app_id, day);
```

- **保留期**：该表保留 **≥180 天**（与 `02/03` 日表一致），满足长窗口基线；原始 `events` 30 天仅作兜底与预热期校验。
- **P0 首发可降级**：若 `metric_daily_stats` 尚未回填，检测器先从 `events` 近 ≤30 天滚动计算基线并打"预热中"标记（见 D1）；预聚合表上线后切换为权威源。
- **双后端一致**：Node(PG) 与 Cloudflare(D1) 均需实现该表与同款查询（全局原则 #4）。

### 4.3 接口：零新端点

| 端点 | 用法 | 变更 |
|---|---|---|
| `POST /api/ai/scan` | `body.scopes` 可含 `'baseline-deviation'`；Cron 默认已纳入 | 仅检测器内部新增，路由零改 |
| `GET /api/ai/findings?scope=baseline-deviation` | 列表/筛选复用 | 零改（已支持 scope 过滤） |
| `POST /api/ai/findings/:id/status` | `ignored` 反馈（P2 FR-14 消费） | 零改 |
| `POST /api/ai/findings/:id/notify` | 推送通道复用 | 零改 |

> P1 的"一键转告警规则"（FR-9）复用现有告警配置写入端点（与 `03` FR-4 同通道），不新增 AI 侧端点。

---

## 5. UI 设计稿描述（复用洞察流，仅差异化呈现）

> 落点：现有 `apps/web/src/views/insight/ai-insights/index.vue`，**不新增页面**。

### 5.1 列表行差异

- 类型列：`SCOPE_LABEL` 新增 `'baseline-deviation':'基线偏离'`，标签用**紫色系**（与 error-cluster 红、perf-regression 橙、metric-drop 蓝、release-regression 青区分）。
- 对象列：显示 `错误率·appX`（指标名 + 应用），而非错误名/版本名。
- 结论列示例：`错误率 1.8%，历史基线 0.4%（偏离 7σ）` —— 一句话含基线对比，符合全局原则"口径透明"。
- 置信度列：复用现有百分比；P1 起按 |z| 加 🔴/🟠 角标。

### 5.2 详情抽屉差异（复用现有 `el-drawer`）

- 描述项新增"基线值 / 实测值 / 偏离 σ / 对比窗口 / 算法(method)"，均来自 `detail_json`，一眼可复核（口径透明）。
- 操作区复用：深诊断（`/api/ai/diagnose`）、推送通道、在助手追问；**P1 增加"转为告警规则"按钮**。
- 视觉区分小结：基线洞察强调"**趋势/相对**"语义，类型标签紫色 + 结论突出"基线 vs 实测 vs σ"三段式；与 error-cluster 的"绝对突增"叙事形成对照，避免用户混淆两类根因。

### 5.3 页头文案

- 现状副标题"错误簇 / 发布回归 / 性能退化 / 指标骤降"补充为"……基线偏离"，扫描类别多选默认勾选 `baseline-deviation`。

---

## 6. 成功指标

- **S1 盲区覆盖**：基线类洞察占全部 `open` 洞察比例 ≥ 20%（验证其补阈值盲区价值）；其中被用户 `resolved`（确认真实故障）的比例 ≥ 40%。
- **S2 误报率（疲劳控制）**：基线洞察被 `ignored` 的比例上线 1 月内 < 35%（FR-14 反馈学习后逐月下降）。
- **S3 发现时效**：基线类洞察命中、且同指标未被阈值告警覆盖的故障，MTTD 较纯阈值基线下降 ≥ 30%（环比 `03` §8 现状基线）。
- **S4 复用度**：新增检测器不引入新前端页 / 新端点；`ai_findings` 字段零改动（架构卫生）。

---

## 7. 待确认问题（D 系列决策点）

| # | 决策 | 现状/建议 |
|---|---|---|
| D1 | 基线数据源 | 推荐新建 `metric_daily_stats` 预聚合表（≥180d）；首发可降级为 events 30 天滚动 + "预热中"标记 |
| D2 | 默认覆盖指标集 | 建议 `{errorRate, perfAvg, volume}`；是否含自定义/业务指标留 P2 |
| D3 | 基线算法 | 滚动均值+标准差（简单）vs 中位数+MAD（抗离群）vs 周期同星期同时段（需小时级表）；P0 先均值+σ，P2 季节 |
| D4 | 默认灵敏度 | 默认 `sensitivity=3`（3σ）；是否按指标分档（性能 2.5σ、错误率 3.5σ）待定 |
| D5 | 预热期 / 跨应用基线 | 新应用前 N 天（建议 14d）不报；是否复用同类应用基线（冷启动）待定 |
| D6 | 与阈值告警去重 | 同源异常是否关联展示、谁优先；P1 一键转规则后是否关闭对应基线洞察，避免疲劳 |
| D7 | 预聚合表保留期 | 建议 ≥180d，与 `02/03` 日表一致；维护进 governance 定时任务 |
| D8 | 双后端实现 | Node(PG) 与 Cloudflare(D1) 同步实现 `detectBaselineDeviations` + `metric_daily_stats`（全局原则 #4）；是否同批排期待定 |

---

## 附录 A：`runScan` 集成点（新增检测器函数签名建议）

`packages/ai/findings.js` 内新增检测器，**完全仿照现有 `detectPerfRegressions` 的返回形状**：

```js
/**
 * 5. 基线偏离：当前窗口 vs 自身历史滚动基线（廉价规则，不调 LLM）
 * @returns Array<{ scope:'baseline-deviation', object, appId, summary, evidence, detail, confidence }>
 */
export async function detectBaselineDeviations(db, { appId, sinceHours = 24, baselineWindowDays = 28, metrics, sensitivity = 3 } = {}) {
  const metricsToScan = metrics || ['errorRate', 'perfAvg', 'volume']
  const findings = []
  for (const metric of metricsToScan) {
    const baseline = await getBaseline(db, { appId, metric, windowDays: baselineWindowDays }) // 读 metric_daily_stats（D1）
    const observed = await getObserved(db, { appId, metric, sinceHours })                      // 读 events / 日表当前窗口
    if (!baseline || baseline.samples < MIN_BASELINE_SAMPLES || observed == null) continue     // D5 预热/样本门槛
    const dispersion = baseline.dispersion || 0
    if (dispersion <= 0) continue
    const z = (observed - baseline.center) / dispersion
    if (Math.abs(z) < sensitivity) continue
    findings.push({
      scope: 'baseline-deviation',
      object: `${metric}:${appId || 'global'}`,
      appId,
      summary: `${METRIC_LABEL[metric]} 当前 ${fmt(observed)}，历史基线 ${fmt(baseline.center)}（偏离 ${z.toFixed(1)}σ）`,
      evidence: [`metric:${metric}`, `baseline:${baseline.center}`, `observed:${observed}`, `z:${z.toFixed(1)}`],
      detail: { metric, baseline: baseline.center, dispersion, observed, z, window: baselineWindowDays, method: 'rolling-mean-std' },
      confidence: Math.min(0.95, 0.5 + Math.abs(z) / 10)
    })
  }
  return findings
}
```

`runScan` 内两处接入（与现有四类并排）：

```js
const enabled = Array.isArray(scopes) && scopes.length
  ? scopes
  : ['error-cluster', 'release-regression', 'perf-regression', 'metric-drop', 'baseline-deviation'] // ← 加入
// ...
  ...(enabled.includes('baseline-deviation') ? await detectBaselineDeviations(db, { appId, sinceHours }) : []), // ← 加入
```

`cloudflare/ai-worker.js` 的 `scheduled()` 不传 `scopes`，天然纳入新检测器；如需灰度可按 `scopes` 显式传参。

> 说明：以上为**函数签名与集成点建议**（非实现），交付物为本 PRD；编码实现由研发按此签名落地。
