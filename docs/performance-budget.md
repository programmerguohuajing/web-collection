# 性能预算与基线（Phase 0 · P0-6）

> 对应计划：`tracking-platform-comparison-and-evolution-plan.md` §11 Phase 0 工作项
> "为 paths、governance、summary 建性能基线"。
>
> 目标：在新增页面前，先把三个重查询接口（路径分析、采集治理、总览）的延迟
> 预算钉死，并提供可复跑的基准脚本，防止后续改动无声地拖慢现网。

## 1. 为什么是这三个接口

| 接口 | 路由 | 为什么重 |
| --- | --- | --- |
| summary | `GET /api/summary` | 并行拉取最多 5,000 条普通事件 + `maxEvents` 性能事件 + issues + replays，在应用层聚合（`store.js#getSummary`） |
| paths | `GET /api/analytics/paths` | 全量事件会话化后做路径归并（`analytics-service.js#getPaths`） |
| governance | `GET /api/applications`、`GET /api/applications/:appId/releases` | 应用/发版治理列表，含聚合计数（`governance.js`） |

三者都是首屏/导航高频命中、且后续 Phase 1/2/3 会继续叠加逻辑的接口，先钉预算最划算。

## 2. 预算（P95 延迟，单应用 + 标准时间范围）

| 接口组 | 默认预算 P95 | 备注 |
| --- | --- | --- |
| paths | 800 ms | 与 Phase 1 验收 "P95 ≤ 800 ms" 对齐 |
| governance | 800 ms | 列表分页已做上限保护 |
| summary | 1500 ms | 当前为应用层聚合；Phase 1 引入聚合表后应降到 800 ms 以内 |

预算可在脚本中按接口组覆盖：`--budget-paths`、`--budget-governance`、`--budget-summary`。

## 3. 如何运行基准脚本

```bash
# 本地已起 Node API（默认 http://localhost:3000）
node scripts/benchmark-queries.mjs --app-id your-app-id --iterations 20

# 指定基址 / 时间范围（毫秒时间戳）
node scripts/benchmark-queries.mjs \
  --base-url https://your-domain.com \
  --app-id your-app-id \
  --start-time 1700000000000 --end-time 1700086400000 \
  --iterations 30

# 门禁模式：任一接口组 P95 超预算即退出码 1（CI 用）
node scripts/benchmark-queries.mjs --gate --app-id your-app-id

# 把结果落盘，便于趋势对比
node scripts/benchmark-queries.mjs --app-id your-app-id --out outputs/perf-baseline.json
```

脚本行为：
- 对每组接口跑 N 次，记录每次耗时（ms），计算 **p50 / p95 / max**。
- 默认只报告并退出 0；加 `--gate` 后，任一 P95 超过预算即退出 1（并打印超标详情）。
- 若目标服务不可达（连接失败 / 非 2xx），打印 `SKIP` 并退出 0，避免在“无现网”环境里把 CI 打红；加 `--fail-if-unreachable` 可改为严格失败。
- 没有 `--app-id` 时，paths/summary 仍以全量查询；governance 的 releases 子项会被跳过（它需要路径参数）。

## 4. 当前基线（首次跑后回填）

> 待在现网或预发环境首次执行后，把 p50/p95/max 填到这里，作为回归对照。
> 之后每次重大改动前重跑，与下表比对。

| 日期 | 环境 | paths p95 | governance p95 | summary p95 | 备注 |
| --- | --- | --- | --- | --- | --- |
| _TBD_ | _预发_ | _-_ | _-_ | _-_ | 待首次采集 |

## 5. 验收勾选（Phase 0）

- [ ] 三个接口组已有可复跑基准脚本，且能输出 p50/p95/max
- [ ] 预算文档已定义并可在 CI 以 `--gate` 模式拦截回归
- [ ] 首次现网/预发基线已回填到 §4 表格
- [ ] 页面首屏不因一个慢接口被整体遮罩（另见 §10.4 与前端 loading 分区改造）
