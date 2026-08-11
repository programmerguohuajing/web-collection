-- 与 Node/PostgreSQL 部署统一漏斗定义表名，并保留已有 D1 数据。
ALTER TABLE funnels RENAME TO funnel_definitions;
