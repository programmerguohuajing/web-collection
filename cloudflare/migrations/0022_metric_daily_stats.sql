-- Phase 6 · B1：智能基线异常检测 · 基线指标日聚合表（Cloudflare D1）
-- 供 baseline-deviation 检测器计算"自身历史滚动基线"（权威源）。
-- 由 governance 定时任务 EOD 预聚合写入（P1 writer；P0 未建 writer 时检测器自动降级 events 近 30 天滚动窗口）。
-- 与 cloudflare/migrations/0019_ai_findings.sql 同属 AI 洞察流；ai_findings 已由 0019 建好，本迁移仅新增 metric_daily_stats。

create table if not exists metric_daily_stats (
  app_id  text    not null,
  metric  text    not null,   -- 'errorRate' | 'perfAvg' | 'volume' | (P2 自定义)
  day     integer not null,   -- yyyyMMdd
  value   real    not null,   -- 当日标量：errorRate=比率; perfAvg=均值(ms); volume=计数
  samples integer default 0,  -- 当日参与聚合的事件数（置信度/样本门槛用）
  primary key (app_id, metric, day)
);
create index if not exists idx_metric_daily_app_metric_day on metric_daily_stats(app_id, metric, day);
create index if not exists idx_metric_daily_app_day on metric_daily_stats(app_id, day);
