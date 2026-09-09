-- D1 · 数据主体权利 DSR（PRD 13）：工单表 + append-only 审计日志表（双栈同构，对齐 apps/api/src/db.js ensureSchema）
-- team_id varchar(32)：对齐 D2 既有表现实（teams.id / team_members.team_id 均为 32）；app_id varchar(64) 对齐 applications（勿用 32）。
create table if not exists dsr_requests (
  id                      varchar(32) primary key,          -- 'dsr_' + randomToken(12)
  team_id                 varchar(32),                      -- 归属团队（accounts 会话取 auth.teamId；null = 未归属）
  app_id                  varchar(64) not null default '',  -- 目标应用；空串 = 团队全应用
  subject_type            varchar(16) not null,             -- user_id/user_name/user_phone/device_id/session_id
  subject_value           varchar(256) not null,            -- 主体标识原文（仅 dsr:view 可达；执行完成后服务端清空为 '[DSR-CLEARED]'）
  request_type            varchar(16) not null,             -- access（查询/导出）/ erasure（擦除）
  mode                    varchar(16),                      -- erasure 专用：anonymize(默认)/hard_delete
  export_format           varchar(8),                       -- access 专用：csv(默认)/json
  status                  varchar(24) not null default 'draft',
  hit_events              integer not null default 0,       -- 发起时命中量快照
  hit_issues              integer not null default 0,
  hit_replays             integer not null default 0,
  requested_by            varchar(64) not null,             -- 发起人（服务端强制审批人 ≠ 发起人）
  approved_by             varchar(64),
  executed_by             varchar(64),
  reject_reason           varchar(512),
  rows_affected_events    integer not null default 0,       -- 执行后回写影响行数
  rows_affected_issues    integer not null default 0,
  rows_affected_replays   integer not null default 0,
  result_json             text,                             -- 执行结果标注（如 CSV 截断提示「已截断，全量走 JSON 分页导出」）
  created_at              bigint not null,
  decided_at              bigint,
  executed_at             bigint,
  completed_at            bigint
);
create index if not exists idx_dsr_req_team_status on dsr_requests(team_id, status, created_at);
create index if not exists idx_dsr_req_subject     on dsr_requests(team_id, subject_type, subject_value);

-- append-only 审计日志（不随工单清理，保留 ≥3 年合规举证期；每次状态迁移写一条）
create table if not exists dsr_audit_logs (
  id           varchar(32) primary key,
  request_id   varchar(32) not null,
  actor_id     varchar(64) not null,
  action       varchar(24) not null,   -- create/submit/approve/reject/cancel/execute_export/execute_erasure/complete/illegal_transition
  detail_json  text,
  ts           bigint not null
);
create index if not exists idx_dsr_audit_request on dsr_audit_logs(request_id, ts);
