-- Add indexes to speed up event queries by time range, app, and type
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_app_ts ON events(app_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_issues_app_status ON issues(app_id, status, last_seen DESC);
