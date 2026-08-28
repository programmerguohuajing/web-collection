-- 补齐 events 表缺失的 device/os/browser 列，对齐 Postgres 版 schema（apps/api/src/db.js）。
-- worker.js 的 journeySessions / journeyTimeline 查询引用了 e.device / e.os / e.browser，
-- 若不补列会导致 D1 报 "no such column: e.device"。
-- 注意：SQLite/D1 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，故不加。
alter table events add column device varchar(16);
alter table events add column os varchar(32);
alter table events add column browser varchar(32);
