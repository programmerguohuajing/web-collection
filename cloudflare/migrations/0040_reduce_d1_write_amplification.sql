-- D1 Insights（最近 7 天）与全仓查询审计确认：以下 events 信封索引没有任何查询谓词使用，
-- 但每次事件写入都会维护它们。删除索引只保留原始列，可将每条事件的 rows-written 计费减少 3 行。
drop index if exists idx_events_event_id;
drop index if exists idx_events_request_id;
drop index if exists idx_events_app_version;

-- 主键 (app_id, metric, day) 已提供完全相同的索引；该二级索引重复维护且不会改善查询计划。
drop index if exists idx_metric_daily_app_metric_day;
