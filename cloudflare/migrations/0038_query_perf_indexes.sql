-- 性能优化：D1 免费版日行读超 500 万上限导致全站读端点 500（2026-09-10/11 事故，08:00 配额重置才恢复）
-- wrangler d1 insights（24h）行读大户与根因：
--   ① 156 万行/天：alert_history count(app_id, metric, created_at) × 902 次（/api/diagnostics 轮询）
--      —— 表仅 2911 行且 metric='ingestion' 实际 0 行，但无索引每次近全表扫 1733 行
--   ②  19 万行/天：alertList 的 order by created_at（无 where）—— 排序无索引全表扫
--   ③ 32 万行/天：releaseQuality 的 releases × events join —— events 无 (app_id, release_name, ts) 复合索引
-- D1 计费口径：rows_read = 扫描行数（count/group by/窗口函数读遍符合条件的行），与返回结果大小无关。

-- ① 同时服务 diagnostics(app_id+metric+created_at) 与 dbIngestionHealth(metric+created_at)：
--    metric 等值在前，两查询均走索引（metric='ingestion' 选择性极高）。
create index if not exists idx_alert_history_metric_app_time on alert_history(metric, app_id, created_at);

-- ② alertList / 告警相关按时间倒序的分页排序。
create index if not exists idx_alert_history_time on alert_history(created_at);

-- ③ 版本质量（/api/releases/quality）按应用 × 版本聚合 events。
create index if not exists idx_events_app_release_ts on events(app_id, release_name, ts);
