---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '3538dd59-ba9e-4855-9486-1204301b271c'
  PropagateID: '3538dd59-ba9e-4855-9486-1204301b271c'
  ReservedCode1: 'dbc2ccaa-9a34-4de4-8986-c52266b23252'
  ReservedCode2: 'dbc2ccaa-9a34-4de4-8986-c52266b23252'
---

# Changelog

本项目所有版本发布均由 `vX.Y.Z` tag 触发，GitHub Release / npm 包 / SDK tgz 由 CI 工作流（`.github/workflows/release-npm.yml`）在该 tag 推送时一体产出，版本号以 tag 与 `packages/sdk/package.json` 为准。

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

## [0.6.0] - 2026-09-11

### ⭐ 亮点
- **回放会话治理**：根治「1044 分钟超长会话（883 分钟挂机空白）」「只录到首屏」「回放图片/字体丢失」三类线上问题——SDK 闲置 10 分钟自动切新会话（`replayIdleResetMs`）、60s 分段循环连续录制（`replayContinuous`）、同源图片/字体录制时内联为 dataURI（`replayInlineAssets`）；后端详情 30 分钟跨度截断（截断点锚定全量快照保证可重建），前端展示截断提示条与资源失败占位。
- **采集链路容灾**：D1 配额超限等平台故障期间，`/api/collect` 对采集端永远返回 2xx（fail-open 降级），不再出现 500 风暴；SDK 新增发送熔断——连续失败批次达阈值（默认 5）静默停采，冷却期（默认 5 分钟）后半开探测自动恢复，服务端长故障期间采集端控制台零报错。
- **D1 行读治理（四批）**：日行读从 534 万（超免费版 500 万上限）降至 ~250 万——索引（0038 迁移）、诊断/摘要缓存、小时级预聚合表（0039 迁移）+ summary 缝合、基线日表 EOD writer、缓存 TTL 踩边缘修正（30s 轮询 vs 30s 缓存必 miss）、P75 独立缓存与大窗口跳过。

### ✨ 新功能 (Features)
- **sdk**：回放闲置切分 / 连续录制 / 资源内联三配置项，新增 `replay_session_rotated` 诊断（`8c9cafb`）
- **sdk**：发送熔断 `collectBreakerThreshold` / `collectBreakerCooldownMs`，新增 `circuit_open` / `circuit_half_open` / `circuit_recovered` 诊断事件（`0110d14`）
- **worker**：summary 缝合路径返回 `x-summary-stitch` 响应头，预聚合命中可观测（`cbdb32f`）
- **worker**：`events_hourly_stats` 小时级预聚合 + summary 缝合查询（`204dc20`、`ab5742c`）
- **ai**：`metric_daily_stats` 基线日表 EOD writer + 缺口检测自愈（`204dc20`、`cbdb32f`）
- **web**：AI 洞察未读徽标进入页面即清零（`515ca92`）

### 🐛 缺陷修复 (Fixes)
- **全栈**：测试报告 13 项缺陷一次性修复（BUG-002/004~013）（`98b868d`）
- **replay**：周期快照字段名错误（`checkoutEveryN`→`checkoutEveryNth`）导致首屏后画面消失（`e981734`）
- **replay**：环形缓冲独立留存全量快照，根治回放黑屏（`5d09a04`）
- **replay**：长会话播放中途空白——按录制实例锚定合并事件流（`bc90927`）
- **replay**：回放聚合补全量快照兜底 + 链路入口兼容分段 session_id（`8204379`、`28fc352`）
- **replay**：分段归属竞态（异步 flush 期间分段号已推进导致 end_reason 永不落库）（`8c9cafb`）
- **api**：Node 版回放 gzip 上报被 sanitize 静默丢弃（`8c9cafb`）
- **worker**：入口 HTML 强制 `no-store`，根治 CDN 缓存导致前端部署不生效（`48a2a2b`）
- **worker**：collect 应用配置查询失败 fail-open，不再向采集端报 500（`0110d14`）
- **mcp**：无状态 StreamableHTTP 握手挂起 60s 超时（`c810ea2`）
- **sdk**：采集地址重构为 `baseUrl`+`collectPath`，修复 diagnostics/monitoring 404（`38945bc`）
- **web**：API 端点健康 GET/POST 标签被 flex 压缩截断（`7b53b5c`）
- **web**：事件表类型列截断、最近会话列表时间列截断（`624633b`、`fdbad85`）
- **ci**：SDK 体积上报步骤引用时机过早而静默失败（`5d7a2ff`）

### 🔧 发布说明 / 部署注意
- **SDK (npm)**：`@web-collection/sdk@0.6.0`，`replayContinuous` / 熔断默认开启，`replayInlineAssets` 默认关闭（内网/防盗链场景需显式开启：`replayInlineAssets: true`）。
- **被测页面**：需重新加载才用上 0.6.0 行为（CDN 引用刷新页面即可；npm 集成升级依赖重新构建）。存量超长回放会话已由后端 30 分钟截断兜底。
- **D1**：本版本含 0038（查询性能索引）/ 0039（`events_hourly_stats` 小时表）迁移，已随部署 apply；小时级预聚合复用 `*/5` cron + 小时桶守卫（账户 cron 触发器满额，无法新增）。
- **CDN**：入口 HTML 已改 `no-store`；若 Cloudflare 缓存规则此前已缓存旧 HTML，需手动 Purge Cache 一次。

---

## [0.5.0] - 2026-09-10

### ⭐ 亮点
- **SDK 心跳探针（采集黑洞自愈）**：SDK 周期性把本地写入计数回传服务端比对，自动识别「采集黑洞」（客户端已发但服务端零入库），通过 `onStatus` 回调与 `eys.monitoring()` 暴露 `server-blackhole` 等级；控制台三处采集健康视图同步呈现。
- **留存 / 同期群分析（A1）**：新增留存与同期群分析服务层 + API + 洞察页，按首次访问同期群观测留存曲线。
- **智能基线异常检测（B1）**：新增基线偏离异常检测，Node 与 Cloudflare 双后端接入。
- **知识中枢（kb）**：全栈落地 Article 模型 + 治理台 / 帮助中心双页面，沉淀排障知识。
- **独立 MCP 服务**：新增常驻 MCP Worker，REST 包装 `/api/*` 数据平面并预留 D1 直连，开放 13 个工具供 AI 客户端消费。
- **OTLP 导出**：SDK 新增 `otlp` 选项（默认关），以 http/json 把事件导出到 OpenTelemetry Collector，失败安全。
- **多端 SDK 首发**：`@web-collection/sdk-react-native` 与 `@web-collection/sdk-electron` 随 0.5.0 首发（各自 0.1.0），移动端 / 桌面端接入独立成包。

### ✨ 新功能 (Features)
- **sdk**：心跳探针 `R2-2` —— 周期比对服务端校验采集黑洞（`15d8e8a`）
- **mcp**：新增独立 MCP 服务（REST 包装 + D1 直连可扩展），鉴权改为调用时采集秘钥（`9c83329`、`497c812`）
- **ai**：AI 诊断 Markdown 渲染（`fceff0b`）+ AI 助手消息 Markdown 渲染（`f69c806`）
- **analytics**：留存 / 同期群分析服务层 + API + 洞察页（`dc9954e`）
- **baseline**：智能基线异常检测双后端接入（`75dc7bf`）
- **kb**：知识中枢全栈落地（Article 模型 + 治理台 / 帮助中心）（`4ad2ae1`）
- **sdk-health**：补齐接入有效性 / SDK 交付指标 / SDK 体积三块（`e5bb9a5`）
- **sdk**：OTLP 导出（http/json，默认关，随 `e4f6683` 路线图收官批次）
- **monitoring**：持久化 `lastWriteTs` + `ingestErrorCount`，新增 `/api/diagnostics` 与控制台采集健康卡片（`a01d550`）
- **release**：发布流程扩展同步发 sdk-react-native / sdk-electron（各自 0.1.0）（`57efc9c`）

### 🐛 缺陷修复 (Fixes)
- **web**：告警中心 `alert-channels` 缺失 `brandName` 导入导致整页 `ReferenceError`（`a47dd0f`，配回归守卫 `e3be85c`）
- **worker**：补齐 `/api/analytics/retention` 路由，修复留存分析页 not found（`b6b9d58`）
- **worker**：概览查询缺省时间窗兜底，抑制 D1 全表扫描（`fdf0c42`）
- **web**：暂停概览 / 分析页 30s 自动刷新，缓解 D1 行读爆量（`6ef3996`）
- **web**：知识库帮助中心无效图标导入（ThumbsUp/ThumbsDown → CircleCheck/CircleClose）（`6ae0fdc`）
- **web**：补导入 layout 缺失的 Reading 图标，修复整页空白（`28a3fb1`）
- **web**：判定列改用 `OverflowTip`，修复 tooltip 定位与溢出提示（`e261979`）
- **mcp**：修复鉴权顺序与 Bearer 解析空安全导致 500（`e4f8818`）
- **merge**：修复合并提交遗留冲突标记与 `.merge-tmp` 误提交（`71304ff`）
- **ci**：pnpm 版本对齐 `packageManager`(11.7.0)、锁文件漂移兜底、MCP secrets 步骤修复（`241fb56`、`0ef3113`、`154400e` 等）

### 🔧 发布说明 / 部署注意
- **SDK (npm)**：随 tag 由 CI 发布 `@web-collection/sdk@0.5.0`；另首发 `@web-collection/sdk-react-native@0.1.0` 与 `@web-collection/sdk-electron@0.1.0`。IIFE 经 `prepare-cloudflare.js` 拷贝后随前端部署更新。
- **Worker / MCP / AI Worker**：三个独立 Worker 各自 `--config` 部署，改其一不影响其余；发版后建议 `wrangler tail` 确认无 `[ingestion] record failed` 与 `[mcp]` 鉴权报错。
- **D1**：本版本涉及采集健康字段持久化（`lastWriteTs`/`ingestErrorCount`）与知识中枢 `Article` 模型，迁移随 tag 的 `wrangler d1 migrations apply --remote` 一并推进，写侧与迁移同提交以保证兼容。

---

## [0.4.0] - 2026-08-31

### ⭐ 亮点
- **SDK 采集与入库自监控**：堵住 8.28「写库异常被 `ctx.waitUntil` 静默吞掉、collect 200 / health 绿 / 零入库」事故。Worker 端 `ingestionMonitor` 统计 received/written/failed，入库失败写入 `alert_history` 自动告警，`/health` 与新增 `GET /api/monitoring/ingestion` 暴露健康度；SDK 端 `SelfMonitor` 订阅 transport 诊断事件，统计 sent/dropped/retried/timeout 并对外暴露 `sdk.monitoring()`。
- **AI 诊断产品化（P0–P3）**：从「依赖错误前提」升级为解耦错误前提 + 主动洞察 + 对话助手 + 开放集成。
- **8.28 零采集事故根因修复**：`worker.js` 的 `storageWrite` 在重构中误删了 `run()` 闭包定义，导致每次写库 `ReferenceError` 被 `waitUntil` 静默吞掉、线上持续零采集，已补回。

### ✨ 新功能 (Features)
- **monitoring**：SDK 采集 + Worker 入库双端自监控，防静默零采集事故（`778b516`）
- **ai**：主动诊断扫描支持选择类别（error-cluster / release-regression / perf-regression / metric-drop）与时间范围（`fcf7d74`）
- **ai**：AI 诊断产品化 P0–P3 落地（解耦错误前提 + 主动洞察 + 对话助手 + 开放集成）（`7ea6b28`）
- **analytics**：用户路径点击视角 tab 优化（KPI / 分组着色 / Top10 / 语义说明）（`ce3453d`）

### 🐛 缺陷修复 (Fixes)
- **worker**：修复 `storageWrite` 未定义的 `run` 导致所有写库静默失败（线上 8.28 起零采集）（`f2e1472`）
- **ai**：修复「立即扫描」报 internal error——`ai_findings.id` 主键冲突（`findOpen` 漏判时重复插入恒定 id）（`3c1cfe8`）
- **ai**：AI 洞察流性能均值结论按「时:分:秒」格式化（如 `35426651.11ms` → `9h50m26s`）（`df83655`）
- **ai**：修复 AI 助手返回 JSON 串、深诊断 scope 报错及助手按钮样式（`03a85f3`）
- **ai**：修复 AI 诊断抽屉 tab 滚动箭头被挤到单独一行（`0b9b224`）
- **replay**：修复回放画面大面积为黑（面板换深色后 rrweb replayer iframe 透明背景透出深色，已设白底）（`d3fba87`）
- **replay**：进度时间展示改为组件内气泡，固定在进度条正上方（弃用定位不稳的 teleported tooltip）（`5584809`）
- **replay**：修正回放进度条 tooltip 位置，避免反向飘入回放画面（`073486b`）
- **replay**：进度条拖动时显示 tooltip 且只在松手时 seek（`42d451b`）
- **web**：用户链路（/journey）首屏空白——后端 `journey/sessions` 的 `value` 改为可选（空值 = 浏览最近会话），进入页面即有数据（`781776d`）
- **web**：通知铃铛点击无响应——绑定 `@click` 跳转 `/ai-insights`（`781776d`）
- **web**：自定义仪表盘没展示出仪表盘数据（`72f5dfc`）
- **web**：自定义仪表盘当前仪表盘提示增加上间距（`60c872b`）
- **analytics**：彻底移除产品分析页的漏斗分析 tab（`1eac682`）
- **funnel**：合并漏斗分析到独立页并修复跳转用户链路时间窗不匹配（`9a2db51`）
- **frontend**：`queryFromFilters` 放行 extra 显式参数，修复版本质量按 SDK 版本 tab 查到应用版本（`81e799f`）
- **sdk**：修复 collect 退出上报重复 keepalive 请求导致前几次 pending（`7e30ae2`）
- **settings**：采样与上报 / 告警规则真正接入后端持久化（`37d9d14`）
- **settings**：告警规则 tab 复用 ingest-row 修正间距与垂直对齐（`0917c4f`）
- **settings**：采样与上报页表单行内间距与垂直对齐优化（`d5c9119`）
- **cors**：允许 `if-none-match` 等条件请求头，修复 SDK 二次拉取配置被预检拦截（`5d1f99e`）

### 🔧 发布说明 / 部署注意
- **Worker**：`cloudflare/worker.js` 改动（自监控、入库失败告警、`/api/monitoring/ingestion`）需 `wrangler deploy` 后生效；发测试事件 + `wrangler tail` 确认无 `[ingestion] record failed`。
- **AI Worker（独立部署）**：`cloudflare/ai-wrangler.jsonc` 配置，需 `wrangler deploy --config cloudflare/ai-wrangler.jsonc` 单独部署（主 worker 的 deploy 不会更新它）。
- **SDK (npm)**：`packages/sdk` 随 tag 由 CI 发布 `@web-collection/sdk@0.4.0`，IIFE 经 `prepare-cloudflare.js` 拷贝后随前端部署更新。

---

## [0.3.1] - 2026-08-28
- 配置维度拆分（SDK 版本 / 应用版本）、CORS 修复、D1 events 表补齐 device/os/browser 列修复 journey 查询、跨平台 backfill 脚本稳健性修复等。详见 `git log v0.3.0..v0.3.1`。

## [0.3.0] - 2026-08-25
- 前端页面与导航（PRD 01-07）、远程采集配置 + 页面参与度字段、后端 PRD 01-07 实现、知识库（KB）doc 类型与在线链接抓取升级等。详见 `git log v0.2.4..v0.3.0`。

> AI生成