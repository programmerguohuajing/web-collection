# 漏斗分析重设计 — 概览

> 角色：架构通（Software Architect）  ·  日期：2026-08-14
> 范围：可视化+呈现层为主，引擎按选定语义（严格有序基线 + 转化时间窗 + 步骤间耗时）向后兼容增强

## 一、现状诊断

| 维度 | 原实现 | 问题 |
|------|--------|------|
| 呈现 | 4 张纯表格（步骤/趋势/流失会话/维度） | 漏斗最核心的"逐级收窄 + 流失"洞察被埋在数字里；项目已装 ECharts 但未用漏斗图 |
| 转化率 | 仅"对首步" | 缺**步骤间转化率**（运营最该优化的点） |
| 语义 | 仅严格有序、按用户去重 | 无转化时间窗、无步骤耗时 |
| 引擎 | `runFunnel` 一次拉 50k 事件按会话分组 | 量大无采样提示，可能静默少算 |
| 构建器 | 下拉选步骤 | 无实时预览、无时间窗配置 |

## 二、架构决策（ADR）

**决策**：以可视化层为重心，新增漏斗图主体；同时把你在语义里勾选的三项（有序基线、转化时间窗、步骤间耗时）以**向后兼容**方式补进双存储引擎。无序漏斗未勾选，不做。

**选项与权衡**
- 方案 A（采纳）：可视化优先 + 轻量引擎增强。风险最低、体验提升最大，现有漏斗 `windowMs=null` 时行为完全不变。
- 方案 B：仅重做引擎语义（无序/窗口/耗时）。分析能力强但前端仍无图，体验收益小、回归风险高。
- 方案 C：全量重构。收益最大但工作量与风险最高，本轮不做。

**关键取舍**：转化时间窗的"相邻步骤最大间隔"语义用"首次达成即锁定，后续步骤须在上一步时间戳 +windowMs 内出现"实现，简单且与历史 `reaches` 等价（windowMs=null 时逐字一致）。未做"失败可重启尝试"的复杂分支，作为已知简化。

## 三、改动清单

**引擎（双存储，输出结构保持一致）**
- `apps/api/src/services/analytics-service.js`
  - 新增 `matchSteps(events, steps, windowMs)` 统一顺序匹配；`reaches` 增加 `windowMs` 参数。
  - `computeFunnel` 增加 `stepRate`（步骤间转化率）、`timeToConvert`（中位耗时）、`timeToConvertP90`；透传 `windowMs`。
  - `runFunnel` 读取 `def.window_ms`；`saveFunnel` 持久化 `windowMs`。
- `cloudflare/worker.js`（D1 版独立实现）：同步 `matchSteps`/`reaches(windowMs)`、`runFunnel` 输出 `stepRate`/`timeToConvert`/`timeToConvertP90`、`saveFunnel` 持久化 `window_ms`、`dimensions` 改用 `reaches` 保证与主线一致。

**存储迁移**
- `apps/api/src/db.js`：`alter table funnel_definitions add column if not exists window_ms bigint`。
- `cloudflare/migrations/0007_funnel_window.sql`：`add column window_ms integer`（NULL=不限）。

**前端**
- 新增 `apps/web/src/components/FunnelChart.vue`：基于 ECharts `FunnelChart`，逐级收窄展示步骤名/用户数/整体转化率，tooltip 含整体转化率、步骤间转化率、流失。
- `apps/web/src/views/monitor/analytics/index.vue`：
  - 构建器新增"转化时间窗(分钟)"输入，随保存提交（0=不限）。
  - 结果区以 **FunnelChart 为可视化主体**，下方增强表格新增"步骤间转化率(%)""步骤间耗时(中位)"两列。
  - 每日趋势改用 `AnalyticsChart` 折线图（进入 vs 完成）。
  - 自定义仪表盘的漏斗组件同步改用 `FunnelChart`。

**测试**
- `test/analytics.test.js`：新增步骤间转化率、中位耗时、转化时间窗用例。
- `test/funnel-table-migration.test.js`：新增 0007 迁移校验。
- `node --test`：13/13 通过；前端 `vite build` 通过；`worker.js`/`analytics-service.js`/`db.js` 语法检查通过。

## 四、向后兼容性
- `windowMs=null`（旧漏斗、不传时间窗）时，`reaches`/`matchSteps` 退化为原严格有序语义，计数、流失、维度、趋势与重构前逐字一致。
- 数据库 `window_ms` 默认 NULL，旧实例升级后旧漏斗自动"不限"。

## 五、未做 / 后续可选
- 无序（任意顺序）漏斗 —— 你未勾选，暂未实现。
- 维度（版本/浏览器/设备）目前仍为表格，可后续升级为分组柱状图。
- 漏斗步骤拖拽排序、配置实时预览 —— 属于"构建器交互"层，本轮未做。
- 大数据量下的采样/近似计算，避免 50k 上限静默少算。
