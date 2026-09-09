-- B3 · 合成监控探针结果表（D1 方言：boolean→integer 0/1）
-- 大表索引拆手动：见 migrations-manual/0032_synthetic_results_indexes.sql（避免自动 migrate 超时整批回滚红线）
create table if not exists synthetic_results (
  id               varchar(32) primary key,
  check_id         varchar(32) not null,
  ok               integer not null,
  outcome          varchar(12) not null,
  status_code      integer,
  latency_ms       integer,
  latency_exceeded integer not null default 0,
  error            varchar(256),
  checked_at       bigint not null
);
