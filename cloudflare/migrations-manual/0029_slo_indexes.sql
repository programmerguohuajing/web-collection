-- B2 · SLO 手动索引（migrations-manual，需手工执行 + 登记 d1_migrations）。
-- slo_burn_snapshots 随写入增长，索引拆手动避免自动 migrate 超时整批回滚（D2 红线）。
-- 手动执行：
--   wrangler d1 execute web-collection --file=cloudflare/migrations-manual/0029_slo_indexes.sql
--   wrangler d1 execute web-collection --command="INSERT INTO d1_migrations (id, name, applied_at) VALUES (29, '0029_slo_indexes', unixepoch())"
create index if not exists idx_slo_team_app on slo_definitions(team_id, app_id, updated_at desc);
create index if not exists idx_burn_slo on slo_burn_snapshots(slo_id, snap_at desc);
