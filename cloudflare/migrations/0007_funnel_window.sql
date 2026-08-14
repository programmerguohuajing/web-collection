-- 漏斗转化时间窗：限定相邻转化步骤之间的最大时间间隔（毫秒）。
-- NULL / 0 表示不限，保持严格有序语义。旧漏斗数据无此列，升级后默认不限，行为不变。
alter table funnel_definitions add column window_ms integer;
