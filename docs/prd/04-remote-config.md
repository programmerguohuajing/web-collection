# PRD 04：远程配置下发（Remote SDK Config / 熔断）

> 优先级：P1 ｜ 里程碑：M2（a）→ M3（b/c）｜ SDK 改动：有（配置拉取）
> 修订：2026-08-26 评审修订——采样 schema 对齐 SDK 现有 deterministic-sampler 参数；config_version 实现定稿；限流双端落地与上限保护口径澄清
> 落点：采集治理页新增「远程配置」Tab
> 参考：对方「熔断配置」（L3 总开关 / L1 拉黑 / L2 关插件 / 采样覆盖，sdk-config 下发）

## 1. 背景与问题

SDK 线上故障（插件死循环、某事件暴量、回放拖垮性能）目前只能等用户升级 SDK，止血周期以天计。需要运营侧可操作的"远程止血"能力：不动用户代码，几分钟内调整采集行为。

现有基础：SDK 已有 `sampling`（确定性采样）与 `runtime` 模块；采集治理页已有"采样规则/阻断事件/关闭插件/监控项/阈值"的**本地配置**形态（未远程下发）。

## 2. 目标 / 非目标

**目标**
- G1 管理端可按 应用×平台×SDK 版本 范围下发采集配置，5 分钟内生效
- G2 三层控制：事件拉黑（L1）、插件开关（L2）、总开关+采样（L3）
- G3 全程审计：谁/何时/改了什么，一键回滚
- G4 失败安全：配置服务不可用时 SDK 按默认全开运行，**绝不因配置系统故障停采**

**非目标**
- 不做用户级个性化配置（仅到 应用/版本 粒度）
- 不做配置灰度百分比发布（M3 评估）
- 不做服务端采集配置

## 3. 用户故事

- 作为值班研发，发现 `content_exposed` 事件暴量 10 倍拖垮带宽，在远程配置中拉黑该事件，5 分钟内全网生效，次日修复后移除拉黑。
- 作为 SDK 维护者，回放模块在低端机引发卡顿投诉，对 sdk_version<=0.1.0-alpha.50 的 h5 应用关闭回放插件。
- 作为平台管理员，误操作关闭全部采集后，从变更历史一键回滚。

## 4. 功能需求

### FR-1 配置项（三级模型，沿用对方 L1/L2/L3 语义）

| 级 | 配置 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| L3 | 采集总开关 | enum | `on` | on / off；off 时 SDK 仅保留会话心跳，不采不报 |
| L3 | 采样率 | object | 行为=100% 性能=10% 回放=5% 错误=100%（trace 继承行为率） | 管理面按类别百分比下发，SDK 端转换为 deterministic-sampler 参数（见下方对齐说明） |
| L1 | 事件拉黑 | string[] | [] | 精确匹配事件名，命中即丢弃（采样前） |
| L2 | 插件开关 | object | 全 on | performance / error / replay / behavior / exposure / trace |
| 治理 | 上限保护 | object | 单设备单类事件 ≤500/10min | 超限丢弃并计数（防暴量，SDK 端执行）。口径：SDK 无稳定用户身份时按 device_id 近似"单用户"；滑动窗口驻留页面内存，跨刷新不累计——页头须注明此近似性 |

**采样对齐说明（评审核实）**：SDK 现有采样模型为 `sampleRate / traceRate / errorSampleRate` 三参数 + trace/session/global 决策单元（packages/sdk/src/sampling/deterministic-sampler.js，另见 docs/sampling-v2.md）。远程下发的类别百分比只是管理面视角，SDK config 模块负责映射为上述参数集——行为→sampleRate(session)、trace→traceRate、错误→errorSampleRate；性能/回放对应现有插件内的类别率常量改为读 config。**不得另起一套采样语义**，否则 §7 的改动清单会显著低估。

### FR-2 生效范围

- 维度矩阵：租户（预留）× 应用 × 平台 × SDK 版本（支持 `<=` 区间，服务"对旧版本关插件"场景）
- 匹配规则：最具体者生效（版本区间 > 应用默认 > 全局默认）

### FR-3 下发与生效

- 通道：SDK 启动 + 每 5 分钟拉取 `GET /sdk-config`（决策 D2），响应带 `config_version` + ETag（304 免传输）
- 生效观测：SDK 上报时携带 `config_version`；治理页展示"各配置版本命中应用数"，确认灰度覆盖
- 失败安全：拉取失败/超时(3s)/响应非法 → 沿用上次配置；从未拉到过 → 内置默认全开

### FR-4 管理界面（采集治理 → 远程配置 Tab）

- 顶部：当前全局配置摘要 + "有应用使用自定义配置 N 个"
- 配置编辑器：按范围（全局默认 / 某应用 / 某版本区间）分块编辑；冲突时高亮提示"该范围将被更具体配置覆盖"
- 保存：二次确认（总开关 off 需输入确认文案）→ 写入 + 审计
- 变更历史：时间线（操作人/时间/diff/生效范围），每条「回滚」按钮
- 命中查询：输入 应用+版本，预览"将命中哪条配置"

### FR-5 审计与安全

- 配置表每次变更 append 审计记录（不可改删）
- 管理端点仅同源 + 管理权限（07 落地后挂 L4）
- 下发接口只读、无鉴权敏感数据（配置本身非机密），但需限流防滥用——**双端都要做**：Worker 端 IP 令牌桶；Node(express) 侧现有限流中间件需盘点后接入（评审补充项，原稿只写了单端）

## 5. 接口设计

### 管理端（同源）

```
GET  /api/collect-config?appId=&platform=&sdkVersion=   → 预览命中结果
PUT  /api/collect-config                                 → { scope: {...}, config: {...} }
GET  /api/collect-config/history?scope=                  → 变更历史
POST /api/collect-config/rollback                        → { historyId }
GET  /api/collect-config/stats                           → config_version 命中统计
```

### SDK 端（公开）

```
GET /sdk-config?app_id=h5&platform=web&sdk_version=0.1.0-alpha.59

304 Not Modified（ETag 命中）
200 {
  "config_version": 12,
  "ttl_ms": 300000,
  "master_switch": "on",
  "sampling": { "error": 1.0, "performance": 0.1, "replay": 0.05, "behavior": 1.0 },
  "blocked_events": ["content_exposed"],
  "plugins": { "performance": true, "replay": false, ... },
  "rate_limits": { "per_event_per_user_10min": 500 }
}
```

## 6. 数据模型（D1/PG 双端）

```sql
create table if not exists collect_configs (
  id bigserial primary key,            -- D1: integer primary key autoincrement
  scope_json jsonb not null,           -- {appId?, platform?, sdkVersionMax?} 空对象=全局默认
  config_json jsonb not null,
  config_version integer not null,     -- 全局单调递增
  created_by varchar(64) not null,
  created_at bigint not null
)
create table if not exists collect_config_audit (
  id bigserial primary key,
  action varchar(16) not null,         -- create|update|rollback
  config_snapshot jsonb not null,
  diff_json jsonb,
  operator varchar(64) not null,
  created_at bigint not null
)
```

- SDK 拉取接口按 scope 匹配最新一条；`config_version` 直接取 `collect_config_audit` 的 max(id)（append-only 保证单调，免独立计数器与并发冲突；原 platform_settings 行锁方案废弃）
- D1 方言：id 列 integer primary key autoincrement（建表注释已标）；scope_json/config_json/diff_json 在 D1 用 TEXT(JSON)、PG 用 jsonb——双端迁移脚本分开维护

## 7. SDK 改动清单

| 模块 | 改动 |
|---|---|
| 新增 config 模块 | 拉取/缓存(内存+localStorage)/ETag/失败降级 |
| sampling | 采样率从本地常量改为读 config |
| transport | 事件名黑名单过滤（采样前）；上报携带 config_version |
| 各插件 | 初始化时读插件开关；运行中收到新配置热生效（下一 tick） |
| 上限保护 | 每事件类滑动窗口计数器 |

**兼容性**：旧 SDK 不拉配置不受影响；新 SDK 在配置接口 404 时静默用默认。

## 8. 边界与异常

| 场景 | 行为 |
|---|---|
| 配置服务宕机 | SDK 沿用缓存；首次启动则默认全开 |
| 时钟偏差 | ttl 按本地 elapsed 计 |
| 拉黑事件被误操作 | 变更历史一键回滚；审计可查 |
| 配置冲突（多层 scope） | 管理端预览高亮；下发按最具体匹配 |
| 恶意刷 /sdk-config | 限流（IP 令牌桶）+ ETag 降低成本 |

## 9. 成功指标

- 线上事件事故平均止血时长从「天级（等升级）」到「≤10 分钟」
- config_version 命中率（下发后 1h 内 ≥95% 活跃会话升级到新配置）
- 误操作回滚次数与恢复时长

## 10. 里程碑

- M2-a：L1 拉黑 + 采样率 + SDK config 模块 + 审计
- M3-b：L2 插件开关热生效
- M3-c：L3 总开关 + 上限保护 + 版本区间 scope

## 11. 开放问题

1. ~~config_version 单调计数器在 CF D1 上的实现~~ 已决：直接取 collect_config_audit.max(id)，无需行锁或冲突重试（见 §6）
2. 总开关 off 时会话心跳是否保留（建议保留，否则"离线应用"无从发现）
3. 是否需要"配置灰度"（按用户百分比先发 10%）——M3 评估
