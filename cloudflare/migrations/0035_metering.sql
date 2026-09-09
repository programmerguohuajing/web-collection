-- D3 · 用量计量 & 套餐/定价（PRD 15）：用量日聚合表 + 套餐档位 + 团队档位绑定 + 超限留痕
-- 双栈同构：对齐 apps/api/src/db.js ensureSchema「D3 对齐 0035」段（列名/列宽/默认值逐字一致）。
-- 列宽红线：app_id varchar(64) 对齐 applications；team_id varchar(32) 对齐 teams/team_members（见 0033/0034 注释）。
-- 纯新建表 + 索引 + 种子（无 ALTER TABLE ADD COLUMN），故建表与建索引同文件（符合「新表量级小可直接建索引」红线）。
--
-- ⚠️ 保留策略红线：`usage_daily` 与 `quota_events` 是账单/争议凭证，保留 25 个自然月，
--    且**不得**加入 cleanup() 的删除清单（其清理由 metering 独立任务执行）。
--    改动这两张表的清理归属前必须先改 apps/api/src/governance.js 与 worker.js 的显式排除注释。
--
-- 日切口径：`day` = yyyyMMdd（UTC 自然日），与既有 metric_daily_stats（0022）同范式；
-- period_key = 'YYYY-MM' 与 day 可互推，故**不建 usage_monthly 冗余表**（避免双写账本漂移）。

-- ==================== ① usage_daily：权威计量表（排除在 retention 清理外） ====================
-- 月度用量 = 当月所有日快照求和；seats 为日快照值，月度取 max(value)（PRD §6.4 / Q3）。
create table if not exists usage_daily (
  team_id    varchar(32) not null default '',   -- accounts=false 单租户恒 ''
  app_id     varchar(64) not null default '',   -- '' = 团队级（seats 维度用）
  metric     varchar(24) not null,              -- events | replay_sessions | seats
  day        integer     not null,              -- yyyyMMdd（UTC 自然日）
  value      integer     not null default 0,    -- 当日累计（events/replay_sessions 累加；seats 覆盖写）
  updated_at bigint      not null,
  primary key (team_id, app_id, metric, day)
);
create index if not exists idx_usage_team_day on usage_daily(team_id, day);
create index if not exists idx_usage_app_day  on usage_daily(app_id, day);

-- ==================== ② plans：套餐档位（配置式，改档位不发版） ====================
-- quota_json 示例：{"events":100000,"replay_sessions":1000,"seats":3,"retention_days":7}；-1 = 不限量。
-- price_hint_json 仅为 UI 展示文案，P0 不参与任何计费计算（PRD §10 红线）。
-- enabled integer 0/1（PG 侧为 boolean，服务层统一 Boolean(row.enabled) 映射）。
create table if not exists plans (
  id              varchar(32) primary key,      -- 'plan_' + randomToken(12)（种子用固定 id 便于幂等）
  code            varchar(32) not null unique,  -- free | pro | enterprise
  name            varchar(64) not null,
  quota_json      text not null,
  soft_limit_pct  integer not null default 80,
  hard_action     varchar(16) not null default 'none',  -- none | reject | sample_down（P0 恒 none）
  price_hint_json text,
  enabled         integer not null default 1,
  created_at      bigint not null,
  updated_at      bigint not null
);

-- ==================== ③ team_plans：团队 ↔ 档位绑定（含 per-team 定制覆盖） ====================
-- 无行 = 默认挂 free 档（逻辑默认，不写物理行，避免上线即批量写入；PRD Q5）。
create table if not exists team_plans (
  team_id             varchar(32) primary key,  -- 一个团队一条
  plan_id             varchar(32) not null,
  quota_override_json text,                     -- per-team 覆盖（enterprise 议价）；null = 用档位默认
  updated_by          varchar(64),
  updated_at          bigint not null
);

-- ==================== ④ quota_events：超限事实留痕（排除在 retention 清理外） ====================
-- 唯一约束 uq_quota_event 保证「同一周期同一维度同一级别只提醒一次」（PRD §6.3 / §11）。
create table if not exists quota_events (
  id         varchar(32) primary key,           -- 'qe_' + randomToken(12)
  team_id    varchar(32) not null,
  metric     varchar(24) not null,              -- events | replay_sessions | seats
  period_key varchar(8)  not null,              -- 'YYYY-MM'
  level      varchar(8)  not null,              -- soft | hard
  value      bigint not null,                   -- 触发时用量快照
  quota      bigint not null,                   -- 触发时配额快照
  notified   integer not null default 0,        -- 通道投递结果（1 = 已投递）
  created_at bigint not null
);
create unique index if not exists uq_quota_event on quota_events(team_id, metric, period_key, level);
create index if not exists idx_quota_events_team_period on quota_events(team_id, period_key);

-- ==================== ⑤ 种子档位（on conflict(code) do nothing 幂等） ====================
-- 存量团队默认挂 free：不写 team_plans 物理行，由 resolvePlan 逻辑兜底（PRD Q5）。
insert into plans (id, code, name, quota_json, soft_limit_pct, hard_action, price_hint_json, enabled, created_at, updated_at)
values ('plan_free', 'free', '免费版', '{"events":100000,"replay_sessions":1000,"seats":3,"retention_days":7}', 80, 'none', null, 1, cast(strftime('%s','now') as integer) * 1000, cast(strftime('%s','now') as integer) * 1000)
on conflict(code) do nothing;

insert into plans (id, code, name, quota_json, soft_limit_pct, hard_action, price_hint_json, enabled, created_at, updated_at)
values ('plan_pro', 'pro', '专业版', '{"events":5000000,"replay_sessions":50000,"seats":20,"retention_days":30}', 80, 'none', null, 1, cast(strftime('%s','now') as integer) * 1000, cast(strftime('%s','now') as integer) * 1000)
on conflict(code) do nothing;

insert into plans (id, code, name, quota_json, soft_limit_pct, hard_action, price_hint_json, enabled, created_at, updated_at)
values ('plan_enterprise', 'enterprise', '企业版', '{"events":-1,"replay_sessions":-1,"seats":-1,"retention_days":90}', 80, 'none', null, 1, cast(strftime('%s','now') as integer) * 1000, cast(strftime('%s','now') as integer) * 1000)
on conflict(code) do nothing;
