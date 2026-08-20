-- P0-6 性能预算：为重查询接口补 name 维度复合索引
-- paths / click-paths / funnel event-names 等查询按 type + name 过滤，
-- 之前只能走 (type, ts) 扫全部同类型事件（含大量 click），命中本索引后可直接定位目标事件。
CREATE INDEX IF NOT EXISTS idx_events_type_name_ts ON events(type, name, ts DESC);
