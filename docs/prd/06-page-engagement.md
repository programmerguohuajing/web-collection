# PRD 06：页面参与度（Page Engagement）

> 优先级：P2 ｜ 里程碑：M3 ｜ SDK 改动：有（page_leave 重构扩展，非纯搭车）
> 修订：2026-08-26 评审修订——事件名更正为 page_leave（原稿误写 page_left，SDK 中不存在）；补充现状核实与重构范围；分享率口径修正
> 落点：行为分析页新增「页面参与度」Tab
> 参考：对方「用户行为 → 页面参与度」（浏览量/访客/离开/平均停留/90 分位停留/平均滚动/75% 触达/分享）

## 1. 背景与问题

当前知道页面"被打开多少次"（PV/UV），不知道"页面被用得怎么样"：停留多久、看了多深、是否分享。产品改版后无法量化参与度变化。参考系统的参与度指标组是成熟范式。

现有基础：SDK 已有 behavior（点击/路径）、exposure（曝光）模块；页面生命周期事件已有（pv），需确认 page_left/leave 事件现状。

## 2. 目标 / 非目标

**目标**
- G1 SDK 自动采集：停留时长、滚动深度、触达、分享——零配置、搭车上报
- G2 页面维度参与度报表：停留分布、滚动漏斗、触达率、分享率
- G3 改版对比：任意两时间段同页面参与度对比

**非目标**
- 不做逐滚动事件流采集（流量成本不可接受，只报分桶结果）
- 不做热力图可视化（现有 HeatmapPanel 已覆盖点击热图；滚动热图 M3 评估）
- 不做视频/富媒体深度播放追踪

## 3. 用户故事

- 作为产品经理，落地页改版后对比改版前后"75% 触达率"从 41% → 63%，确认改版有效。
- 作为内容运营，看到长文章页"平均滚动 34%、90 分位停留 12s"，判断内容未读即走，调整首屏策略。

## 4. 功能需求

### FR-1 SDK 采集点（搭车 page_leave 事件，不新增事件类型）

**现状核实（原开放问题 1 已关闭）**：

- 现有事件名为 **page_leave**（非 page_left）：visibilitychange→hidden 时上报 `behavior/page_leave{stayTime}`，恢复可见时重置计时（packages/sdk/src/behavior/pv.js）；
- 差距①触发语义：现状"切后台即报"，与本需求的"页面离开收口"不同——需重构 pv.js 的计时与 SPA 路由切换配对逻辑，**不是纯搭车**，工作量按 SDK 重构评估；
- 差距②字段口径：现有 stayTime 为粗粒度停留时长，与 dwell_ms（可见时长、剔除后台）口径不同——两者并存，报表只消费新字段，stayTime 保障旧数据兼容；
- 关闭兜底已具备：sendBeacon transport（beacon-transport.js）与 pagehide force 直发路径均已存在，直接复用，无需 spike。

| 字段 | 采集方式 | 上报位置 |
|---|---|---|
| dwell_ms | 页面可见时长（visibilitychange 累计，后台标签不计） | page_leave.context |
| scroll_max | max(scrollTop / (文档高-视口高))，0~1 | 同上 |
| scroll_buckets | 到达 25/50/75/100% 的标记（bool×4） | 同上 |
| shared | navigator.share 成功 / 微信分享桥接（platform 层适配） | share 事件（仅发生时） |
| tab_hidden_ms | 页面切后台总时长 | 同上（用于剔除无效停留） |

- SPA 路由切换视为页面切换（复用现有路由 hook）
- 兼容：旧 SDK 无这些字段 → 报表按"无数据"处理，不参与均值
- **隐私**：不采集具体滚动轨迹序列，只报分桶结果

### FR-2 页面参与度报表（行为分析 → 参与度 Tab）

| 列 | 口径 |
|---|---|
| 页面 | path（路由归一后） |
| 浏览量 / 访客 | 现有 pv 口径 |
| 平均停留 | dwell_ms 均值（剔除 tab_hidden 占比 >80% 的样本） |
| 90 分位停留 | P90 |
| 平均滚动 / 75% 触达率 | scroll_max 均值 / scroll_buckets[75] 比例 |
| 跳出率（停留 <3s 且无交互） | 定义页头注明 |
| 分享会话率 | 含 share 事件的会话数 / 会话总数（分子分母同为会话粒度；原"share 会话/pv"因一会话多 PV 而口径失真，弃用） |

- 筛选：应用、平台、时间范围；页面搜索
- 单页详情：停留时长分布直方图（0-3s/3-10s/10-30s/30s-2m/2m+）、滚动深度漏斗（25/50/75/100% 递减条）、分享趋势

### FR-3 改版对比

- 选择页面 + 两时间段 → 并排指标对比 + 差异百分比标注

## 5. 接口设计

```
GET /api/analytics/engagement?appId=&platform=&start=&end=&q=&page=

200 {
  "items": [{
    "path": "/product/detail", "pv": 9982, "uv": 3311,
    "avgDwellMs": 41200, "p90DwellMs": 128000,
    "avgScroll": 0.52, "reach75Rate": 0.41,
    "bounceRate": 0.28, "shareRate": 0.012,
    "sampleSize": 9102
  }]
}

GET /api/analytics/engagement/detail?path=&start=&end=&compareStart=&compareEnd=
200 { "distribution": {...}, "scrollFunnel": {...}, "compare": { "avgDwellMs": { "a": 41200, "b": 38100 } } }
```

## 6. 数据模型

无新表；page_leave 事件的 context 新字段入 events.context_json；报表聚合建议纳入预聚合日表（与 02/03/05 共用基建）：`page_daily_stats(path, day, pv, uv, dwell_sum, dwell_p90, scroll_reach_json, share_count)`。该表保留 ≥180 天——改版对比的两时间段可能超出原始 events 30 天保留期，长期对比只能走预聚合。

## 7. SDK 改动清单

| 模块 | 改动 |
|---|---|
| behavior/pv.js | 重构 page_leave 触发时机（离开/路由切换收口）并组装参与度字段（dwell_ms 等） |
| runtime/lifecycle | pagehide 收口兜底（force 直发路径已存在，复用） |
| platform（微信等） | 分享事件桥接 |
| transport | 无改动（beacon force 直发已支持） |

**兼容**：字段全部可选；服务端对缺失字段容错。

## 8. 边界与异常

| 场景 | 行为 |
|---|---|
| 用户直接关闭页面 | page_leave 收口走 pagehide force 直发 + sendBeacon 兜底（两条路径均已存在，直接复用） |
| 单页超长停留（挂机） | dwell 上限截断 2h；tab_hidden 占比>80% 剔除 |
| iframe 嵌入页 | 仅顶层窗口采集（防重复） |
| 样本 <30 | 详情页标注"样本量不足，仅供参考" |

## 9. 成功指标

- 参与度字段覆盖率（page_left 携带率 ≥95%，新 SDK 版本）
- 行为分析页参与度 Tab 周活跃查看
- 客户用参与度数据支撑改版决策的案例数（定性）

## 10. 里程碑

M3-a SDK 采集 + 基础报表；M3-b 单页详情 + 改版对比。

## 11. 开放问题

1. ~~page_left 事件现状确认~~ 已核实：实为 page_leave（pv.js，visibilitychange 触发，stayTime 字段），sendBeacon/force 直发均已支持——差距与重构范围见 FR-1 现状核实
2. 微信小程序侧 share 桥接的平台适配工作量
3. 停留口径是否与对方一致采用"活跃停留"（剔除后台时间）——建议是，页头注明
