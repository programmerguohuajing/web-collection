-- 线上库已在 2026-07-29 完成 alerts -> alert_history 重命名。
-- 新环境从 0001 起直接使用统一表名，因此这里只补充索引。
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alert_history(status, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_trace ON alert_history(trace_id);
