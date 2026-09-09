-- B2 · SLO 定义表（自动迁移；Cloudflare D1 方言：jsonb→TEXT(JSON)，bigserial→INTEGER PRIMARY KEY AUTOINCREMENT）。
-- 复用 D2 applications.team_id 归属；accounts=false 时 team_id=NULL。
-- 对齐 Node / Postgres（apps/api/src/db.js ensureSchema）：字段一致，仅类型方言不同。
create table if not exists slo_definitions (
  id           varchar(32) primary key,
  app_id       varchar(64) not null,       -- 对齐 applications.app_id varchar(64)（PG 侧实测宽度，勿用 32）
  team_id      varchar(32),                 -- 取自 applications.team_id；accounts=false 时 NULL
  name         varchar(80) not null,
  objective    real not null,              -- 0.999 等
  window_days  integer not null default 30,   -- 28 | 30
  sli_type     varchar(16) not null,       -- error_rate | latency_threshold | availability
  sli_config   text not null default '{}', -- jsonb→TEXT(JSON)；见架构 §3.4
  alert_policy text not null default '{}', -- 多窗口燃烧率阈值 + channel_ids（severity→[channelId]）
  created_by   varchar(32),
  created_at   bigint not null,
  updated_at   bigint not null
);
