# PRD 02：事件字典与数据健康（Event Dictionary）

> 优先级：P0 ｜ 里程碑：M1 ｜ SDK 改动：无
> 修订：2026-08-26 评审修订——预聚合维护方式定稿为定时任务批量聚合；补充保留期约束与 D1 方言说明
> 前置：统一事件口径（上位文档 P0 基建：pv/page_viewed/session_started 命名归一）
> 关联：消费数据 events；产出供 AI 知识库（source_type=event_dict）与 05 漏斗选择事件

## 1. 背景与问题

- SDK 能采什么事件、线上实际在报什么事件、哪些事件停止上报了——目前只存在于研发记忆中；
- 事件量突增/突降无人感知（往往是业务改动或采集故障的信号）；
- 参考系统以「事件定义 + 健康状态 + Contract 接受率」构成数据质量根基，其工作台"指标/占比/判定/为什么"的自解释设计显著降低使用门槛。

## 2. 目标 / 非目标

**目标**
- G1 自动发现并登记所有线上事件，形成可检索字典（零人工维护起步）
- G2 每个事件给出可解释的健康判定（🟢🟡🔴🟠）
- G3 字段完整率统计，暴露"半截数据"
- G4 字典作为 AI 知识源，诊断时可引用"该事件当前上报异常"

**非目标**
- 不做强 Schema 校验与拒绝（那是埋点平台契约模式；我们做轻量"登记+观察"）
- 不做事件的下线/删除管控（M2 视需要再加）

## 3. 用户故事

- 作为研发，接手陌生项目，打开字典即知系统有哪些事件、各自含义与负责人。
- 作为观测平台维护者，看到 `trade_order_completed` 判定 🔴"12 天无上报"，点击"为什么"看到趋势断崖日期，去查该日发布记录。
- 作为 AI 诊断流程：诊断器发现某页面无 pv 上报，引用字典条目"该事件近 3 天停滞"作为证据。

## 4. 功能需求

### FR-1 事件列表

| 列 | 说明 |
|---|---|
| 事件名 | name/type；点击开详情侧滑 |
| 来源 | 自动采集 / 手动埋点 / 服务端（按 source 字段归类） |
| 触发端 | web/h5/小程序（platform） |
| 近 7 日上报量 | 数字 + mini 迷你趋势条 |
| 最近上报 | 相对时间（"2 分钟前"） |
| 字段完整率 | 关键字段非空占比（最低值展示，hover 展开各字段） |
| 健康 | 🟢🟡🔴🟠 徽标（规则见 FR-2） |
| 判定 | 一句话人话解释 |

- 筛选：来源、健康状态、触发端；搜索事件名
- 「未登记事件」分组置顶：近 7 日新出现且未人工登记含义的事件，提示补充登记

### FR-2 健康判定规则（透明可解释）

| 状态 | 规则（按优先级取首个命中） |
|---|---|
| 🔴 停滞 | 近 7 日上报量 = 0 且历史有数据 |
| 🟠 字段缺失 | 关键字段完整率 < 95% |
| 🟡 波动 | 近 24h 量 vs 前 7 日日均，偏离 > ±50% |
| 🟢 健康 | 其余 |

- 每行「为什么」展开：展示判定依据的具体数值与时间断点（借鉴参考系统"为什么不变/需要什么条件"）
- 规则常量（50%、95%、7 天）M1 写死，M2 可配置

### FR-3 事件详情侧滑

- 基本信息：名称、来源、触发端、首次/最近上报、负责人（人工登记字段）
- 含义与备注：人工登记的业务含义（markdown，可编辑，存 platform_settings 或新表）
- 近 30 天趋势图（日粒度）
- 字段完整率表：字段名 / 非空率 / 样例值（脱敏后）
- 样例事件：最新 3 条（JSON 格式化，按数据等级脱敏）
- 关联：该事件的错误 Top3、包含该事件的漏斗（05 落地后回填）

### FR-4 人工登记

- 「登记含义」弹窗：业务含义（必填才计入"已登记"）、负责人、标签
- 登记数据存 PG/D1 事件字典表；未登记不阻塞任何功能

### FR-5 AI 消费

- 字典全量快照（事件名+含义+健康）作为知识库新 source_type=`event_dict` 注入
- diagnoser prompt 的 relatedKb 可引用；诊断结论可输出"相关事件当前状态：🔴 停滞"

## 5. 接口设计

```
GET /api/events/dictionary?source=&health=&platform=&q=&page=&pageSize=50

200 {
  "items": [{
    "name": "page_view", "source": "auto", "platform": "web",
    "count7d": 9982, "lastSeenAt": 1756180030000,
    "fieldCompleteness": { "overall": 0.98, "worst": { "field": "referrer", "rate": 0.91 } },
    "health": "healthy|stalled|fluctuating|incomplete",
    "verdict": "近24h上报 1,204，较前7日日均 +12%，正常",
    "registered": true, "owner": "张三"
  }],
  "total": 47
}

GET /api/events/dictionary/{name}?platform=   → 详情（趋势30d、字段完整率、样例3条）
PUT  /api/events/dictionary/{name}             → 登记含义 { description, owner, tags }
```

## 6. 数据模型

```sql
-- D1 / PG 双端（方言注意：PG 用 jsonb）
create table if not exists event_dictionary (
  name varchar(160) primary key,          -- 事件名
  description text,                        -- 人工登记含义
  owner varchar(64),
  tags_json jsonb,                         -- PG jsonb / D1 text(JSON)
  registered_at bigint,
  updated_at bigint
)
```

- D1 方言：上表需双端分支——PG 用 jsonb，D1 中 tags_json 用 TEXT(JSON) 存储；迁移脚本各自维护
- 保留期约束：原始 events 仅保留 30 天（governance.retention），🔴停滞判定的"历史有数据"最多回看 30 天；更早历史依赖 event_daily_stats，该表保留 ≥180 天

- 统计查询基于 events 表聚合（group by name），**必须走预聚合**（上位文档 P0：原始扫描不适合长区间）：按日聚合表 `event_daily_stats(name, day, count, platform)`，由 governance 定时任务（cleanupExpiredData 同进程，governance.js:215）每日批量聚合维护；**不在 ingest 热路径增量更新**——Worker 每次上报追加一次 upsert 会放大 subrequest 消耗（参见 commit 594c0e4 对 CF 50 subrequest 限额的修复教训）

## 7. 边界与异常

| 场景 | 行为 |
|---|---|
| 事件量巨大（>500 种） | 分页 + 搜索；默认按近 7 日量降序 |
| 事件改名（口径归一后新旧并存） | 字典按归一后口径合并展示，旧名标注"别名→新名" |
| 字段完整率计算成本 | 仅对 context_json 顶层字段统计，日粒度预聚合 |

## 8. 成功指标

- 字典覆盖率（线上出现的事件 100% 可在字典检索到）
- 未登记事件占比 < 30%（上线 1 个月）
- 事件停滞平均发现时长从"被动发现"到 ≤7 天（判定规则保证）

## 9. 里程碑

M1-a 列表 + 健康判定；M1-b 详情侧滑 + 人工登记 + AI 注入。

## 10. 开放问题

1. 关键字段清单按事件类别维护（pv: url/referrer；click: target；...）——初版内置，是否开放配置待定
2. ~~预聚合维护方~~ 已决：governance 定时任务每日批量聚合（见 §6），否决 ingest 增量方案（热路径写放大 + CF subrequest 配额风险）
