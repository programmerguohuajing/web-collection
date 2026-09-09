-- Next Horizon E4/E1 补齐：SDK 端交付自监控快照存储（与 ingestionMonitor 互补，聚焦 SDK 侧 sent/dropped/retried...）。
-- 新建表 + 索引；新表建索引即时完成，无大表 ALTER 超时风险。
create table if not exists sdk_monitoring (
  id integer primary key autoincrement,
  app_id text not null,
  sdk_version text,
  session_id text,
  ts integer not null,
  sent integer not null default 0,
  dropped integer not null default 0,
  retried integer not null default 0,
  timeouts integer not null default 0,
  rate_limited integer not null default 0,
  queue_full integer not null default 0,
  storage_quota integer not null default 0,
  health text,
  payload text
);

create index if not exists idx_sdk_monitoring_app_ts on sdk_monitoring (app_id, ts);
create index if not exists idx_sdk_monitoring_ts on sdk_monitoring (ts);
