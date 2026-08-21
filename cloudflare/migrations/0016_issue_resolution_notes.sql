-- Phase 1 · M2：issues 表补 resolution_notes 列，支持 issue 闭环时记录解法备注
-- 注意：SQLite ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS；迁移由 d1_migrations
-- 追踪只会执行一次。0014_ai.sql 中亦定义了同名列，二者由迁移追踪保证只生效一次。
alter table issues add column resolution_notes text;
