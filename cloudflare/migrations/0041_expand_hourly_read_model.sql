-- D1 行读优化第三批：把控制台高频统计继续下沉到小时级读模型。
--
-- 事故背景（2026-09-14）：控制台一次 7 天窗口加载会并发请求事件分页与 summary，
-- 精确 COUNT / 浏览器 GROUP BY / LCP Apdex 每项都要扫描数万条 events；多个边缘隔离实例
-- 同时冷启动时，模块内缓存无法合并请求，单次页面加载可放大到 160 万+ rows_read。

alter table events_hourly_stats add column apdex_satisfied integer not null default 0;
alter table events_hourly_stats add column apdex_tolerating integer not null default 0;

-- 浏览器维度独立成小表，避免把 browser 加入 events_hourly_stats 主键后扩大所有聚合行。
create table if not exists events_hourly_browser_stats (
  app_id  text    not null default '',
  hour_ts integer not null,
  browser text    not null default 'Unknown',
  cnt     integer not null default 0,
  primary key (app_id, hour_ts, browser)
);

create index if not exists idx_hourly_browser_ts
  on events_hourly_browser_stats(hour_ts, browser);
