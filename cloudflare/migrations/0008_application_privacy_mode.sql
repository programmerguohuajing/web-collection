-- 应用隐私模式（存储意图）：balanced（默认，SDK 采集层脱敏后入库）/ raw（全量采集，下游查询层脱敏）。
-- 与 ADR-007 对齐：下游 mask-at-query 已先行落地，因此可按应用开启 raw 全量采集而不暴露裸 PII。
-- SQLite/D1 支持为已有表增加 NOT NULL 且带默认值的列，存量行自动套用默认值 'balanced'。
alter table applications add column privacy_mode text not null default 'balanced';
