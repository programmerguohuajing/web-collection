# Web Collection 与埋点平台对比及产品分析演进方案

> 状态：方案评审稿，仅用于决定后续是否开发，本文不代表已经实现。
> 调研日期：2026-08-19。
> 参考系统：[埋点平台标准流量](https://testtracking.juxingzhimei.com/traffic?environment=trial&product_id=jiangjun_trade&app_id=pc_web)。
> 当前系统：[Web Collection](https://web-collection.jingguohua.cc.cd/)。
> 对比范围：参考系统的标准流量、用户行为、交易漏斗、事件定义、事件明细、用户链路、版本质量、采集治理，以及 Web Collection 当前 Web、API、Cloudflare Worker 和数据模型。

---

## 1. 结论先行

Web Collection 当前不是“能力少”，而是能力结构偏向技术可观测：错误、性能、日志、会话回放、告警、SourceMap、链路追踪和自定义漏斗已经较完整；参考系统的优势则集中在业务分析的数据口径、事件契约、客户端与服务端事实关联、版本质量和采集链路治理。

不建议照搬参考系统的视觉样式或页面数量。建议保留 Web Collection 现有 Style B 视觉语言和技术可观测优势，吸收参考系统的产品分析闭环，形成以下分层：

1. **技术可观测**：错误、性能、日志、回放、链路、告警，继续保持现有优势。
2. **产品分析**：标准流量、事件分析、漏斗分析、用户旅程、路径分析。
3. **数据质量**：事件定义、版本质量、上报质量、契约接受率、拒绝与投递失败。
4. **采集治理**：应用、采样、远程配置、熔断、保留、告警策略和隐私模式。

### 1.1 推荐优先级

| 优先级 | 工作项 | 原因 |
|---|---|---|
| P0 | 修复现网懒加载旧 chunk 导航失败 | 本次实测点击“产品分析”时出现动态模块加载失败，导航高概率直接失效 |
| P0 | 统一 Node API 与 Cloudflare Worker 能力和 Schema | 当前 `/api/capabilities` 在 Node 返回 `productAnalyticsV2: true`，Worker 返回 `false`，线上会隐藏事件分析等能力 |
| P0 | 建立统一事件口径和全局上下文 | 当前 `pv`、`page_viewed`、`session_started`、`app_start` 等语义并存，页面指标可能有数据但取不到正确字段 |
| P0 | 新增“标准流量”页 | 当前没有稳定的 PV、UV、Session、DAU、WAU、MAU、新用户、页面排行和平台分布闭环 |
| P0 | 对分析查询做预聚合和性能预算 | 本次实测用户路径、采集治理均触发“接口响应较慢”提示，原始事件扫描不适合长期增长 |
| P1 | 新增事件定义与事件契约质量 | 解决事件是否接入、必填属性、负责人、最近活跃、未定义事件等治理问题 |
| P1 | 将用户会话升级为“用户旅程” | 将会话列表、事件时间线、事件参数、客户端/服务端事实、回放和错误联动放在同一页面 |
| P1 | 将发布管理升级为“版本质量” | 分离 App 版本与 SDK 版本，并展示错误率、异常会话率、上报延迟、契约接受率 |
| P1 | 将采集治理拆成可理解的 Tab | 应用状态、远程配置、策略与告警分开，避免当前应用表与大量策略表单堆在同一屏 |
| P2 | 业务漏斗模板和服务端事实漏斗 | 保留现有自定义漏斗，同时支持购买、租赁、履约等经产品确认的模板 |
| P2 | 留存、分群、用户属性与业务全景 | 等事件口径和预聚合稳定后再做，避免在不可信数据上扩展更多图表 |

### 1.2 不建议做的事

- 不直接复制参考系统的低密度大白屏和超宽表格。
- 不用前端现算方式在原始事件上长期计算 DAU、MAU、路径和漏斗。
- 不把 App 版本、发布版本和 SDK 版本继续混用一个 `release` 字段。
- 不将客户端点击直接当成支付、成交或履约成功；业务结果必须使用服务端事实事件。
- 不在口径未定义前先堆图表，否则只会放大“看起来有数据、含义不可信”的问题。

---

## 2. 调研证据与页面健康度

本次使用同一 Chrome 会话读取参考系统和当前线上系统。审计截图仅存放在临时目录，没有加入项目仓库。

| 步骤 | 页面/流程 | 健康度 | 关键观察 |
|---|---|---|---|
| 1 | 参考系统：标准流量 | 良好 | 产品、应用、SDK 版本、环境、口径版本、数据新鲜度和时间粒度统一；PV/UV/Session/活跃用户/页面排行完整 |
| 2 | 参考系统：用户行为与交易漏斗 | 良好但数据依赖明显 | 用户行为按趋势、参与度、点击曝光、表单、会话路径分层；漏斗为空时明确提示核对客户端和服务端事实 |
| 3 | 参考系统：事件定义 → 事件明细 | 良好 | 从“应采什么”到“实际收到什么”形成验证路径，支持负责人、必填字段、接入状态、request_id 和上报延迟 |
| 4 | 参考系统：用户链路 | 良好 | 会话列表、事件时间线和节点详情三栏联动，能看到 SDK/框架、设备网络、接收批次和治理后参数 |
| 5 | 参考系统：版本质量与采集治理 | 部分良好 | 版本运行表现当前为空，但 SDK/Collector/Admin 版本和契约接受率有明确口径；治理页信息架构清晰 |
| 6 | 当前系统：行为分析 | 需改进 | 明细和热力图已有，但“会话数、平均停留、跳出率”缺少可靠来源，PV 依赖特定事件名 |
| 7 | 当前系统：产品分析 | 中等 | 自定义漏斗能力较强，但标准流量缺失；首次加载存在整页遮罩，部署缓存不一致时导航失败 |
| 8 | 当前系统：用户路径与采集治理 | 需改进 | 功能可用，但均触发慢接口提示；路径平均深度显示 `0.0 步`，用户列大量为空；治理页面缺少采集健康视角 |

### 2.1 浏览器实测发现的现网问题

#### A. 懒加载 chunk 与页面版本不一致

从 `/behavior` 点击“产品分析”时，导航状态变为选中，但内容仍停留在行为分析。控制台记录：

```text
TypeError: Failed to fetch dynamically imported module:
https://web-collection.jingguohua.cc.cd/assets/index-DLzktU2-.js
```

这通常意味着 HTML/入口脚本和带哈希的异步 chunk 不属于同一次发布，或者旧 HTML 被缓存而旧 chunk 已被删除。

建议：

- HTML 和入口清单设置 `Cache-Control: no-cache` 或短缓存并进行 revalidate。
- 哈希静态资源设置 `Cache-Control: public, max-age=31536000, immutable`。
- 部署先上传全部新资源，再切换 HTML；旧资源至少保留一个回滚窗口。
- 捕获 `Failed to fetch dynamically imported module`，只允许自动刷新一次，避免循环刷新。
- 发布完成后执行全路由动态导入 smoke test，验证每个 lazy chunk 可访问。

#### B. 分析接口慢

用户路径和采集治理页面均出现全局慢请求提示，数据在后续等待窗口才完成展示。当前提醒机制是优点，但不能代替后端治理。

建议将以下预算写入发布门禁：

| 接口类型 | P95 目标 | 硬超时 | 说明 |
|---|---:|---:|---|
| 页面首屏汇总 | ≤ 800 ms | 5 s | 超过 800 ms 展示局部骨架，不遮挡整个页面 |
| 普通分页列表 | ≤ 1.5 s | 8 s | 只加载当前页，不扫描全部历史 |
| 路径/漏斗分析 | ≤ 2 s | 10 s | 优先读取预聚合，复杂查询可异步生成 |
| 实时指标 | ≤ 500 ms | 3 s | 使用分钟级聚合或实时缓存 |

---

## 3. 参考系统值得吸收的部分

### 3.1 全局分析上下文

参考系统顶部上下文包含：

- 业务产品；
- 应用；
- SDK 版本；
- 数据环境；
- 数据更新时间；
- 口径版本；
- 未签字/未确认口径提示。

当前 Web Collection 顶部只有应用、自由输入的版本和快捷时间范围，环境固定显示“生产环境”，页脚的 `v2.4.0 · 实时采集节点 12` 也是静态文案。

建议将顶部上下文调整为：

```text
产品（可选） | 应用 | App 版本 | SDK 版本 | 环境 | 时间范围 | 粒度（日/小时）
数据更新于 ... | 数据口径 v... | 采集状态 | 刷新
```

规则：

- 技术监控页默认隐藏“产品”，产品分析页显示。
- App 版本和 SDK 版本必须拆开，不再共用“全部版本”。
- 环境必须来自真实数据或应用配置，不得固定写死生产。
- 时间范围同时支持快捷项和自定义日期，且明确业务时区。
- 数据更新时间来自对应聚合任务/查询结果，而不是浏览器当前时间。
- 口径未确认时用可关闭的 warning，不让用户误把验证数据当正式报表。

### 3.2 标准流量

建议新增 `/analytics/traffic`，作为产品分析默认入口。

首屏布局建议：

1. 筛选条：日期范围、按日/分时、业务时区、查询上限。
2. 口径说明：PV、UV、Session 和去重范围。
3. 第一组指标：PV、UV、Session、人均浏览量、登录访客、匿名访客。
4. 第二组指标：DAU、WAU、MAU、新用户、回访用户、跳出率。
5. 趋势图：PV/UV/Session，可切换指标，图下保留明细表和导出。
6. 页面排行：页面名、PV、UV、Session、跳出率、平均停留、错误率。
7. 分布：应用/平台、App 版本、SDK 版本、浏览器、设备、地区（若合规采集）。

参考系统主要用表格表达趋势，Web Collection 应继续使用现有 ECharts 视觉语言：上方折线图、下方可折叠明细表，不必照搬成纯表格。

### 3.3 事件定义与事件明细

参考系统的核心价值不只是列出事件，而是建立了以下验证链：

```text
确认事件定义 → 在被测页面触发 → 核对事件明细 → 查看用户旅程/服务端结果
```

建议新增两个页面或产品分析内的两个二级路由：

#### 事件定义 `/data-quality/events`

字段建议：

| 字段 | 说明 |
|---|---|
| event_name | 稳定英文标识 |
| display_name | 中文名称 |
| source | 客户端、服务端、系统生成 |
| owner | 负责人或团队 |
| level | 业务、技术、系统 |
| question | 该事件回答的业务问题 |
| trigger | 触发时机 |
| required_fields | 必填属性和类型 |
| optional_fields | 可选属性和类型 |
| pii_policy | 字段脱敏/禁采规则 |
| status | 草稿、待接入、活跃、异常、废弃 |
| last_seen_at | 最后观测时间 |
| volume_7d | 近 7 天事件量 |

还应单独展示“定义外事件”，避免 SDK 自定义事件悄悄进入漏斗候选项。

#### 事件明细 `/data-query/events`

建议支持：

- 发生时间和接收时间；
- 精确事件名；
- 来源；
- 应用与 SDK 版本；
- event_id、request_id、trace_id、session_id；
- 经白名单治理的业务主键；
- 上报延迟；
- 原始值/治理后值切换需受权限控制。

默认最近 24 小时，单次最多 7 天；ID 和业务主键优先精确匹配，避免全表模糊扫描和隐私泄露。

### 3.4 用户旅程

当前“用户会话”和“用户路径”被拆成两个列表，进入会话后只在 Drawer 中展示通用事件表，定位一次业务流程需要多次跳转。

建议新增 `/journeys`，保留 `/sessions` 和 `/paths` 作为兼容入口或子视图。桌面端使用三栏结构：

```text
会话列表            事件时间线                         节点详情
用户/匿名ID         页面进入、点击、请求、错误、事实     事件字段
开始时间            批次接收提示                         治理后参数
应用/SDK版本         客户端和服务端来源标记               上报延迟
事件/异常数          回放/Trace/错误跳转                   request_id
```

关键要求：

- 支持登录用户、匿名设备、Session ID 三种查询类型。
- 时间线按事件发生时间排序，但同时展示接收时间和离线批次信息。
- 客户端行为和服务端事实使用不同颜色/图标，不混淆成功语义。
- 点击错误节点可跳错误详情；点击请求节点可跳 Trace；有 replay 时可播放。
- 默认脱敏，不展示手机号、完整 URL 查询参数、IP、原始 User-Agent 等敏感信息。
- 小屏降级为“会话列表 → 会话详情 → 节点抽屉”，不能强行保留三栏。

### 3.5 版本质量

当前发布管理和产品分析中的版本对比偏向“事件、用户、错误、LCP”，缺少 App 版本、SDK 版本和采集链路的明确区分。

建议将 `/releases` 升级为“版本质量”，包含两个主 Tab：

#### App 版本

- 状态：灰度、正式、回滚、停用；
- 用户、会话、事件；
- 错误数、错误用户率、异常会话率；
- LCP/INP/CLS P75；
- 平均上报延迟；
- 最近观测时间；
- 与上一版本的变化和回滚建议。

#### SDK 版本

- 已发布 SDK 版本；
- 每个应用的实际采用版本；
- 接受、拒绝、契约接受率；
- 投递失败、不完整、重试和离线积压；
- 版本覆盖用户/会话；
- 旧版占比和升级建议。

不要把“采集治理中维护的版本”直接等同于“实际观测版本”。前者是配置/发布事实，后者来自事件数据，两者应并列对照并标出不一致。

### 3.6 采集治理

当前页面已有应用 CRUD、事件采样率、回放采样率、版本维护、保留时间、性能阈值和通知开关，基础并不弱。问题是“应用配置”和“运行状态”混在一起，且没有采集健康视角。

建议拆分为：

1. **应用状态**：平台、是否持续上报、近 1h/7d 事件、SDK/App 版本数、最后上报、错误率。
2. **远程配置**：采样率、回放采样、事件白名单/黑名单、隐私模式、离线队列、Beacon/Fallback、配置版本和生效范围。
3. **策略与告警**：保留时间、性能阈值、告警冷却、通知类型。
4. **采集质量**：接受率、拒绝原因、字段缺失、超限、投递失败、重试、上报延迟分位数。

应用表的“状态”应区分：

- 配置启用；
- 最近持续上报；
- 已停止上报；
- 数据异常；
- 从未接入。

不能只用一个“启用”标签同时表达配置状态和运行状态。

---

## 4. 现有能力对比矩阵

| 能力 | 参考系统 | Web Collection 现状 | 判断 | 建议 |
|---|---|---|---|---|
| PV/UV/Session | 完整且有口径说明 | `summary.behavior` 计数，Session/UV 未进入 summary | 缺失 | 建立标准流量聚合 |
| DAU/WAU/MAU | 已有 | 无稳定接口和页面 | 缺失 | 基于活跃事件和 actor_key 预聚合 |
| 登录/匿名访客 | 已有 | 可从 user/device 推导但未展示 | 部分具备 | 进入流量概览 |
| 新用户 | 已有 | 无 first_seen 模型 | 缺失 | 新增用户首次观测表 |
| 页面排行 | PV/UV 排行 | 路径列表、行为排行分散 | 部分具备 | 统一页面分析表 |
| 行为趋势 | 日/小时、点击、曝光、表单 | 明细、排行、热力图；缺稳定趋势和表单分析 | 部分具备 | 重构行为分析 Tab |
| 自定义事件分析 | 较基础 | Node API 已支持事件/用户/会话指标、分组和属性筛选 | Web Collection 更强，但线上被关闭 | 统一 Worker 能力并开放 |
| 漏斗 | 业务预设和服务端事实 | 自定义步骤、属性过滤、维度、趋势、流失会话、回放 | Web Collection 更强 | 保留并增加业务模板 |
| 用户路径 | 用户链路三栏 | 路径排行、点击视角、用户会话 | 部分具备 | 合并为用户旅程 |
| 会话回放 | 非主能力 | rrweb 回放、分段关联 | Web Collection 更强 | 在旅程/漏斗中继续联动 |
| 错误与性能 | 非主能力 | 错误聚合、SourceMap、Core Web Vitals、资源/API、告警 | Web Collection 更强 | 保持独立技术监控入口 |
| 分布式追踪 | 未在本次页面体现 | 前后端 Trace、拓扑、调用树、瀑布 | Web Collection 更强 | 与用户旅程请求节点联动 |
| 事件定义 | 负责人、字段、接入状态、活跃度 | 只有事件名候选和通用属性 | 缺失 | 新增事件契约中心 |
| 事件明细 | request_id、来源、上报延迟、详情 | 通用事件表，可按类型/路径/用户筛选 | 部分具备 | 增加接收时间和精确定位字段 |
| 版本质量 | App/SDK、Contract、Collector | 基础版本对比和版本维护 | 部分具备 | 升级为版本质量页 |
| 采集治理 | 应用状态、远程配置、策略 | 应用/采样/保留/阈值 | 部分具备 | 增加运行健康和远程配置 |
| 弱网/离线 | 页面显示上报延迟和批次 | SDK 已有 IndexedDB、retry、multitab、sendBeacon | SDK 更强、平台展示弱 | 增加队列、重试、延迟指标 |
| 加载与错误状态 | 空态明确 | 已有慢接口提示、错误态、重试；部分全屏遮罩 | 部分具备 | 改为局部骨架并治理接口 |

---

## 5. 信息架构调整建议

### 5.1 推荐导航

```text
总览看板

监控
  告警中心
  实时监控
  错误监控
  性能分析
  会话回放

可观测
  日志平台
  链路追踪

产品洞察
  标准流量        新增
  事件分析        现行为分析 + EventInsight
  漏斗分析        从产品分析提为可深链二级入口
  用户旅程        合并用户会话与用户路径

数据质量
  事件定义        新增
  事件明细        可复用现 EventTable，但使用质量视角
  版本质量        升级发布管理

配置
  SourceMap
  采集治理
  系统设置
```

### 5.2 兼容路由

为避免书签、告警链接和历史地址失效，建议保留：

| 旧路由 | 新目标 |
|---|---|
| `/behavior` | `/analytics/events` |
| `/analytics?tab=funnels` | `/analytics/funnels` |
| `/sessions` | `/journeys?view=sessions` |
| `/paths` | `/journeys?view=paths` |
| `/releases` | `/quality/versions` |

路由重构前先修复 lazy chunk 的原子发布问题，否则增加更多分包只会放大导航失败概率。

### 5.3 页面展示原则

- 全局上下文只出现一次，页面内部不要重复应用/版本/时间筛选。
- KPI 卡只展示可解释、可点击下钻的指标；没有口径的数据展示“未配置”，不要显示看似正常的 `0`。
- 趋势默认使用图表，表格作为核对和导出视图。
- 空态必须说明是“无数据”“未接入”“被筛选掉”“契约不通过”还是“接口失败”。
- 大表格使用固定表头、列显隐和可保存视图；避免所有列一次铺满。
- 路径、漏斗、旅程、回放、错误和 Trace 之间提供深链，避免成为互不相干的页面。
- 加载状态局部化，筛选区和已有数据不被全屏半透明遮罩覆盖。

---

## 6. 指标口径建议

### 6.1 事件别名与标准事件

当前系统同时存在 `pv`、路由事件、`page_viewed`、`app_start`、`session_started` 等命名。建议定义 canonical event，在查询层兼容旧名，但新 SDK 只发送标准名。

| 标准事件 | 兼容旧事件 | 说明 |
|---|---|---|
| `page_viewed` | `pv`，经规则确认的 `pushState/replaceState/popstate/hashchange` | 页面访问；路由切换是否产生 PV 必须由 SDK 去重 |
| `page_left` | `page_leave` | 页面退出和停留时长 |
| `session_started` | 经明确规则映射的 `app_start` | 会话起点，不可直接用任意行为事件代替 |
| `element_clicked` | `click` | 点击事件 |
| `element_exposed` | `exposure` | 曝光事件 |
| `form_started` | 现有自定义表单开始 | 表单开始 |
| `form_submitted` | 现有自定义表单提交 | 表单提交 |

### 6.2 核心指标

| 指标 | 建议定义 |
|---|---|
| PV | `page_viewed` 事件数；同一路由短时间重复由 SDK/服务端规则去重 |
| UV | 查询区间内 `actor_key` 去重数；优先 `user_id`，其次稳定 `device_id`，不使用 session_id 充当用户 |
| Session | `session_started` 去重，或服务端会话化规则生成的 session_id 数 |
| 人均浏览量 | PV / UV；UV 为 0 时返回 `null`，前端显示 `-` |
| DAU | 单个自然日内满足活跃事件集合的 actor_key 去重数 |
| WAU | 最近 7 个自然日活跃 actor_key 去重数，不是 DAU 求和 |
| MAU | 最近 30 个自然日活跃 actor_key 去重数，不是 DAU 求和 |
| 新用户 | 查询期首次出现且 `first_seen_at` 落在查询期内的登录用户；匿名新设备单独展示 |
| 跳出率 | 仅产生一个有效 page_viewed 且无关键交互的会话 / 有页面访问的会话 |
| 平均停留 | 有合法 page_left 或 session end 的页面停留总时长 / 有效页面访问数；需处理后台挂起 |
| 上报延迟 | `received_at - occurred_at`；同时展示 P50/P95/P99 和超阈值比例 |
| 契约接受率 | accepted / received；采样丢弃不能混入 contract rejection |

所有 API 必须同时返回 `value` 和 `definitionVersion`，页面 Tooltip 可查看口径；口径调整需要版本化，不能静默改变历史报表含义。

---

## 7. 数据模型与 API 规划

### 7.1 events 字段补齐

Node/PostgreSQL 已有 `sdk_version`、`environment`、`source`，但还不足以支撑参考系统的质量视角。建议补充并在 D1 与 PostgreSQL 同步迁移：

```text
product_id          业务产品，可空
app_version         App/业务版本，替代 release_name 的多义性
sdk_version         SDK 版本，保留
environment         prod/staging/trial/dev
schema_version      事件信封版本
event_id            SDK 生成的稳定事件 ID，用于幂等和定位
request_id          客户端/服务端请求关联 ID
occurred_at         事件发生时间；可兼容现 ts
received_at         Collector 首次接收时间
source              client/server/system
contract_status      accepted/rejected/incomplete
contract_errors_json 字段缺失、类型错误、超限等
batch_id            离线/弱网上报批次
retry_count         发送重试次数
```

`release_name` 可在过渡期保留，但新代码必须明确它代表 App 版本还是发布标识。

### 7.2 新增表

| 表 | 用途 |
|---|---|
| `products` | 一个业务产品下关联多个应用 |
| `event_definitions` | 事件名称、来源、负责人、业务问题、状态、契约版本 |
| `event_definition_fields` | 属性类型、必填、枚举、隐私策略 |
| `ingest_rejections` | 拒绝原因、字段错误、样本和计数；敏感值不可原样保存 |
| `user_first_seen` | 登录用户/匿名设备首次观测，用于新用户 |
| `analytics_hourly` | 小时级 PV/UV/Session/事件/质量聚合 |
| `analytics_daily` | 日级 DAU、WAU/MAU 辅助、版本和平台聚合 |
| `page_analytics_daily` | 页面 PV/UV/Session/停留/跳出/错误 |
| `version_quality_daily` | App/SDK 版本的用户、会话、错误、性能、延迟和契约质量 |
| `ingest_quality_hourly` | 接受、拒绝、不完整、失败、重试、延迟分位数 |
| `remote_configs` | 远程采样、开关、白名单、隐私模式和配置版本 |
| `business_funnel_templates` | 购买/租赁/履约等由业务确认的漏斗模板 |

### 7.3 API 建议

#### 标准流量

```http
GET /api/analytics/traffic/summary
GET /api/analytics/traffic/trend?granularity=day|hour
GET /api/analytics/traffic/pages
GET /api/analytics/traffic/dimensions?dimension=platform|appVersion|sdkVersion|browser|device
```

统一查询参数：

```text
productId, appId, appVersion, sdkVersion, environment,
startTime, endTime, timezone, page, pageSize
```

#### 数据质量

```http
GET  /api/event-definitions
POST /api/event-definitions
PUT  /api/event-definitions/:id
GET  /api/event-definitions/unknown
GET  /api/event-logs
GET  /api/quality/versions
GET  /api/quality/ingestion
```

#### 用户旅程

```http
GET /api/journeys/sessions
GET /api/journeys/sessions/:sessionId/timeline
GET /api/journeys/events/:eventId
```

### 7.4 返回契约

列表统一：

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 20,
  "meta": {
    "dataUpdatedAt": 0,
    "definitionVersion": "traffic-v1",
    "timezone": "Asia/Shanghai",
    "truncated": false
  }
}
```

聚合统一：

```json
{
  "data": {},
  "meta": {
    "dataUpdatedAt": 0,
    "definitionVersion": "traffic-v1",
    "timezone": "Asia/Shanghai",
    "sampled": false,
    "partial": false
  }
}
```

接口失败、契约不匹配和合法空数据必须保持三种不同状态，不能把未知对象转换成空数组。

---

## 8. Node API 与 Cloudflare Worker 统一要求

当前存在明确的部署差异：

- Node `/api/capabilities` 返回 `productAnalyticsV2: true`；
- Cloudflare Worker 返回 `productAnalyticsV2: false`；
- Node 使用 `funnel_definitions`、`dashboard_definitions`、`analytics_insights`；
- Worker 使用 D1 迁移后的 `funnel_definitions` 和 `dashboards`，且没有事件分析端点；
- Node 的 events Schema 已包含 `sdk_version/environment/source/context_json`；D1 初始迁移没有完整声明这些字段，但 Worker 写入逻辑会使用它们，存在环境依赖和迁移漂移风险。

开发新能力前必须先建立“部署契约矩阵”：

| 项目 | PostgreSQL | D1/Worker | 验收 |
|---|---|---|---|
| 表和列 | 同语义 | 同语义 | migration contract test |
| 路由 | 同路径 | 同路径 | route inventory test |
| 筛选参数 | 同行为 | 同行为 | parameterized contract test |
| 分页 envelope | 同格式 | 同格式 | schema test |
| capability flag | 根据真实支持 | 根据真实支持 | 不允许永久硬编码关闭 |
| 截断/采样 | meta 明示 | meta 明示 | 大数据量测试 |

如果短期无法实现完全一致，页面必须根据 capability 明确提示“当前部署不支持”，不能静默隐藏 Tab。

---

## 9. 查询性能方案

### 9.1 当前风险

- summary 会读取最多 5,000 条普通事件和 50,000 条性能事件后在应用层聚合。
- 路径查询会读取最多 20,000/50,000 条事件后分组。
- 漏斗会读取最多 50,000 条事件后在应用层按会话匹配。
- 数据增长后，列表接口即使分页，count distinct/group by 仍会变慢。
- Cloudflare D1 和 PostgreSQL 逻辑分别维护，性能修复容易只落在一个运行时。

### 9.2 推荐方案

1. Collector 入库时记录 `received_at` 和契约结果。
2. 每分钟或每 5 分钟将原始事件增量写入小时聚合。
3. 小时聚合滚动合并成日聚合。
4. 标准流量、页面排行、版本质量默认只查聚合表。
5. 事件明细、用户旅程仍查原始数据，但强制时间范围和精确 ID。
6. 大漏斗转为异步任务，返回 `jobId`，完成后缓存结果。
7. 所有分析接口返回 `dataUpdatedAt` 和 `partial/truncated`。

### 9.3 建议索引

```text
events(app_id, environment, occurred_at desc)
events(app_id, sdk_version, occurred_at desc)
events(app_id, app_version, occurred_at desc)
events(session_id, occurred_at)
events(event_id)
events(request_id)
events(source, name, occurred_at desc)
event_definitions(product_id, event_name, version)
ingest_rejections(app_id, received_at desc, reason_code)
```

不要对每个 JSON 属性都建索引；只有进入事件定义并被批准为常用维度的属性才允许提升为列或表达式索引。

---

## 10. 视觉和交互调整

### 10.1 应保留的 Web Collection 风格

- 当前侧边栏分组、紫色主色、白色卡片和浅灰工作区；
- KPI 卡的数字层级和语义色；
- 局部错误、重试和慢请求提示；
- 漏斗图、路径图、Trace、回放等可视化能力；
- 表格分页、字段归一化和 Tooltip 限宽规则。

### 10.2 从参考系统吸收但重新表达

| 参考系统模式 | Web Collection 表达方式 |
|---|---|
| 顶部多个上下文下拉 | 紧凑 Context Bar，可折叠“更多筛选” |
| 指标口径长文本 | 一行口径摘要 + “查看口径”抽屉 |
| 趋势纯表格 | 折线图 + 可折叠明细表 |
| 用户链路三栏 | 桌面三栏，小屏分步页面 |
| 版本质量超宽表 | 固定核心列 + 列设置 + 行详情 Drawer |
| 大面积空白 Empty | 说明缺少哪类事件，并提供“查看事件定义/采集诊断”按钮 |

### 10.3 参考系统本身不应复制的问题

- 字体和表格文字偏小，超宽屏下信息密度过低。
- 多个页面使用大面积空白，缺少下一步行动入口。
- 趋势以表格为主，趋势变化不够直观。
- 顶部信息过多且截断，数据更新时间和口径版本不易完整读取。
- 左侧菜单较长，缺少收藏/最近访问等高频入口。

### 10.4 可访问性风险

仅凭截图和 DOM 不能宣称符合 WCAG，需要后续单独做键盘、缩放、读屏和对比度测试。当前可见风险包括：

- 部分次要文字对比度偏低；
- 大量紧凑表格操作链接的点击区域可能小于 44×44 CSS px；
- 颜色同时表达状态时需要补文字/图标；
- 图表需要表格替代、键盘焦点和可读摘要；
- 全屏加载遮罩会打断阅读和焦点，应改成区域级状态；
- 路由按钮应保证正确的当前页语义和键盘焦点，不只改变颜色。

---

## 11. 分阶段实施计划

### Phase 0：契约和现网可靠性（P0，建议先做）

**目标**：在增加新页面前，先保证线上导航、Schema、能力开关和指标口径一致。

工作项：

- 修复 Vite lazy chunk 的发布与缓存策略；
- 建立 Node/Worker route 和 migration contract test；
- 定义 canonical events 和别名映射；
- 拆分 appVersion、sdkVersion、environment；
- 增加 occurredAt、receivedAt、eventId、schemaVersion；
- 清理硬编码生产环境、平台版本和采集节点数量；
- 为 paths、governance、summary 建性能基线。

验收标准：

- [ ] 全路由连续发布两次后，旧页面仍能正常加载所有 lazy chunk；
- [ ] Node 与 Worker capability/route/schema 测试全绿；
- [ ] PV/Session 的同一数据样本在两个运行时结果一致；
- [ ] 合法空数据、契约错误、超时分别展示；
- [ ] 页面首屏不因一个慢接口被整体遮罩。

### Phase 1：标准流量（P0）

**目标**：提供可信的产品流量基础盘。

工作项：

- 小时/日聚合表和增量任务；
- PV、UV、Session、DAU、WAU、MAU、新用户；
- 趋势、页面排行、版本/平台分布；
- 产品、App/App版本/SDK版本/环境/时间上下文；
- 口径版本、数据更新时间和导出。

验收标准：

- [ ] 同一查询在重复刷新时结果稳定；
- [ ] UV/WAU/MAU 使用区间去重，不做日值求和；
- [ ] 每个指标可查看口径；
- [ ] 页面排行可下钻到事件、会话、错误和性能；
- [ ] P95 ≤ 800 ms（标准时间范围和单应用）。

### Phase 2：事件契约与用户旅程（P1）

**目标**：让“为什么没有数据”和“这条数据是否可信”可定位。

工作项：

- 事件定义、属性定义、接入状态、定义外事件；
- 事件明细中的 eventId/requestId/receivedAt/contractStatus；
- 用户旅程三栏联动；
- 客户端/服务端事实、回放、错误、Trace 深链；
- 精确查询和隐私权限。

验收标准：

- [ ] 任意漏斗步骤可跳事件定义和最近明细；
- [ ] 契约缺字段能看到原因和影响版本；
- [ ] 旅程中客户端行为和服务端结果可区分；
- [ ] 离线批次展示发生/接收时间，不打乱真实行为顺序；
- [ ] 敏感信息默认不进入 DOM。

### Phase 3：版本质量与治理（P1/P2）

**目标**：把发布、SDK 采用和采集质量关联起来。

工作项：

- App/SDK 双版本质量；
- Contract 接受率、拒绝/投递失败、上报延迟；
- 采集状态、远程配置、熔断和灰度；
- 业务漏斗模板与服务端事实；
- 版本异常自动关联告警、错误、性能和回放。

验收标准：

- [ ] 配置版本与实际观测版本分别展示；
- [ ] 可定位某 SDK 版本的拒绝原因和影响应用；
- [ ] 远程配置有版本、审计、灰度和回滚；
- [ ] 业务漏斗成功步骤只使用已批准的服务端事实；
- [ ] 版本质量页支持与上一版本对比并给出证据链接。

---

## 12. 建议的编码边界

如果后续决定开发，应按边界拆分，避免一个任务同时重写全栈：

### 前端边界

- `apps/web/src/layout/index.vue`：Context Bar 和导航分组；
- `apps/web/src/router/index.js`：新路由及旧路由兼容；
- `apps/web/src/views/monitor/analytics/`：标准流量、事件分析、漏斗；
- 新增 `apps/web/src/views/monitor/journeys/`；
- 新增 `apps/web/src/views/monitor/quality/`；
- `apps/web/src/views/monitor/governance/`：Tab 化，不改采集逻辑；
- 通用 ViewModel/契约放入独立模块，不在模板内堆 snake_case/camelCase fallback。

### Node API 边界

- 新建 `traffic-service`、`quality-service`、`journey-service`；
- repository 只负责参数化 SQL 和分页；
- service 负责口径和聚合，不在路由文件拼大 SQL；
- 现有 `analytics-service.js` 中 Trace、路径和漏斗逻辑保持独立，避免继续膨胀。

### Cloudflare Worker 边界

- 先补 migration 和 contract parity；
- 将 admin API 按域拆分模块，避免继续扩展单个 `worker.js`；
- D1 复杂分析优先查预聚合表，不复制 PostgreSQL 的大扫描；
- capability 根据真实路由/迁移生成或测试，不永久硬编码。

### SDK 边界

- 只补统一事件 Envelope、appVersion/sdkVersion/environment、occurredAt/eventId/batchId/retryCount；
- 复用现有 IndexedDB queue、retry、multitab 和 `sendBeacon` transport；
- 不在 SDK 中计算 DAU/MAU、漏斗和业务成功；
- 服务端事实由业务后端 SDK/接口产生，不由 Web SDK 模拟。

### 测试边界

- 指标口径 fixture：PV/UV/Session/DAU/WAU/MAU；
- Node/Worker 同输入同输出契约测试；
- migration 从空库和历史库双路径测试；
- 10 万/100 万事件性能数据集；
- lazy chunk 连续部署测试；
- 浏览器空态、失败态、超时、局部加载和深链测试；
- 隐私测试：手机号、URL 查询参数、输入值不得进入列表 DOM。

---

## 13. 风险与决策点

### 13.1 需要先确认的产品决策

1. 是否引入“业务产品”层，还是继续只有应用层？
2. 活跃用户由哪些事件定义：任意事件、页面访问还是业务关键事件？
3. App 版本具体来自哪个字段，是否允许业务应用自定义？
4. 服务端事实如何接入：复用 `/api/collect`，还是提供 server SDK/API？
5. PostgreSQL 与 D1 是否长期同时支持？若是，必须接受双运行时契约测试成本。
6. 数据保留和分析预聚合保留时间分别是多少？
7. 用户旅程允许哪些角色查看精确用户 ID 和业务主键？

### 13.2 技术风险

- 历史 `release_name`、事件名和缺失字段需要兼容，不能一次性强制迁移。
- 历史事件没有 receivedAt，无法准确回填上报延迟。
- UV/新用户依赖 deviceId 稳定性和隐私策略，跨端合并需谨慎。
- D1 不适合无限增长的原始明细分析，需要归档或外部分析存储。
- 远程配置属于高风险控制面，必须有签名、版本、审计、灰度和回滚。
- 业务漏斗若缺少服务端事实，只能标为“客户端意向漏斗”，不能称为成交漏斗。

---

## 14. 推荐决策

建议先批准 **Phase 0 + Phase 1**，暂不一次性开发全部参考系统能力。

原因：

- Phase 0 解决当前真实存在的导航、运行时差异、字段口径和慢查询问题；
- Phase 1 能以最小产品闭环补齐最明显的“标准流量”缺口；
- 现有漏斗、路径、回放、错误和 Trace 能立即成为标准流量的下钻能力；
- 事件契约、用户旅程和版本质量可以在基础字段稳定后继续开发，避免返工。

最终建议不是把 Web Collection 改成另一个埋点后台，而是形成差异化组合：

```text
可信的产品分析口径
    +
事件契约与采集质量
    +
现有错误/性能/回放/Trace 可观测能力
    =
从业务指标异常直接定位到用户、事件、错误、请求和代码版本的闭环平台
```
