/**
 * @file 数据库连接与 Schema 管理
 * 基于 PostgreSQL（pg Pool）实现，提供表结构初始化和通用查询封装。
 * 支持 `?` 占位符语法，内部自动转换为 PostgreSQL 的 `$n` 参数化语法。
 */

import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 加载项目根目录 .env（此文件在 src/ 下，往上三级到根）
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') })

import { Pool } from 'pg'

const dbName = process.env.DB_NAME || process.env.PGDATABASE || 'web_collection'

/** PostgreSQL 连接池实例 */
export const pool = createDbClient()

/**
 * 确保数据库表结构已创建（幂等操作）。
 * 创建以下 4 张表：
 * - events：原始事件存储
 * - issues：错误聚合（按指纹分组）
 * - replay_events：会话回放事件详情
 * - sourcemaps：SourceMap 文件存储
 */
export async function ensureSchema() {
  // ==================== events 表 ====================
  await run(`create table if not exists events (
    id uuid primary key,
    ts bigint not null,
    type varchar(32) not null,
    app_id varchar(64) not null,
    release_name varchar(64) not null,
    user_id varchar(128),
    user_name varchar(128),
    user_phone varchar(32),
    session_id varchar(128),
    device_id varchar(128),
    url text,
    path text,
    title text,
    referrer text,
    user_agent text,
    browser varchar(32),
    os varchar(32),
    device varchar(16),
    name varchar(160),
    metric varchar(32),
    value double precision,
    message text,
    stack text,
    props_json jsonb,
    breadcrumbs_json jsonb
  )`)

  await run(`alter table events add column if not exists user_name varchar(128)`)
  await run(`alter table events add column if not exists user_phone varchar(32)`)
  await run(`alter table events add column if not exists trace_id varchar(64)`)
  await run(`alter table events add column if not exists span_id varchar(32)`)

  // events 表注释
  await run(`comment on table events is '原始事件存储表，记录 SDK 上报的所有事件（页面访问、点击、错误、性能指标等）'`)
  await run(`comment on column events.id is '事件唯一标识（UUID）'`)
  await run(`comment on column events.ts is '事件时间戳（毫秒级 Unix 时间）'`)
  await run(`comment on column events.type is '事件类型，如 pv（页面访问）、click（点击）、error（错误）、perf（性能）等'`)
  await run(`comment on column events.app_id is '应用 ID，用于区分不同项目'`)
  await run(`comment on column events.release_name is '发版名称/版本标识，用于关联 SourceMap'`)
  await run(`comment on column events.user_id is '用户 ID，标识当前操作用户'`)
  await run(`comment on column events.user_name is '用户名，用于后台查询'`)
  await run(`comment on column events.user_phone is '手机号，用于后台查询，展示层默认脱敏'`)
  await run(`comment on column events.session_id is '会话 ID，标识一次完整的用户会话'`)
  await run(`comment on column events.device_id is '设备 ID，标识用户设备'`)
  await run(`comment on column events.url is '页面完整 URL'`)
  await run(`comment on column events.path is '页面路径（不含域名）'`)
  await run(`comment on column events.title is '页面标题'`)
  await run(`comment on column events.referrer is '来源页面 URL（document.referrer）'`)
  await run(`comment on column events.user_agent is '用户代理字符串（navigator.userAgent）'`)
  await run(`comment on column events.browser is '浏览器名称，如 Chrome、Firefox、Safari 等'`)
  await run(`comment on column events.os is '操作系统，如 Windows、macOS、Android、iOS 等'`)
  await run(`comment on column events.device is '设备类型，如 desktop、mobile、tablet'`)
  await run(`comment on column events.name is '事件名称，如 click 事件的具体元素标识'`)
  await run(`comment on column events.metric is '性能指标名称，如 LCP、FID、CLS、TTFB 等'`)
  await run(`comment on column events.value is '性能指标数值'`)
  await run(`comment on column events.message is '错误消息内容'`)
  await run(`comment on column events.stack is '错误堆栈信息'`)
  await run(`comment on column events.props_json is '自定义属性数据（JSONB 格式）'`)
  await run(`comment on column events.breadcrumbs_json is '用户行为轨迹/面包屑数据（JSONB 格式）'`)

  // ==================== issues 表 ====================
  await run(`create table if not exists issues (
    fingerprint varchar(64) primary key,
    status varchar(32) not null,
    app_id varchar(64) not null,
    release varchar(64) not null,
    name varchar(160),
    message text,
    stack text,
    url text,
    props_json jsonb,
    breadcrumbs_json jsonb,
    original_json jsonb,
    users_json jsonb,
    affected_users integer not null default 0,
    count integer not null default 0,
    first_seen bigint not null,
    last_seen bigint not null,
    resolved_at bigint
  )`)

  // issues 表注释
  await run(`comment on table issues is '错误聚合表，按指纹分组合并相同错误，统计发生次数与受影响用户'`)
  await run(`comment on column issues.fingerprint is '错误指纹（主键），由错误名称+堆栈哈希生成，用于去重聚合'`)
  await run(`comment on column issues.status is '状态：unresolved（未解决）/ resolved（已解决）'`)
  await run(`comment on column issues.app_id is '应用 ID，用于区分不同项目'`)
  await run(`comment on column issues.release is '发版名称/版本标识'`)
  await run(`comment on column issues.name is '错误名称（Error 类型或自定义名称）'`)
  await run(`comment on column issues.message is '错误消息内容'`)
  await run(`comment on column issues.stack is '错误堆栈信息'`)
  await run(`comment on column issues.url is '错误发生时的页面 URL'`)
  await run(`comment on column issues.props_json is '自定义属性数据（JSONB 格式）'`)
  await run(`comment on column issues.breadcrumbs_json is '用户行为轨迹/面包屑数据（JSONB 格式）'`)
  await run(`comment on column issues.original_json is '最近一次错误事件的原始完整数据（JSONB 格式）'`)
  await run(`comment on column issues.users_json is '受影响用户列表及详情（JSONB 格式）'`)
  await run(`comment on column issues.affected_users is '受影响用户总数'`)
  await run(`comment on column issues.count is '错误累计发生次数'`)
  await run(`comment on column issues.first_seen is '首次发现时间戳（毫秒级 Unix 时间）'`)
  await run(`comment on column issues.last_seen is '最近发现时间戳（毫秒级 Unix 时间）'`)
  await run(`comment on column issues.resolved_at is '错误被解决的时间戳（毫秒级 Unix 时间），未解决时为 NULL'`)

  // ==================== replay_events 表 ====================
  await run(`create table if not exists replay_events (
    id bigserial primary key,
    app_id varchar(64) not null default 'default',
    session_id varchar(128) not null,
    segment_id integer not null default 1,
    user_id varchar(128),
    user_name varchar(128),
    user_phone varchar(32),
    created_at bigint not null,
    url text,
    release varchar(64),
    end_reason varchar(32),
    events_json jsonb not null
  )`)

  // 为已有的 replay_events 表补充 segment_id 列（兼容旧数据）
  await run(`alter table replay_events add column if not exists app_id varchar(64) not null default 'default'`)
  await run(`alter table replay_events add column if not exists segment_id integer not null default 1`)
  await run(`alter table replay_events add column if not exists user_id varchar(128)`)
  await run(`alter table replay_events add column if not exists user_name varchar(128)`)
  await run(`alter table replay_events add column if not exists user_phone varchar(32)`)

  // 为已有的 replay_events 表补充 end_reason 列（兼容旧数据）
  await run(`alter table replay_events add column if not exists end_reason varchar(32)`)

  // replay_events 表注释
  await run(`comment on table replay_events is '会话回放事件表，存储 rrweb 录制的 DOM 操作事件，按会话和分段组织'`)
  await run(`comment on column replay_events.id is '自增主键'`)
  await run(`comment on column replay_events.session_id is '会话 ID，标识一次用户会话，同一会话可包含多个分段'`)
  await run(`comment on column replay_events.segment_id is '分段序号，同一会话内因报错或路由切换产生新分段时递增'`)
  await run(`comment on column replay_events.created_at is '分段创建时间戳（毫秒级 Unix 时间）'`)
  await run(`comment on column replay_events.url is '录制开始时的页面 URL'`)
  await run(`comment on column replay_events.release is '发版名称/版本标识'`)
  await run(`comment on column replay_events.end_reason is '录制结束原因：error（报错截断）、route（路由切换截断）、normal（正常结束）'`)
  await run(`comment on column replay_events.events_json is 'rrweb 录制的事件数据（JSONB 格式），包含完整的 DOM 快照和增量操作'`)

  // ==================== sourcemaps 表 ====================
  await run(`create table if not exists sourcemaps (
    app_id varchar(64) not null default 'default',
    release_name varchar(64) not null,
    file_name varchar(255) not null,
    map_json jsonb not null,
    created_at bigint not null,
    primary key (app_id, release_name, file_name)
  )`)
  await run(`alter table sourcemaps add column if not exists app_id varchar(64) not null default 'default'`)
  await run(`do $$ begin
    if not exists (
      select 1 from pg_constraint where conrelid = 'sourcemaps'::regclass
      and contype = 'p' and pg_get_constraintdef(oid) like '%app_id%'
    ) then
      alter table sourcemaps drop constraint if exists sourcemaps_pkey;
      alter table sourcemaps add primary key (app_id, release_name, file_name);
    end if;
  end $$`)

  // sourcemaps 表注释
  await run(`comment on table sourcemaps is 'SourceMap 文件存储表，保存各版本的 SourceMap 用于错误堆栈还原'`)
  await run(`comment on column sourcemaps.release_name is '发版名称/版本标识，与 events.release_name 对应'`)
  await run(`comment on column sourcemaps.file_name is 'SourceMap 对应的源文件名'`)
  await run(`comment on column sourcemaps.map_json is 'SourceMap 完整内容（JSONB 格式）'`)
  await run(`comment on column sourcemaps.created_at is 'SourceMap 上传时间戳（毫秒级 Unix 时间）'`)

  // ==================== 采集治理 ====================
  await run(`create table if not exists applications (
    app_id varchar(64) primary key,
    name varchar(128) not null,
    platform varchar(32) not null default 'web',
    owner varchar(128),
    enabled boolean not null default true,
    sample_rate double precision not null default 1,
    replay_sample_rate double precision not null default 1,
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`alter table applications add column if not exists collect_key_hash varchar(64)`)
  await run(`alter table applications add column if not exists rules_json jsonb`)
  await run(`create table if not exists releases (
    app_id varchar(64) not null references applications(app_id) on delete cascade,
    release_name varchar(64) not null,
    status varchar(32) not null default 'active',
    created_at bigint not null,
    primary key (app_id, release_name)
  )`)
  await run(`create table if not exists platform_settings (
    id integer primary key,
    config_json jsonb not null,
    updated_at bigint not null
  )`)
  await run(`create table if not exists alert_history (
    id bigserial primary key,
    app_id varchar(64) not null,
    metric varchar(32) not null,
    fingerprint varchar(128),
    level varchar(16) not null,
    value double precision,
    message text not null,
    notified boolean not null default false,
    notify_error text,
    created_at bigint not null
  )`)
  await run(`alter table alert_history add column if not exists context_json jsonb`)
  await run(`create table if not exists alert_channels (
    id bigserial primary key,
    name varchar(128) not null,
    type varchar(32) not null,
    enabled boolean not null default true,
    config_json jsonb not null default '{}'::jsonb,
    secret_ciphertext text,
    app_ids_json jsonb not null default '[]'::jsonb,
    levels_json jsonb not null default '[]'::jsonb,
    metrics_json jsonb not null default '[]'::jsonb,
    last_test_status varchar(16),
    last_test_error text,
    last_test_at bigint,
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`create table if not exists alert_deliveries (
    id bigserial primary key,
    alert_id bigint not null references alert_history(id) on delete cascade,
    channel_id bigint references alert_channels(id) on delete set null,
    channel_name varchar(128) not null,
    channel_type varchar(32) not null,
    status varchar(16) not null default 'pending',
    attempts integer not null default 0,
    queue_message_id varchar(256),
    provider_message_id varchar(256),
    last_error text,
    sent_at bigint,
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`create table if not exists funnel_definitions (
    id bigserial primary key,
    name varchar(128) not null,
    app_id varchar(64),
    steps_json jsonb not null,
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`create table if not exists dashboard_definitions (
    id bigserial primary key,
    name varchar(128) not null,
    widgets_json jsonb not null,
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`create index if not exists idx_events_ts on events(ts)`)
  await run(`create index if not exists idx_events_trace on events(trace_id, ts)`)
  await run(`create index if not exists idx_events_session on events(session_id, ts)`)
  await run(`create index if not exists idx_replay_events_created_at on replay_events(created_at)`)
  await run(`create index if not exists idx_replay_events_app_created_at on replay_events(app_id, created_at)`)
  await run(`create index if not exists idx_alert_history_created_at on alert_history(created_at)`)
  await run(`create index if not exists idx_alert_deliveries_alert on alert_deliveries(alert_id, created_at)`)
  await run(`create index if not exists idx_alert_deliveries_pending on alert_deliveries(status, updated_at)`)
}

/**
 * 执行写操作（INSERT / UPDATE / DELETE），不返回数据。
 * @param {string} sql - SQL 语句（使用 ? 占位符）
 * @param {Array} [params=[]] - 参数列表
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function run(sql, params = []) {
  return pool.query(toPgSql(sql), params)
}

/**
 * 执行查询操作，返回所有匹配行。
 * @param {string} sql - SQL 语句（使用 ? 占位符）
 * @param {Array} [params=[]] - 参数列表
 * @returns {Promise<Array>}
 */
export async function all(sql, params = []) {
  const { rows } = await pool.query(toPgSql(sql), params)
  return rows
}

/**
 * 执行聚合查询，返回单个数值（从 count 或 total 列中提取）。
 * @param {string} sql - SQL 语句（使用 ? 占位符）
 * @param {Array} [params=[]] - 参数列表
 * @returns {Promise<number>}
 */
export async function scalar(sql, params = []) {
  const rows = await all(sql, params)
  const row = rows[0] || {}
  return Number(row.count ?? row.total ?? 0)
}

/** 创建 PostgreSQL 连接池，支持 DATABASE_URL / PG_URL 或分项环境变量配置 */
function createDbClient() {
  return new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      process.env.PG_URL ||
      `postgresql://${encodeURIComponent(process.env.PGUSER || 'postgres')}:${encodeURIComponent(process.env.PGPASSWORD || '')}@${process.env.PGHOST || '127.0.0.1'}:${Number(process.env.PGPORT || 5432)}/${dbName}`,
    max: Number(process.env.PG_POOL_SIZE || 10)
  })
}

/**
 * 将 SQL 语句中的 `?` 占位符转换为 PostgreSQL 的 `$n` 参数化语法。
 * @param {string} sql - 原始 SQL（使用 ? 占位符）
 * @returns {string} 转换后的 PostgreSQL SQL
 */
function toPgSql(sql) {
  let index = 0
  return sql.replace(/\?/g, () => `$${++index}`)
}
