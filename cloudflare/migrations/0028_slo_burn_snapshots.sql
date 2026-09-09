-- B2 · SLO 错误预算燃烧快照表（自动迁移）。
-- 定时 tick 写入的全窗口滚动快照，供趋势 / 仪表盘 / 告警判定解耦读取（推荐 Q2）。
create table if not exists slo_burn_snapshots (
  id           varchar(32) primary key,
  slo_id       varchar(32) not null,
  snap_at      bigint not null,           -- 快照时刻
  window_start bigint not null,
  window_end   bigint not null,
  total        bigint not null,           -- 分母事件数
  bad          bigint not null,           -- 坏事件数
  good_ratio   real not null,             -- 窗口内实际达标率 = 1 - bad/total
  budget_used  real not null,             -- 已消耗预算比例(0~1+)，= 全窗口燃烧率
  burn_rate    real not null,             -- 全窗口燃烧率 = (bad/total)/(1-objective)
  status       varchar(12) not null       -- healthy | warning | burnt
);
