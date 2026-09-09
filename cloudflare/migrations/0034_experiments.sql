-- A3 实验分析（PRD 14）：实验定义表 + 曝光表（双栈同构，对齐 apps/api/src/db.js ensureSchema「对齐 D1 0034」段）
-- 列宽对齐既有惯例：app_id varchar(64) 对齐 applications；team_id/id varchar(32) 对齐 0033 注释。
-- 纯新建表（无 ALTER），建表与建索引同文件（新表量级小，符合红线「新表量级小可直接建索引」）。

-- 实验定义表：同一 app_id + key 唯一；同一时刻同 key 仅一个 running（服务端状态机校验，非 DB 约束）
create table if not exists experiments (
  id               varchar(32) primary key,           -- 'exp_' + randomToken(12)
  app_id           varchar(64) not null,
  team_id          varchar(32),                       -- 继承 applications.team_id；accounts=false 时 null
  key              varchar(64) not null,              -- ^[a-z0-9_-]{2,64}$，app 内唯一；同一时刻仅一个 running
  name             varchar(80) not null,
  description      varchar(512),
  status           varchar(16) not null default 'draft', -- draft/running/paused/completed/archived
  salt             varchar(32) not null,              -- 分桶盐（创建时生成，防 key 可预测分桶）
  traffic_pct      integer not null default 100,      -- 0-100
  variants_json    text not null,                     -- [{"name":"control","weight":50},...]
  goal_metric_json text,                              -- {"type":"conversion_event|error_rate|session_duration","event_name":"...","window_days":7}
  started_at       bigint,                            -- 首次置 running 时间
  ended_at         bigint,                            -- 置 completed/archived 时间
  created_by       varchar(64),
  updated_by       varchar(64),
  created_at       bigint not null,
  updated_at       bigint not null
);
create unique index if not exists uq_experiments_app_key on experiments(app_id, key);
create index if not exists idx_experiments_app_status on experiments(app_id, status, updated_at);
create index if not exists idx_experiments_team on experiments(team_id, updated_at);

-- 曝光表：分析的最小归因单元（同一访客同实验仅记首条）
create table if not exists experiment_exposures (
  id             varchar(32) primary key,            -- 'expv_' + randomToken(12)
  experiment_id  varchar(32) not null,               -- FK -> experiments（逻辑外键，不建物理约束，对齐既有表风格）
  app_id         varchar(64) not null,
  team_id        varchar(32),
  visitor_id     varchar(64) not null,               -- 分桶 ID（anonymousId，即 events.device_id 同源）
  session_id     varchar(64),                        -- 首次曝光所在会话
  variant        varchar(32) not null,
  exposed_at     bigint not null
);
-- 去重唯一索引（红线）：同一访客同实验仅记首条；写入一律 on conflict(experiment_id, visitor_id) do nothing
create unique index if not exists uq_exp_exposure_dedup on experiment_exposures(experiment_id, visitor_id);
create index if not exists idx_exp_exposure_variant_ts on experiment_exposures(experiment_id, variant, exposed_at);
create index if not exists idx_exp_exposure_app_ts     on experiment_exposures(app_id, exposed_at);
