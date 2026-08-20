-- Phase 0 · P0-5：事件信封字段扩展（向后兼容）
-- 新增：App 版本拆分、产品、事件/请求 ID、发生/接收时间、信封版本、批次/重试、契约状态。
-- 全部为可空或可默认，旧事件无需回填即可继续读取。
-- 注意：SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS；迁移由 d1_migrations
-- 追踪只会执行一次，无需幂等。仅含列定义（元数据操作，瞬时完成）；索引拆到
-- 0013_envelope_indexes.sql，避免在数百 MB 的 events 表上建索引触发 D1 30s 超时
-- 把整批迁移回滚（2026-08-20 线上事故根因）。
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
