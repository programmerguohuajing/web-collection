-- PRD 集合：洞察/治理层（01 用户链路无表；02 字典 / 04 远程配置 / 05 漏斗增强列 / 07 成员审计）
-- 方言注意：D1 无 jsonb，统一 TEXT(JSON)；无 bigserial，用 INTEGER 自增。

-- PRD 02 事件字典：人工登记含义
create table if not exists event_dictionary (
  name varchar(160) primary key,
  description text,
  owner varchar(64),
  tags_json text,
  registered_at bigint,
  updated_at bigint
);

-- PRD 05 漏斗增强（复用既有 funnel_definitions）
alter table funnel_definitions add column created_by varchar(64);
alter table funnel_definitions add column dimension varchar(32);

-- PRD 04 远程配置：append-only 配置行 + 审计（config_version 取 audit max(id)）
create table if not exists collect_configs (
  id integer primary key autoincrement,
  scope_json text not null,
  config_json text not null,
  config_version integer not null,
  created_by varchar(64) not null,
  created_at bigint not null
);
create index if not exists idx_collect_configs_scope on collect_configs(created_at desc);

create table if not exists collect_config_audit (
  id integer primary key autoincrement,
  action varchar(16) not null,
  scope_json text,
  config_snapshot text not null,
  diff_json text,
  operator varchar(64) not null,
  created_at bigint not null
);

-- PRD 07 数据访问等级：成员与敏感操作审计
create table if not exists members (
  id varchar(32) primary key,
  name varchar(64) not null,
  role varchar(64),
  access_level varchar(2) not null default 'L2',
  last_active_at bigint,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists data_access_audit (
  id integer primary key autoincrement,
  member_id varchar(32),
  action varchar(32) not null,
  target varchar(128),
  detail_json text,
  created_at bigint not null
);
create index if not exists idx_data_access_audit_time on data_access_audit(created_at desc);
