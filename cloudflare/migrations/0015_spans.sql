-- Phase 2 · M5：后端 span 上报表（Cloudflare D1）
-- 镜像 apps/api（PostgreSQL）的 spans 表结构，支持后端服务上报分布式链路 span，
-- 与前端 events 同 trace_id 合并，供跨服务诊断与 trace 拓扑展示。
-- 注释：D1 迁移由 d1_migrations 追踪只执行一次，无需幂等。

create table if not exists spans (
  id              text primary key,
  trace_id        text not null,
  span_id         text not null,
  parent_span_id  text,
  service_name    text,
  operation_name  text,
  kind            text,
  start_ts        integer not null,
  duration        real,
  status_code     text,
  status_message  text,
  attributes_json text,
  ts              integer not null
);
create index if not exists idx_spans_trace on spans(trace_id, start_ts);
create index if not exists idx_spans_parent on spans(trace_id, parent_span_id);
