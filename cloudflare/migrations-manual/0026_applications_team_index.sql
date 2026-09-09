-- D2 · applications.team_id 索引（手动执行，红线：存量大表索引不进自动迁移，避免超时整批回滚）。
-- 手动执行：npx wrangler d1 execute web-collection --remote --file=cloudflare/migrations-manual/0026_applications_team_index.sql
-- 并手工登记：INSERT INTO d1_migrations (id, name, applied_at) VALUES (26, '0026_applications_team_index', unixepoch());
create index if not exists idx_applications_team on applications(team_id);
