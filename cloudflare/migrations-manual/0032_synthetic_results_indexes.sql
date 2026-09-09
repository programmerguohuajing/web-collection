-- B3 · 合成监控手动索引（migrations-manual，需手工执行 + 登记 d1_migrations）。
-- synthetic_results 随探测高频写入，索引拆手动避免自动 migrate 超时整批回滚（D2 红线）。
-- 手动执行：
--   wrangler d1 execute web-collection --file=cloudflare/migrations-manual/0032_synthetic_results_indexes.sql
--   wrangler d1 execute web-collection --command="INSERT INTO d1_migrations (id, name, applied_at) VALUES (32, '0032_synthetic_results_indexes', unixepoch())"
create index if not exists idx_syn_results_check_time on synthetic_results(check_id, checked_at desc);
create index if not exists idx_syn_results_checked_at on synthetic_results(checked_at);
