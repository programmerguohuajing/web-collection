-- ② 性能兜底：events 小时级预聚合表（summary 缝合源，D1 行读优化第二批）
-- 背景：D1 免费版 rows_read 按扫描行数计费；summary 的 byType/behavior/perfStats 三次全窗
-- group by 随 events 增长线性变贵（事故当日约 100 万行/天）。小时表把同窗聚合代价降为
-- 约 1/50（每 app-小时仅 ~几十行组合，而非数千事件行）。
-- 写入方：cloudflare/worker.js hourlyRollupW（0 * * * * cron：上一小时+当前小时；首部署回
-- 填 14d；每日 17:3 cron 自愈 48h）。读取方：summary 的 hourlyStitchPlan（仅 appId+时间、
-- 窗口 ≤7d、全覆盖时缝合；否则回退直扫 events，口径不变）。
-- 保留期：与 events 同口径（eventsDays，默认 30d），避免缝合结果与直扫（保留期后）不一致。
create table if not exists events_hourly_stats (
  app_id   text    not null default '',
  hour_ts  integer not null,            -- 小时桶起点（UTC epoch ms，floor(ts/3600000)*3600000）
  type     text    not null default '', -- 事件类型（byType 计数维度）
  metric   text    not null default '', -- perf 指标名（perfStats 计数/均值维度；非 perf 为 ''）
  name     text    not null default '', -- behavior/track 事件名（behavior 计数维度；其余为 ''）
  cnt      integer not null default 0,  -- 该组合原始事件数（byType/behavior/total 口径）
  perf_cnt integer not null default 0,  -- 过 perf 守卫的事件数（perfStats count 口径，与在线查询同守卫）
  value_sum real   not null default 0,  -- 过守卫的 value 总和（perfStats avg = value_sum/perf_cnt）
  primary key (app_id, hour_ts, type, metric, name)
);
-- 全局（无 appId 筛选）缝合查询走 hour 前导索引；behavior/perf 查询带 type 过滤
create index if not exists idx_hourly_ts on events_hourly_stats(hour_ts, type);
