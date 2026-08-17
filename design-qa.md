# Design QA · Style B 页面还原

## 对照元数据

- source visual truth path: `D:/code/web-eys-sdk/outputs/design-b/`
- implementation URL: `http://127.0.0.1:5174/`
- implementation screenshot paths:
  - `D:/code/web-eys-sdk/outputs/design-qa/implementation-overview-1280x720.png`
  - `D:/code/web-eys-sdk/outputs/design-qa/implementation-alerts-1280x720.png`
  - `D:/code/web-eys-sdk/outputs/design-qa/implementation-settings-1280x720.png`
- source screenshot paths:
  - `D:/code/web-eys-sdk/outputs/design-qa/reference-overview-1280x720.png`
  - `D:/code/web-eys-sdk/outputs/design-qa/reference-alerts-1280x720.png`
  - `D:/code/web-eys-sdk/outputs/design-qa/reference-settings-1280x720.png`
- viewport: 桌面基准 `1280 × 720` CSS px；响应式补充检查 `720 × 900` CSS px。
- source and implementation pixel dimensions: 最终对照证据均裁切到共同可视区域 `1265 × 712` px；CSS 基准仍为 `1280 × 720`，裁切仅移除浏览器滚动条占用的 15px 宽度和 8px 高度。
- density normalization: 浏览器默认 `deviceScaleFactor = 1`；源稿与实现使用同一浏览器、同一 viewport、同一裁切区域，无缩放或二次采样。
- state: 浅色主题、生产环境；源稿使用设计示例数据，实现使用本地 API 的真实数据。对数据数量和具体文本不做像素级等值判断，仅比较同一信息结构、视觉层级和状态表达。

## 全路由严格还原审计 · 2026-08-14

本轮按“每个页面必须重新打开原始设计稿并与实现同视口比较”的标准复查时，发现 `outputs/design-b/` 与 `outputs/design-qa/` 均为空目录，设计稿从未进入 Git 历史，在工作区、Codex 状态目录和临时目录中也没有可恢复副本。因此此前的 smoke 检查不能继续作为“全页面严格还原”的通过证据。

| 审计分组 | 路由 | 当前证据 | 结论 |
| --- | --- | --- | --- |
| 曾有同视口对照记录 | `/overview`、`/alerts`、`/settings` | 文档保留了 reference/implementation 截图路径和比较结论，但截图文件当前缺失 | 不能重新复核像素差异 |
| 已按首次查看记录重构 | `/replays`、`/traces` | 保留了原稿结构、字段和控件记录，浏览器功能验收通过 | 结构已修复，但缺少当前源稿截图差分 |
| 仅做局部 Style B/KPI 调整 | `/live`、`/errors`、`/performance`、`/behavior`、`/paths` | `cf431e1` 主要增加 KPI，原页面主体结构继续复用 | 高风险未严格还原 |
| 仅改默认状态或标题 | `/analytics`、`/sessions`、`/releases` | 分别只修改默认 tab 或移除标题 | 高风险未严格还原 |
| Design B 提交未做页面级结构修改 | `/logs`、`/governance` | `cf431e1` 未修改对应页面 | 尚无页面级还原证据 |
| 仅重做局部上传组件 | `/sourcemaps` | 只修改 `SourceMapUploader`，缺少整页同视口比较 | 高风险未严格还原 |

阻塞条件：恢复上述 16 个路由对应的 `outputs/design-b` HTML、PNG 或同等视觉原稿后，才能逐页完成源稿截图、当前实现截图、同尺寸组合比较、P0/P1/P2 修复和复验。没有视觉源稿时不根据页面名称或文字说明臆造布局。

## Full-view comparison evidence

- 总览：共同截图显示 244px 白色侧栏、64px 顶栏、浅灰工作区、四列 KPI、趋势/分布双栏、14px 卡片圆角、阴影和紫色品牌色均已对齐。实现保留真实的应用、环境、版本和时间筛选，因此顶栏比源稿的全局搜索更偏运维工作台，这是明确的功能保留。
- 告警：共同截图显示四列 KPI、筛选区、紧凑表格、语义标签和固定操作区均使用同一 Style B 视觉语言。最终实现的记录总数与真实列表一致，长时间戳、应用 ID 和告警内容均单行省略，不再撑高表格行。
- 系统设置：共同截图显示左侧二级导航、右侧管理卡片、表格密度、按钮、状态标签和内容宽度已与源稿一致。实现使用真实应用列表，记录多于源稿示例，因此采样卡片位于更下方，属于数据状态差异。
- 代表页面之外，对 `overview / alerts / live / errors / performance / replays / logs / traces / behavior / analytics / sessions / paths / releases / sourcemaps / governance / settings` 进行了桌面和 720px 断点共 32 个浏览器 smoke 检查：主内容均可见、活动导航正确、无页面级横向溢出。
- 会话回放补充逐页复核：原稿将页面定义为单个会话的 rrweb 回放详情，最终实现已从“筛选表格 + 播放窗口”调整为“用户会话标识 + 深色回放舞台 + 紧凑控制条 + 会话信息/关键事件/最近会话辅助区”。原始 `outputs/design-b/replays.html` 在本轮开始前已不在工作区，本轮依据首次对照时保留的结构、标题和控件记录复核，并以同一浏览器 `1265 × 712` 当前实现截图检查空态和布局；未伪造设计稿中的示例会话数据。
- 链路追踪补充逐页复核：原稿的“三张纵向白色卡片”结构已恢复，页面现在依次展示 Trace 概览、调用拓扑和 Span 时间线/明细；Trace 搜索与分页收进选择抽屉，主内容不再是固定高度的左右分栏。原始 `outputs/design-b/tracing.html` 在本轮复核时已不在工作区，本轮依据首次对照时保留的字段、层级和响应式记录实施，并在同一浏览器 `1280 × 720` 视口下验证真实 Trace 数据、三种视图和抽屉交互。

## Focused region comparison evidence

- 总览 KPI、时间分段控件、ECharts 环形图和浏览器分布在 1265 × 712 全视图中仍可清晰判断，无需额外裁切。字体层级、圆角、色彩和间距与源稿一致；趋势线形状因真实数据不同而不应强行复刻。
- 告警表格头、筛选控件、状态标签和操作列在最终全视图中可读；已重点检查单元格截断和行高，未发现文本换行导致的密度漂移。
- 设置页左侧二级导航和右侧表格在最终全视图中可读；已重点检查激活态、列对齐和长 SDK Key 的省略状态。
- 链路追踪已按原稿记录从左右分栏工作台重排为三卡纵向层级。概览卡保留 Trace ID、应用、版本、环境、入口、开始时间、总耗时、Span 数、错误数和涉及服务；拓扑卡保留拓扑/调用树/瀑布图切换及力导、分层、环形、适应和图例工具；Span 明细卡按开始时间显示服务、操作、Span ID、耗时和状态。所有字段均来自真实接口，没有静态替换为设计稿示例数据。

## Findings

- 没有剩余可执行的 P0 / P1 / P2 视觉问题。
- [P3] 顶栏控件比源稿更密集。
  - Location: 全局顶栏。
  - Evidence: 源稿展示搜索、刷新、环境和用户；实现展示应用、环境、版本、时间、通知、刷新、环境和用户。
  - Impact: 在 1280px 下仍可完整使用，但视觉留白少于源稿。
  - Fix: 若后续允许减少一步筛选，可将四个筛选收纳进“全局筛选”弹层；当前为了保留既有高频工作流不调整。
- [P3] 源稿和实现的图表曲线、告警数量及应用行数不同。
  - Location: 总览趋势、告警、治理和设置列表。
  - Evidence: 源稿是静态示例数据，实现从本地 API 读取真实数据。
  - Impact: 不影响设计系统和信息结构判断。
  - Fix: 不应使用假数据覆盖真实数据；截图测试如需逐像素比较，应增加独立的固定 fixture 模式。
- [P3] 会话回放与链路追踪的原始 HTML 设计稿已不在当前工作区。
  - Location: `outputs/design-b/replays.html`、`outputs/design-b/tracing.html`。
  - Evidence: 本轮只能使用首次查看设计稿时保留的标题、结构、字段和视觉 token 记录，不能重新生成同尺寸源稿截图。
  - Impact: 已完成结构、功能、响应式和 Style B 视觉验收，但无法声称本轮做过新的逐像素差分。
  - Fix: 如需 CI 级像素回归，应恢复原始设计稿文件并生成固定 fixture 截图基线。

## Open Questions

- SourceMap 当前没有“已上传文件列表”的 GET 契约，实现保留真实空态，没有伪造源稿中的上传记录。

## Implementation Checklist

- [x] 使用 design-b tokens 统一全局外壳、卡片、按钮、表格、表单、标签和分页。
- [x] 补齐 16 个导航路由和 `/settings` 页面。
- [x] 保留真实接口、分页、筛选、错误态、空态、拓扑、回放和治理功能。
- [x] 修复总览分段控件、标题层级、P1 横幅顺序、环形分布和趋势空白。
- [x] 修复长字段导致的表格行高膨胀、设置页二级导航布局和 ECharts 零尺寸初始化警告。
- [x] 验证桌面与 720px 响应式断点、键盘 focus-visible、reduced motion 和浏览器控制台。
- [x] 生产构建、严格 UTF-8 和 `git diff --check` 通过。

## Comparison history

### Iteration 1

- Earlier findings: 总览时间范围为浏览器原生按钮；页面标题约 26px；P1 横幅插在 KPI 与主图之间；错误分布缺少环图；真实历史时间戳下趋势图为空。
- Fixes made: 增加统一 segmented 样式；标题收敛到 20px；P1 横幅移到最近错误之后；使用 ECharts 环形分布；趋势图在数据时间窗早于当前时间时从返回事件推导 24 个桶。
- Post-fix visual evidence: `implementation-overview-1280x720.png` 与 `reference-overview-1280x720.png` 的最终共同裁切对照。

### Iteration 2

- Earlier findings: 告警、治理、设置表格的长字段换行导致行高过大；设置页为横向标签而不是源稿的左侧二级导航；ECharts 在快速路由 smoke 时出现零尺寸初始化警告；告警表头总数未引用分页总数。
- Fixes made: 表格统一单行省略并继续使用受表格宽度约束的 tooltip；设置页改为 180px 左侧二级导航；环形图等待 DOM 完成布局后初始化；告警总数统一使用分页 envelope，并在缺失时回退当前行数。
- Post-fix visual evidence: `implementation-alerts-1280x720.png`、`implementation-settings-1280x720.png` 与对应 reference 截图的最终共同裁切对照；最终浏览器 console warning/error 均为 0。

### Iteration 3 · 会话回放

- Earlier findings: `/replays` 首屏仍是四字段查询卡、分页表格和泛化播放窗口，列表占据主要视觉层级；缺少原稿中的单会话标题、`rrweb 回放预览`、深色舞台、`1× / 2× / 4×` 倍速、会话信息和关键事件。
- Fixes made: 将筛选收进右侧抽屉；有列表数据时自动加载首条会话但保持暂停；URL 中指定 `replayId` 时继续直接加载并播放；回放主卡补齐播放/暂停、时间轴、真实时长和倍速；从真实摘要和 rrweb 事件派生用户、分辨率、时间、事件数、错误事件与关键事件；分页列表降为“最近会话”辅助卡；加载失败、无事件、空列表均使用明确状态。
- Post-fix visual evidence: 在内置浏览器 `1265 × 712` 下验证 `/replays`，主舞台成为首屏视觉焦点，右侧会话信息与关键事件卡对齐 Style B；筛选按钮可打开包含原四个真实筛选字段的抽屉，空态下没有空白区域或伪造数据。

### Iteration 4 · 链路追踪

- Earlier findings: `/traces` 仍是固定高度的 300px Trace 列表与右侧画布分栏，Trace 元信息、视图切换、布局工具和详情面板挤在同一首屏工作台；该结构与原稿的“Trace 概览 → 调用拓扑 → Span 时间线/明细”三卡纵向层级不一致。
- Fixes made: 将 Trace 搜索、分页和选择列表收进右侧抽屉；有数据时继续自动选中首条 Trace；概览卡补齐真实应用、版本、环境、入口、开始时间、耗时、Span、错误和服务数；调用拓扑卡保留拓扑、调用树、瀑布图及五个布局工具；新增由分布式 Span 数据派生的时间线明细表，点击拓扑节点或 Span 均使用统一详情抽屉；断点下概览指标改为两列，工具栏换行且不产生页面级横向溢出。
- Post-fix visual evidence: 内置浏览器在 `1280 × 720` 下加载真实 Trace `trace-c9d3faefcd35`，三张卡片均可见，页面宽度 `1265px` 与文档宽度一致、无横向溢出、无 Vite 错误遮罩；“选择 Trace”抽屉展示真实 12 条当前页记录和分页，“调用树”与“瀑布图”切换均成功渲染。

## Follow-up Polish

- 可增加固定 API fixture 的截图回归，使趋势、漏斗和拓扑在 CI 中拥有稳定的像素基准。
- 可在获得 SourceMap 列表契约后补齐设计稿中的“已上传映射”真实列表。

final result: blocked
