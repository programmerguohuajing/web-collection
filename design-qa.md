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

## Full-view comparison evidence

- 总览：共同截图显示 244px 白色侧栏、64px 顶栏、浅灰工作区、四列 KPI、趋势/分布双栏、14px 卡片圆角、阴影和紫色品牌色均已对齐。实现保留真实的应用、环境、版本和时间筛选，因此顶栏比源稿的全局搜索更偏运维工作台，这是明确的功能保留。
- 告警：共同截图显示四列 KPI、筛选区、紧凑表格、语义标签和固定操作区均使用同一 Style B 视觉语言。最终实现的记录总数与真实列表一致，长时间戳、应用 ID 和告警内容均单行省略，不再撑高表格行。
- 系统设置：共同截图显示左侧二级导航、右侧管理卡片、表格密度、按钮、状态标签和内容宽度已与源稿一致。实现使用真实应用列表，记录多于源稿示例，因此采样卡片位于更下方，属于数据状态差异。
- 代表页面之外，对 `overview / alerts / live / errors / performance / replays / logs / traces / behavior / analytics / sessions / paths / releases / sourcemaps / governance / settings` 进行了桌面和 720px 断点共 32 个浏览器 smoke 检查：主内容均可见、活动导航正确、无页面级横向溢出。

## Focused region comparison evidence

- 总览 KPI、时间分段控件、ECharts 环形图和浏览器分布在 1265 × 712 全视图中仍可清晰判断，无需额外裁切。字体层级、圆角、色彩和间距与源稿一致；趋势线形状因真实数据不同而不应强行复刻。
- 告警表格头、筛选控件、状态标签和操作列在最终全视图中可读；已重点检查单元格截断和行高，未发现文本换行导致的密度漂移。
- 设置页左侧二级导航和右侧表格在最终全视图中可读；已重点检查激活态、列对齐和长 SDK Key 的省略状态。
- 链路追踪继续保留项目原有的左右分栏交互工作台（搜索列表、拓扑、调用树、瀑布图及布局工具），没有静态替换为源稿示例卡片；其色彩、边框、半径、激活态和信息密度已切换到同一 Style B 设计系统。这是保留现有高密度功能的产品约束，而非遗漏状态。

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

## Open Questions

- 当前将链路追踪的分栏工作台视为需要保留的既有核心交互，只还原其 Style B 视觉语言；如果后续要求严格复刻 `tracing.html` 的三张纵向卡片结构，需要单独确认是否接受减少同屏操作能力。
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

## Follow-up Polish

- 可增加固定 API fixture 的截图回归，使趋势、漏斗和拓扑在 CI 中拥有稳定的像素基准。
- 可在获得 SourceMap 列表契约后补齐设计稿中的“已上传映射”真实列表。

final result: passed
