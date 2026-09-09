-- B3 · 合成监控探针定义表（D1 方言：boolean→integer 0/1；对齐 Node ensureSchema，字段一致仅类型方言不同）
-- app_id varchar(64)：对齐 applications.app_id 宽度（B2 曾踩 32 宽度与 applications 不齐的坑，勿用 32）
create table if not exists synthetic_checks (
  id                   varchar(32) primary key,
  app_id               varchar(64) not null,
  team_id              varchar(32),
  name                 varchar(80) not null,
  url                  varchar(512) not null,
  method               varchar(8) not null default 'GET',
  interval_seconds     integer not null default 300,
  timeout_ms           integer not null default 10000,
  expected_status      integer not null default 200,
  keyword              varchar(256),
  latency_threshold_ms integer,
  fail_threshold       integer not null default 3,
  enabled              integer not null default 1,
  last_status          varchar(12) default 'unknown',
  last_run_at          bigint,
  consecutive_failures integer not null default 0,
  created_at           bigint not null,
  updated_at           bigint not null
);
