-- Next Horizon E4/E1 补齐：SDK 构建产物体积开销（CI 在发版时上报，非实时采集）。
create table if not exists sdk_size (
  id integer primary key autoincrement,
  version text not null,
  gz_bytes integer,
  raw_bytes integer,
  min_bytes integer,
  runtime_mem text,
  reported_at integer not null,
  ci_run text
);

create index if not exists idx_sdk_size_version on sdk_size (version);
create index if not exists idx_sdk_size_reported on sdk_size (reported_at);
