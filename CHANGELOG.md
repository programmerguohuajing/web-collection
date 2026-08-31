# Changelog

本项目所有版本发布均由 `vX.Y.Z` tag 触发，GitHub Release / npm 包 / SDK tgz 由 CI 工作流（`.github/workflows/release-npm.yml`）在该 tag 推送时一体产出，版本号以 tag 与 `packages/sdk/package.json` 为准。

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

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
