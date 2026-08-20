-- Phase 0 · P0-5：事件信封字段索引（拆自 0011）
-- 这些索引在大体积 events 表（线上数百 MB）上构建可能超过 D1 单次查询 30s 超时，
-- 故从纯列迁移 0011 中拆出，便于线上通过 wrangler --remote 单条重试应用；
-- CREATE INDEX IF NOT EXISTS 可安全重试，部分建好后继续直到成功。
-- 新环境（本地/新部署）events 行数少，CI 一次性应用也不会超时。
create index if not exists idx_events_event_id on events(event_id);
create index if not exists idx_events_request_id on events(request_id);
create index if not exists idx_events_app_version on events(app_id, app_version, ts desc);
