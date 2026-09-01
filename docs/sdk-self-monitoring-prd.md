# 特性规格（PRD）：SDK 自监控与采集健康可观测

> 版本：v0.2（已落地对齐）
> 状态：P0 / P1 / P2 核心已实现；R2-2（SDK 心跳探针）待定
> 作者：web-eys-sdk 维护
> 关联事故：2026-08-28 线上采集静默中断（零数据 3 天）
> 实现提交：`778b516`（自监控基座）、`a01d550`（P0 持久化 + P2 diagnostics/控制台卡片）

---

## 0. 现状对齐（2026-08-31）

经代码核对，项目自监控实现**已覆盖 PRD 绝大部分内容，且与原始设计有两处主动优化**：

| PRD 条目 | 实现状态 | 实现位置 | 备注 |
|---|---|---|---|
| R0-1 `ingest_errors` 表 | ⚠️ 主动优化（未建该表） | `maybeIngestionAlert` → `alert_history(metric='ingestion')` | 复用现有告警表 + 告警渠道分发，失败在既有告警 UI/飞书等可见，**比单独建表更优** |
| R0-2 `record()` 异常不再静默 | ✅ 已实现 | `worker.js:198-211` ctx.waitUntil 内逐条 try/catch + 计数 + console.error + 告警 | 与 8.28 根因点一致 |
| R0-3 `/health` 扩展 | ✅ 已实现（增强） | `worker.js:41-135` `healthPayload` 异步返回 `lastWriteTs`/`ingestErrorCount`/`stalledMs` | 含 30s D1 缓存降查询压力；`lastWriteTs` 取真实 D1 `max(ts)`，跨隔离/冷启动仍有效 |
| P1 `SelfMonitor` | ✅ 已实现 | `packages/sdk/src/transport/self-monitor.js` + `monitoring()` / `window.__EYS_MONITOR__` | stats/sent/dropped/retried/health/warnIfDegraded 齐全 |
| P2-R2-1 `/api/diagnostics` | ✅ 已实现 | `worker.js:117-135` + 路由 `:168` | 按 appId 返回 `lastEventTs/eventsLast1h/ingestErrorCount` |
| P2-R2-3 控制台「采集健康」卡片 | ✅ 已实现 | `apps/web/src/views/monitor/overview/index.vue` | 30s 轮询 `/api/monitoring/ingestion`，红/绿展示，可区分「没流量」与「采集挂了」 |
| P2-R2-2 SDK 心跳探针 | ❌ 待定 | — | 见 §7 Q3；建议用轻量 GET 比对方案，避免污染业务指标 |

**结论**：8.28 事故的直接防线（P0 + 控制台卡片 + `/api/diagnostics`）已全部上线。剩余 R2-2 属「SDK 侧也能发现服务端黑洞」的增强项，非阻塞，且需先定污染规避方案，故列为待定。

---

## 1. 问题陈述（Problem Statement）

2026-08-28 10:58（CST）起，线上 `web-collection` 采集**完全静默中断**：`/health` 始终正常、`POST /api/collect` 始终返回 `200 {ok:true}`，但 D1 `events` 表 `max(ts)` 停在这一刻，8/29–8/31 入库量为 0。根因是 `cloudflare/worker.js` 的 `storageWrite()` 调用了未定义的 `run()`，每次写库抛 `ReferenceError: run is not defined`；而 `record()` 在 `ctx.waitUntil(...)` 中执行，**异常被 Cloudflare 静默吞掉**，HTTP 层永远拿到 200。

问题本质：**采集链路的「写库失败」对所有人都是不可见的**——SDK 认为自己发成功了（拿到了 200），运维看 health 也是绿的，业务方看到控制台空空如也却无从判断是「没流量」还是「采集挂了」。直到 3 天后人工核对才发现。

- **谁遇到这个问题**：平台运维/SRE（你本人）、SDK 消费方开发者、看分析控制台的业务方。
- **频率**：本次是首次，但根因是架构性盲区（waitUntil 吞异常 + 200 假象），**任何未来的写库回归都会以同一方式复发**，且无法被现有监控发现。
- **不解决的代价**：数据缺失事故持续数天无人察觉 → 下游分析/告警/漏斗全部建立在「缺数」基础上 → 信任崩塌、排障成本极高。

---

## 2. 目标（Goals）

| # | 目标 | 如何证明成功 |
|---|---|---|
| G1 | **服务端入库失败对运维可见**：任何写库异常在分钟级被监控发现，而非靠人工核对。 | MTTD（平均发现时长）从 3 天降到 < 5 分钟。 |
| G2 | **SDK 消费方能感知发送异常**：消费方应用可在自身 UI 表达对「采集异常」的感知。 | SDK 暴露标准化状态接口，消费方无需读源码即可接入。 |
| G3 | **业务方在控制台看到采集健康红/绿**：不再把「采集挂了」误读为「没流量」。 | 控制台「采集健康」卡片覆盖率 100% 接入应用。 |
| G4 | **不引入新的隐私/性能负担**：自监控本身不能成为采集负载或泄漏源。 | 自监控流量 < 总采集量 1%；不含业务 PII。 |

> 用户目标（G1–G3）与业务目标（G4、降低事故数与排障成本）一致。

---

## 3. 非目标（Non-Goals）

1. **不做自动修复（self-healing）**：v1 只负责「暴露问题」，不自动回滚/重启/重放。原因：自动修复风险高、易掩盖根因，应作为独立后续专项。
2. **不做全链路 APM/trace 大盘**：自监控聚焦「采集与入库」两个环节，不取代现有的 traces / distributed-trace 能力。原因：范围过大，避免与既有链路追踪重叠。
3. **不改变 SDK 默认脱敏策略**：自监控不触碰 `PrivacyMode`/PII 处理。原因：隐私红线独立于可观测性。
4. **不为消费方做采集率 SLA 承诺**：只提供「健康度信号」，不保证达到某采集率。原因：采集率受网络/用户行为影响，非平台单方可控。
5. **不在 v1 做多租户告警分发（邮件/短信/飞书）**：P0 只把信号暴露给 health/接口，告警分发复用既有 alert_channels（属 P2 之后）。原因：避免与通知渠道模板功能耦合。

---

## 4. 用户故事（User Stories）

**P0 — 服务端入库健康（运维视角）**
- 作为平台运维，我希望 `/health` 暴露「最近一次成功入库时间」和「近 1h 入库错误数」，以便监控探针打 health 就能在采集中断时立刻告警，而不必人工核对 D1。
- 作为平台运维，我希望每一次写库失败都被记录到 `ingest_errors` 表（含 app_id/错误/阶段/时间），以便事后定位是哪个应用、哪类写入在失败。

**P1 — SDK 采集可见性（消费方开发者视角）**
- 作为 SDK 消费方开发者，我希望 SDK 内部维护采集计数器（queued/sent/acked/failed/dropped），以便我在调试时一眼看出「发出去没、丢没丢」。
- 作为 SDK 消费方开发者，我希望能监听 `flush`/`error` 事件并调用 `getStats()`，以便把采集状态接到我自己的运维面板。
- 作为 SDK 消费方开发者，我希望配置一个 `onStatus(status)` 回调（或 dev 模式 console 警告），以便当用户端采集异常时，我的应用能弹提示或打点，而不必等平台通知。

**P2 — 端到端回传校验（业务方视角）**
- 作为业务方/运营，我希望在 web 控制台看到一个「采集健康」卡片（最后事件时间、入库速率、错误率、红/绿态），以便区分「真没流量」和「采集挂了」。
- 作为平台运维，我希望 SDK 能发心跳/probe、服务端能回传「近窗口接收到的事件数」，以便从 SDK 侧也能发现「服务端黑洞」（collect 200 但没落库）。

---

## 5. 需求（Requirements）

### P0 — 必须（服务端入库健康）

**R0-1：`ingest_errors` 持久化表**
- ⚠️ **已实现为更优方案**：不新建独立表，改为复用现有 `alert_history` 表，写 `metric='ingestion'`、`level='critical'` 的告警行（见 `maybeIngestionAlert`，`worker.js:140-154`）。
- 优势：失败时自动进入现有告警 UI，并可经既有 `alert_channels`（飞书/钉钉/邮件等）分发，比单独建表更利于「对运维可见」这一目标（G1）。
- 同隔离 60s 内同指纹只写一次（`cooldown` 去抖），跨隔离靠 D1 已有行去重，避免失败风暴刷爆表。

**R0-2：`record()` 异常不再被静默吞掉**
- 改动点：`cloudflare/worker.js:46` 的 `ctx.waitUntil((async () => { for (const event of events) await record(...) })())`。
- 在 `for` 循环内对每个 `record()` 包 `try/catch`；异常时：
  - 写 `ingest_errors`（不抛回，避免影响批内其他事件）；
  - `console.error` 输出（供 `wrangler tail` 抓取，保留既有排障手段）；
  - 更新进程内/表中的 `lastSuccessfulWriteTs`（成功路径才更新）。
- 验收（Given/When/Then）：
  - Given 写库函数抛错
  - When `collect` 收到合法事件
  - Then 响应仍 `200 {ok:true}`（不破坏采集契约），但 `ingest_errors` 多出 1 行，且 `console.error` 可见该错误。

**R0-3：`/health` 扩展健康字段**
- 现状：`/health` 仅返回 ok/version。
- 新增返回：`lastWriteTs`（查 `select max(ts) from events`）、`ingestErrorCount`（近 1h `ingest_errors` 计数）、`lastIngestError`（最近一条错误摘要，可空）。
- 验收：
  - Given 采集正常时
  - When 打 `/health`
  - Then 返回 `lastWriteTs` 为分钟级新鲜值、`ingestErrorCount=0`。
  - Given 写入持续失败 10 分钟
  - When 打 `/health`
  - Then `lastWriteTs` 明显落后于当前时间、`ingestErrorCount>0`。

**R0-4：运维探针/告警指引**
- 文档补充：建议用 uptime 工具每分钟打 `/health`，对 `now - lastWriteTs > 阈值(默认 5min)` 或 `ingestErrorCount>0` 触发告警。
- 技术约束：D1 `select max(ts)` 走索引，开销极低；`ingest_errors` 近 1h 计数同理。

### P1 — 重要（SDK 采集可见性）

**R1-1：SDK 内部采集计数器**
- 在 `sender`/核心层新增 `StatsCollector`：`queued`、`sent`、`acked`、`failed`（transport 非 2xx/网络错）、`dropped`（队列溢出丢弃）、`flushCount`、`lastFlushTs`、`lastError`。
- 计数随 `sendBatch`/`sendExitBatch` 成功/失败实时更新。

**R1-2：状态事件与快照接口**
- `eys.on('flush', ({batchSize, status, ok}))`、`eys.on('error', ({phase, error}))`、`eys.on('stats', snapshot)`（周期性，默认 30s）。
- `eys.getStats()` 返回当前快照对象（JSON 安全，无函数）。

**R1-3：开发期可见性**
- `createEys({ debug })` 开启时，SDK 在 `failed>0` 或 `dropped>0` 时 `console.warn`（带计数与最近错误）。
- 生产默认静默，避免噪音。

**R1-4：可选 `onStatus` 回调**
- `createEys({ onStatus })`：当采集状态在「healthy / degraded(部分失败) / broken(持续失败)」间切换时回调。
- 验收：连续 N 次 flush 失败 → 触发 `onStatus('broken')`；恢复 → `onStatus('healthy')`。消费方据此在自身 UI 弹提示，无需依赖平台通知。

**R1 技术约束**
- 计数器与事件零业务开销：不序列化进事件、不含 PII。
- 不影响现有 `flushInterval`/`batchSize` 行为。

### P2 — 未来（端到端回传校验 + 控制台面板）

**R2-1：服务端诊断接口**
- 新增 `GET /api/diagnostics?appId=`（可鉴权）：返回 `{ receivedLast1h, lastEventTs, errorRate, ingestErrorCount }`，供 SDK/控制台回查「我发的到底有没有落库」。

**R2-2：SDK 心跳/探针（待定）**
- **状态**：未实现。核心价值是让 SDK 消费方在自身运行时也能发现「服务端黑洞」（collect 返回 200 但没落库，即 8.28 场景在 SDK 侧的表现）。
- **推荐方案（避免污染业务指标）**：不新增 `is_probe` 事件，改为 SDK `SelfMonitor` 周期性 `GET /api/diagnostics?appId=<本应用>` 并比对 `lastEventTs` 与本端 `lastSentTs`：
  - 若本端持续发送成功（`sent>0`）但 `diagnostics.lastEventTs` 长时间落后于 `lastSentTs` → 判定「服务端未落库」，触发 `onStatus('server-blackhole')`。
  - 零额外入库事件、零业务指标污染、复用已上线接口，成本极低。
- **前置依赖**：P1 `SelfMonitor` 的 `lastSentTs` 记录（已具备 `sent` 计数，补一个 `lastSentTs` 时间戳即可）。
- **是否实现**：取决于是否要在 SDK 侧（而非仅控制台/运维侧）暴露黑洞信号；非 8.28 防复发必需项，建议作为后续增强。

**R2-3：web 控制台「采集健康」卡片**
- `apps/web` 新增卡片：读取 `/api/diagnostics`，展示最后事件时间、入库速率、错误率，红/绿态；陈旧/错误时高亮提示。
- 验收：采集中断 5min 内，卡片转红并提示「采集可能已中断」，与「无流量」明确区分。

---

## 6. 成功指标（Success Metrics）

### 先行指标（上线后数天–数周）
- **MTTD（采集中断发现时长）**：P0 上线后目标 **< 5 分钟**（基线：本次 3 天）。测量：从 `lastWriteTs` 落后于当前时间起，到告警触发的时间差。
- **`/health` 被监控调用率**：100% 接入应用被 uptime 探针覆盖。
- **SDK `onStatus` 接入率**：消费方应用中启用 `onStatus` 的比例（目标：核心消费方 100%）。
- **SDK `error` 事件触发准确率**：真实失败触发率 vs 误报率（目标误报 < 1%）。

### 滞后指标（数周–数月）
- **数据缺失事故次数**：P0 上线后季度内归零。
- **相关支持工单**：下降 ≥ 80%。
- **控制台采集健康卡片日活关注率**：反映业务方是否真的用它在判断流量。

---

## 7. 开放问题（Open Questions）

| # | 问题 | 负责人 | 是否阻塞 |
|---|---|---|---|
| Q1 | ~~`ingest_errors` 历史保留~~ → 已消解：改用 `alert_history`，沿用其既有保留/清理策略，无需新表治理。 | 工程 | **已消解** |
| Q2 | `/health` 扩展字段当前公开是否安全？是否需要鉴权（复用 x-app-key）？ | 工程/安全 | 非阻塞（健康字段不含 PII，可公开） |
| Q3 | P2 心跳如何避免污染业务指标？ | 工程 | 非阻塞；**推荐 GET `/api/diagnostics` 比对方案**（见 R2-2），零事件污染 |
| Q4 | SDK `onStatus` 默认行为：dev 警告 / 生产静默 / 始终回调？ | 设计/工程 | 非阻塞（建议 dev 警告 + 生产按需 `onStatus`） |
| Q5 | P0 的 `lastWriteTs` 阈值告警（默认 5min）是否合适？不同应用流量差异大（低频应用可能 5min 无事件） | 运维 | 非阻塞（低频应用可配更大阈值或看 `ingestErrorCount`） |

---

## 8. 时间线与分阶段（Timeline & Phasing）

三个阶段**各自独立可交付**，建议顺序推进（符合「先解决一个、再说下一个」）：

- **P0 服务端入库健康**（最高优先，直接防 8.28 复发）
  - 改动仅限 `cloudflare/worker.js` + 1 个 D1 迁移；**无需消费方升级 SDK**。
  - 交付即可被现有 `/health` 监控探针利用。
- **P1 SDK 采集可见性**
  - 改动 `packages/sdk`：新增 StatsCollector + 事件 + `getStats()` + `onStatus`。
  - 需要消费方升级 SDK 版本才能用。
- **P2 端到端回传校验 + 控制台面板**
  - 依赖 P0 的 `diagnostics` 接口与 P1 的心跳；`apps/web` 新增健康卡片。
  - 形成用户可感知红/绿闭环。

**建议落地顺序**：P0 → P1 → P2。P0 应立即排期（它是对 8.28 事故的直接防线）；P1/P2 在 P0 验证稳定后跟进。

---

## 附录：关键代码位置（供实现参考）

- `cloudflare/worker.js:37` `collect()`；**`:46`** `ctx.waitUntil(... record ...)`（静默失败根因点）
- `cloudflare/worker.js:122` `record(env, event, application, ctx)`；写入经 `storageWrite()`（原 `run is not defined` 处）
- `cloudflare/worker.js` `/health` 路由（扩展点 R0-3）
- `packages/sdk` `sender.js`（`sendBatchOnline`/`sendExitBatch`）、`index.js`（`flushAll`、事件发射点）为 P1 改造点
- D1 `events` 表 46 列；`ingest_errors` 为 P0 新增表
