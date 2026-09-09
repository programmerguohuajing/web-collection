-- D2 · 账号/团队/RBAC 地基（自动迁移）。
-- D1 限制：无 jsonb → TEXT(JSON)；无 boolean → integer(0/1)；无 bigserial → INTEGER PRIMARY KEY AUTOINCREMENT；
-- ALTER 裸语句无 IF NOT EXISTS（迁移经 d1_migrations 追踪，仅执行一次）。
-- applications 大表索引拆分至 migrations-manual/0026（超时红线：自动迁移一批任一超时整批回滚）。
-- 写侧（worker.js auth/team 函数）与本迁移同一次部署提交。

create table if not exists users (
  id            varchar(32) primary key,
  email         varchar(160) not null unique,   -- 归一小写入库
  name          varchar(64)  not null,
  password_hash varchar(255) not null,          -- scrypt$N$r$p$saltB64$hashB64
  status        varchar(16)  not null default 'active',  -- active | disabled
  created_at    bigint not null,
  updated_at    bigint not null,
  last_login_at bigint
);
create index if not exists idx_users_email on users(email);

create table if not exists teams (
  id         varchar(32) primary key,
  name       varchar(64) not null,
  slug       varchar(64) not null unique,
  created_by varchar(32),
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists team_members (
  team_id      varchar(32) not null,
  user_id      varchar(32) not null,
  role         varchar(16) not null default 'member',   -- owner|admin|member|viewer
  access_level varchar(2)  not null default 'L2',       -- 07 同源 L1~L4
  status       varchar(16) not null default 'active',   -- active | invited | disabled
  joined_at    bigint,
  created_at   bigint not null,
  updated_at   bigint not null,
  primary key (team_id, user_id)
);
create index if not exists idx_team_members_user on team_members(user_id);

create table if not exists invitations (
  id           varchar(32) primary key,
  team_id      varchar(32) not null,
  email        varchar(160) not null,
  role         varchar(16) not null default 'member',
  access_level varchar(2)  not null default 'L2',
  token_hash   varchar(64) not null,          -- 只存哈希
  expires_at   bigint not null,               -- 默认 7d
  invited_by   varchar(32),
  accepted_at  bigint,
  revoked_at   bigint,
  created_at   bigint not null
);
create index if not exists idx_invitations_team on invitations(team_id, created_at desc);

create table if not exists sessions (
  id         varchar(32) primary key,
  user_id    varchar(32) not null,
  token_hash varchar(64) not null,
  expires_at bigint not null,
  revoked_at bigint,
  ip         varchar(64),                     -- 敏感，展示侧受 07 分级约束
  user_agent varchar(255),
  created_at bigint not null
);
create index if not exists idx_sessions_user on sessions(user_id, created_at desc);

-- 通用审计（超集 07 data_access_audit；action 见 worker.js writeTeamAudit 注释）
create table if not exists audit_logs (
  id            integer primary key autoincrement,
  team_id       varchar(32),
  actor_user_id varchar(32),
  actor_email   varchar(160),                  -- 快照，用户删除后仍可追溯
  action        varchar(32) not null,          -- login|member_invite|member_remove|role_change|level_change|app_move|team_update|view_full_ip
  target_type   varchar(32),
  target_id     varchar(64),
  detail_json   text,
  ip            varchar(64),
  user_agent    varchar(255),
  created_at    bigint not null
);
create index if not exists idx_audit_logs_team_time on audit_logs(team_id, created_at desc);

-- 应用归属团队（存量大表 ALTER 瞬时；索引见 0026 手动迁移）
alter table applications add column team_id varchar(32);
