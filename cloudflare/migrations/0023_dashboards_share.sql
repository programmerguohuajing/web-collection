-- A2 · 自定义看板分享：在 dashboards 表追加分享开关与 token 列。
-- D1 不支持 IF NOT EXISTS 与 boolean 类型，故用裸 ALTER TABLE + integer(0/1) 表达布尔。
-- 注意：一个迁移文件内的多条语句当作一批执行，任一超时整批回滚，故索引（0024）单独文件。

alter table dashboards add column shared integer not null default 0;
alter table dashboards add column share_token text;
