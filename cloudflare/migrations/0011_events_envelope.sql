-- Phase 0 · P0-5：事件信封字段扩展（向后兼容）
-- 新增：App 版本拆分、产品、事件/请求 ID、发生/接收时间、信封版本、批次/重试、契约状态。
-- 全部为可空或可默认，旧事件无需回填即可继续读取。
-- 注意：SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS；迁移由 d1_migrations
-- 追踪只会执行一次，无需幂等（CREATE INDEX 的 IF NOT EXISTS 是合法语法，保留）。
alter table events add column app_version text;
alter table events add column product_id text;
alter table events add column event_id text;
alter table events add column request_id text;
alter table events add column occurred_at integer;
alter table events add column received_at integer;
alter table events add column schema_version text;
alter table events add column batch_id text;
alter table events add column retry_count integer default 0;
alter table events add column contract_status text;
alter table events add column contract_errors_json text;

create index if not exists idx_events_event_id on events(event_id);
create index if not exists idx_events_request_id on events(request_id);
create index if not exists idx_events_app_version on events(app_id, app_version, ts desc);
