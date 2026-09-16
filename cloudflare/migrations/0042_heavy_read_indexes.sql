CREATE INDEX IF NOT EXISTS idx_events_app_type_name_ts
  ON events(app_id, type, name, ts DESC);

CREATE INDEX IF NOT EXISTS idx_events_app_type_metric_ts
  ON events(app_id, type, metric, ts DESC);

CREATE INDEX IF NOT EXISTS idx_events_app_release_type_metric_ts
  ON events(app_id, release_name, type, metric, ts DESC);
