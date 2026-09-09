-- A2 · 自定义看板分享：share_token 唯一索引（手动执行）。
-- 红线要求：线上大表建索引可能超时，不走自动 migrate；由工程师在有凭证环境手动执行，
-- 并向 d1_migrations 表登记：
--   insert into d1_migrations (id, name, applied_at) values (24, '0024_dashboards_share_index', unixepoch());

create unique index if not exists idx_dashboards_share_token on dashboards(share_token);
