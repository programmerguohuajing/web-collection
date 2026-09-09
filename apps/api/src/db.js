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
    sdk_version varchar(32),
    environment varchar(64),
    source varchar(32),
    context_json jsonb,
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
  await run(`alter table events add column if not exists parent_span_id varchar(32)`)
  await run(`alter table events add column if not exists sdk_version varchar(32)`)
  await run(`alter table events add column if not exists environment varchar(64)`)
  await run(`alter table events add column if not exists source varchar(32)`)
  await run(`alter table events add column if not exists context_json jsonb`)
  // Phase 0 · P0-5：事件信封字段扩展（向后兼容，旧事件新列为空不报错）
  await run(`alter table events add column if not exists app_version varchar(64)`)
  await run(`alter table events add column if not exists product_id varchar(64)`)
  await run(`alter table events add column if not exists event_id varchar(64)`)
  await run(`alter table events add column if not exists request_id varchar(64)`)
  await run(`alter table events add column if not exists occurred_at bigint`)
  await run(`alter table events add column if not exists received_at bigint`)
  await run(`alter table events add column if not exists schema_version varchar(16)`)
  await run(`alter table events add column if not exists batch_id varchar(64)`)
  await run(`alter table events add column if not exists retry_count integer not null default 0`)
  await run(`alter table events add column if not exists contract_status varchar(16)`)
  await run(`alter table events add column if not exists contract_errors_json jsonb`)

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
  // 为已有的 replay_events 表补充 base_session_id 列（漏斗「流失会话 → 回放」精确关联；历史数据为 NULL）
  await run(`alter table replay_events add column if not exists base_session_id varchar(128)`)

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

  // ==================== spans 表（分布式链路追踪） ====================
  await run(`create table if not exists spans (
    id              varchar(64) primary key,
    trace_id        varchar(64) not null,
    span_id         varchar(32) not null,
    parent_span_id  varchar(32),
    service_name    varchar(128),
    operation_name  varchar(256),
    kind            varchar(16),
    start_ts        bigint not null,
    duration        double precision,
    status_code     varchar(16),
    status_message  text,
    attributes_json jsonb,
    ts              bigint not null
  )`)
  // spans 表索引
  await run(`create index if not exists idx_spans_trace on spans(trace_id, start_ts)`)
  await run(`create index if not exists idx_spans_parent on spans(trace_id, parent_span_id)`)
  // spans 表注释
  await run(`comment on table spans is '分布式链路追踪 span 表，存储后端服务上报的 span 数据'`)
  await run(`comment on column spans.id is 'Span 唯一标识（由服务端生成或客户端指定）'`)
  await run(`comment on column spans.trace_id is '链路 ID，串联前端和后端所有 span'`)
  await run(`comment on column spans.span_id is 'Span 唯一标识（16 位十六进制）'`)
  await run(`comment on column spans.parent_span_id is '父 Span ID，为空表示根 span'`)
  await run(`comment on column spans.service_name is '服务名称，如 gateway、svc-order 等'`)
  await run(`comment on column spans.operation_name is '操作名称，如 GET /api/order'`)
  await run(`comment on column spans.kind is 'Span 类型：SERVER/CLIENT/PRODUCER/CONSUMER/INTERNAL'`)
  await run(`comment on column spans.start_ts is 'Span 开始时间戳（毫秒级 Unix 时间）'`)
  await run(`comment on column spans.duration is 'Span 持续时间（毫秒）'`)
  await run(`comment on column spans.status_code is 'Span 状态：OK/ERROR/UNSET'`)
  await run(`comment on column spans.status_message is '状态消息（如错误描述）'`)
  await run(`comment on column spans.attributes_json is 'Span 属性（JSONB 格式），如 http.method、http.status_code'`)
  await run(`comment on column spans.ts is '入库时间戳'`)

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
  await run(`alter table applications add column if not exists privacy_mode varchar(16) not null default 'balanced'`)
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
    status varchar(16) not null default 'pending',
    value double precision,
    message text not null,
    notified boolean not null default false,
    notify_error text,
    context_json jsonb,
    created_at bigint not null,
    updated_at bigint not null default 0
  )`)
  await run(`alter table alert_history add column if not exists status varchar(16) not null default 'pending'`)
  await run(`alter table alert_history add column if not exists context_json jsonb`)
  await run(`alter table alert_history add column if not exists updated_at bigint not null default 0`)
  await run(`update alert_history set updated_at=created_at where updated_at=0`)
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
  // 早期 PostgreSQL 部署曾存在 funnels 表。启动时幂等迁移到统一表名，
  // 保留旧表以便灰度期间回滚；确认所有实例升级后可另行清理。
  await run(`do $migration$
  begin
    if to_regclass('public.funnels') is not null then
      execute 'insert into public.funnel_definitions (id,name,app_id,steps_json,created_at,updated_at)
        select id,name,app_id,steps_json::jsonb,created_at,updated_at from public.funnels
        on conflict (id) do nothing';
    end if;
  end
  $migration$`)
  await run(`select setval(
    pg_get_serial_sequence('funnel_definitions', 'id'),
    coalesce((select max(id) from funnel_definitions), 1),
    exists(select 1 from funnel_definitions)
  )`)
  await run(`alter table funnel_definitions add column if not exists window_ms bigint`)
  await run(`create table if not exists dashboard_definitions (
    id bigserial primary key,
    name varchar(128) not null,
    widgets_json jsonb not null,
    created_at bigint not null,
    updated_at bigint not null
  )`)
  // A2 · 自定义看板分享：Postgres 支持 IF NOT EXISTS，瞬时安全；唯一索引对 NULL 放行（未分享行 token=NULL 允许多行）。
  await run(`alter table dashboard_definitions add column if not exists shared boolean not null default false`)
  await run(`alter table dashboard_definitions add column if not exists share_token text`)
  await run(`create unique index if not exists idx_dashboard_definitions_share_token on dashboard_definitions(share_token)`)
  await run(`create table if not exists analytics_insights (
    id bigserial primary key,
    name varchar(128) not null,
    kind varchar(32) not null,
    definition_json jsonb not null,
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`create index if not exists idx_events_ts on events(ts)`)
  await run(`create index if not exists idx_events_trace on events(trace_id, ts)`)
  await run(`create index if not exists idx_events_session on events(session_id, ts)`)
  await run(`create index if not exists idx_events_app_release_ts on events(app_id, release_name, ts desc)`)
  await run(`create index if not exists idx_events_type_ts on events(type, ts desc)`)
  await run(`create index if not exists idx_events_analytics on events(app_id, name, ts)`)
  await run(`create index if not exists idx_events_event_id on events(event_id)`)
  await run(`create index if not exists idx_events_request_id on events(request_id)`)
  await run(`create index if not exists idx_events_app_version_ts on events(app_id, app_version, ts desc)`)
  await run(`create index if not exists idx_events_props_gin on events using gin(props_json jsonb_path_ops)`)
  await run(`create index if not exists idx_replay_events_created_at on replay_events(created_at)`)
  await run(`create index if not exists idx_replay_events_app_created_at on replay_events(app_id, created_at)`)
  await run(`create index if not exists idx_replay_events_session_created_at on replay_events(session_id, created_at desc)`)
  await run(`create index if not exists idx_releases_app_created_at on releases(app_id, created_at desc)`)
  await run(`create index if not exists idx_issues_app_last_seen on issues(app_id, last_seen desc)`)
  await run(`create index if not exists idx_alert_history_created_at on alert_history(created_at)`)
  await run(`create index if not exists idx_alert_history_status_metric on alert_history(status, metric, created_at desc)`)
  await run(`create index if not exists idx_alert_deliveries_alert on alert_deliveries(alert_id, created_at)`)
  await run(`create index if not exists idx_alert_deliveries_pending on alert_deliveries(status, updated_at)`)

  // ==================== AI 诊断（M1 知识库底座，双后端对齐） ====================
  // ADR-005：解法字段，闭环 issue 时选填；空值不进 KB
  await run(`alter table issues add column if not exists resolution_notes text`)

  // 诊断记录（用于缓存/评估/反馈关联）
  await run(`create table if not exists ai_diagnoses (
    id varchar(64) primary key,
    ref_type varchar(16) not null,
    ref_id text not null,
    app_id varchar(64),
    request_summary jsonb,
    response_json jsonb,
    model varchar(128),
    confidence double precision,
    degraded integer not null default 0,
    created_at bigint not null
  )`)
  await run(`create index if not exists idx_diag_ref on ai_diagnoses(ref_type, ref_id)`)

  // 用户反馈
  await run(`create table if not exists ai_feedback (
    id varchar(64) primary key,
    diagnosis_id varchar(64),
    rating varchar(8),
    correction text,
    created_at bigint not null
  )`)

  // RAG 原文 + 向量（pgvector 可用时含 embedding 列；不可用则降级为关键词检索的表）
  const vectorExt = await first(`select name from pg_available_extensions where name = 'vector'`)
  const hasVector = Boolean(vectorExt && vectorExt.name)
  await run(`create table if not exists ai_kb_chunks (
    id varchar(128) primary key,
    source_type varchar(16),
    source_id text,
    app_id varchar(64),
    chunk_idx integer,
    text text,
    metadata_json jsonb,
    updated_at bigint
    ${hasVector ? `, embedding vector(1024)` : ''}
  )`)
  await run(`create index if not exists idx_kb_src on ai_kb_chunks(source_type, source_id)`)
  if (hasVector) {
    await run(`create index if not exists idx_kb_embedding on ai_kb_chunks using hnsw (embedding vector_cosine_ops)`)
  }

  // 摄取元数据（增量判定）
  await run(`create table if not exists ai_kb_meta (
    id varchar(128) primary key,
    source_type varchar(16),
    source_id text,
    content_hash text,
    version varchar(64),
    updated_at bigint
  )`)

  // 知识中枢：Article 主表（可编辑 source of truth）
  await run(`create table if not exists ai_kb_articles (
    id varchar(128) primary key,
    slug varchar(160),
    title text not null,
    type varchar(16) not null,
    body text,
    visibility varchar(16) not null default 'internal',
    status varchar(16) not null default 'published',
    tags_json jsonb,
    linked_errors_json jsonb,
    app_scope varchar(64) not null default 'global',
    owner varchar(64),
    source_json jsonb,
    version integer not null default 1,
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`create index if not exists idx_kb_article_type on ai_kb_articles(type)`)
  await run(`create index if not exists idx_kb_article_vis on ai_kb_articles(visibility)`)
  await run(`create index if not exists idx_kb_article_status on ai_kb_articles(status)`)
  await run(`create index if not exists idx_kb_article_app on ai_kb_articles(app_scope)`)

  // 质量指标
  await run(`create table if not exists ai_kb_quality (
    article_id varchar(128) primary key,
    ai_citations integer not null default 0,
    up_count integer not null default 0,
    down_count integer not null default 0,
    useful_rate double precision,
    feedback_count integer not null default 0,
    last_cited_at bigint
  )`)
  await run(`create index if not exists idx_kb_quality_cite on ai_kb_quality(ai_citations)`)

  // 编辑版本历史
  await run(`create table if not exists ai_kb_history (
    id varchar(160) primary key,
    article_id varchar(128) not null,
    version integer not null,
    editor varchar(64),
    note text,
    snapshot_json text,
    created_at bigint not null
  )`)
  await run(`create index if not exists idx_kb_hist_article on ai_kb_history(article_id, version)`)

  // ==================== AI 洞察流（与 Cloudflare D1 ai_findings 双后端对齐，D8） ====================
  // 主动诊断扫描落库（错误簇/发布回归/性能退化/指标骤降/基线偏离），供 /api/ai/scan 与 /api/ai/findings 使用。
  await run(`create table if not exists ai_findings (
    id varchar(64) primary key,
    scope varchar(32) not null,
    object text not null,
    app_id varchar(64),
    summary text,
    evidence_json text,
    detail_json text,
    confidence double precision,
    status varchar(16) not null default 'open',
    created_at bigint not null,
    updated_at bigint
  )`)
  await run(`create index if not exists idx_findings_scope_obj on ai_findings(scope, object)`)
  await run(`create index if not exists idx_findings_app_created on ai_findings(app_id, created_at)`)

  // 基线指标日聚合（baseline-deviation 检测器权威源；governance 定时任务 EOD 写入，P0 未建 writer 时降级 events）
  await run(`create table if not exists metric_daily_stats (
    app_id varchar(64) not null,
    metric varchar(32) not null,
    day integer not null,
    value double precision not null,
    samples integer not null default 0,
    primary key (app_id, metric, day)
  )`)
  await run(`create index if not exists idx_metric_daily_app_metric_day on metric_daily_stats(app_id, metric, day)`)
  await run(`create index if not exists idx_metric_daily_app_day on metric_daily_stats(app_id, day)`)

  // ==================== PRD 集合：洞察/治理层 ====================
  // PRD 02 事件字典：人工登记含义（统计本身走 events 聚合，此处只存登记元数据）
  await run(`create table if not exists event_dictionary (
    name varchar(160) primary key,
    description text,
    owner varchar(64),
    tags_json jsonb,
    registered_at bigint,
    updated_at bigint
  )`)
  // PRD 05 漏斗增强列（复用既有 funnel_definitions，勿新建 funnels 表）
  await run(`alter table funnel_definitions add column if not exists created_by varchar(64)`)
  await run(`alter table funnel_definitions add column if not exists dimension varchar(32)`)
  // PRD 04 远程配置：配置快照 append-only（最新 config_version 即最大 audit id）
  await run(`create table if not exists collect_configs (
    id bigserial primary key,
    scope_json jsonb not null,
    config_json jsonb not null,
    config_version integer not null,
    created_by varchar(64) not null,
    created_at bigint not null
  )`)
  await run(`create index if not exists idx_collect_configs_scope on collect_configs(created_at desc)`)
  await run(`create table if not exists collect_config_audit (
    id bigserial primary key,
    action varchar(16) not null,
    scope_json jsonb,
    config_snapshot jsonb not null,
    diff_json jsonb,
    operator varchar(64) not null,
    created_at bigint not null
  )`)
  // PRD 07 数据访问等级：成员（账号体系立项前的最小实现）与敏感操作审计
  await run(`create table if not exists members (
    id varchar(32) primary key,
    name varchar(64) not null,
    role varchar(64),
    access_level varchar(2) not null default 'L2',
    last_active_at bigint,
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`create table if not exists data_access_audit (
    id bigserial primary key,
    member_id varchar(32),
    action varchar(32) not null,
    target varchar(128),
    detail_json jsonb,
    created_at bigint not null
  )`)
  await run(`create index if not exists idx_data_access_audit_time on data_access_audit(created_at desc)`)
  // D2 · 账号/团队/RBAC 地基（与 D1 迁移 0025 同构；PG 支持 ADD COLUMN IF NOT EXISTS）
  await run(`create table if not exists users (
    id varchar(32) primary key,
    email varchar(160) not null unique,
    name varchar(64) not null,
    password_hash varchar(255) not null,
    status varchar(16) not null default 'active',
    created_at bigint not null,
    updated_at bigint not null,
    last_login_at bigint
  )`)
  await run(`create table if not exists teams (
    id varchar(32) primary key,
    name varchar(64) not null,
    slug varchar(64) not null unique,
    created_by varchar(32),
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`create table if not exists team_members (
    team_id varchar(32) not null,
    user_id varchar(32) not null,
    role varchar(16) not null default 'member',
    access_level varchar(2) not null default 'L2',
    status varchar(16) not null default 'active',
    joined_at bigint,
    created_at bigint not null,
    updated_at bigint not null,
    primary key (team_id, user_id)
  )`)
  await run(`create table if not exists invitations (
    id varchar(32) primary key,
    team_id varchar(32) not null,
    email varchar(160) not null,
    role varchar(16) not null default 'member',
    access_level varchar(2) not null default 'L2',
    token_hash varchar(64) not null,
    expires_at bigint not null,
    invited_by varchar(32),
    accepted_at bigint,
    revoked_at bigint,
    created_at bigint not null
  )`)
  await run(`create table if not exists sessions (
    id varchar(32) primary key,
    user_id varchar(32) not null,
    token_hash varchar(64) not null,
    expires_at bigint not null,
    revoked_at bigint,
    ip varchar(64),
    user_agent varchar(255),
    created_at bigint not null
  )`)
  await run(`create table if not exists audit_logs (
    id bigserial primary key,
    team_id varchar(32),
    actor_user_id varchar(32),
    actor_email varchar(160),
    action varchar(32) not null,
    target_type varchar(32),
    target_id varchar(64),
    detail_json jsonb,
    ip varchar(64),
    user_agent varchar(255),
    created_at bigint not null
  )`)
  await run(`alter table applications add column if not exists team_id varchar(32)`)
  await run(`create index if not exists idx_applications_team on applications(team_id)`)
  await run(`create index if not exists idx_team_members_user on team_members(user_id)`)
  await run(`create index if not exists idx_invitations_team on invitations(team_id, created_at desc)`)
  await run(`create index if not exists idx_sessions_user on sessions(user_id, created_at desc)`)
  await run(`create index if not exists idx_audit_logs_team_time on audit_logs(team_id, created_at desc)`)

  // ==================== B2 · SLO / 错误预算（双后端同构，对齐 D1 0027/0028） ====================
  // 字段与 D1 一致；PG 用 jsonb（::jsonb），D1 用 TEXT(JSON)。
  await run(`create table if not exists slo_definitions (
    id varchar(32) primary key, app_id varchar(64) not null, team_id varchar(32),
    name varchar(80) not null, objective real not null, window_days integer not null default 30,
    sli_type varchar(16) not null, sli_config jsonb not null default '{}'::jsonb,
    alert_policy jsonb not null default '{}'::jsonb, created_by varchar(32),
    created_at bigint not null, updated_at bigint not null
  )`)
  await run(`create table if not exists slo_burn_snapshots (
    id varchar(32) primary key, slo_id varchar(32) not null, snap_at bigint not null,
    window_start bigint not null, window_end bigint not null, total bigint not null, bad bigint not null,
    good_ratio real not null, budget_used real not null, burn_rate real not null, status varchar(12) not null
  )`)
  await run(`create index if not exists idx_slo_team_app on slo_definitions(team_id, app_id, updated_at desc)`)
  await run(`create index if not exists idx_burn_slo on slo_burn_snapshots(slo_id, snap_at desc)`)

  // ==================== B3 · 合成监控（双后端同构，对齐 D1 0030/0031） ====================
  // 字段与 D1 一致；PG 用 boolean（D1 用 integer 0/1）。
  // app_id varchar(64) 对齐 applications 宽度（B2 曾踩 32 宽度坑，勿用 32）。
  await run(`create table if not exists synthetic_checks (
    id varchar(32) primary key, app_id varchar(64) not null, team_id varchar(32),
    name varchar(80) not null, url varchar(512) not null, method varchar(8) not null default 'GET',
    interval_seconds integer not null default 300, timeout_ms integer not null default 10000,
    expected_status integer not null default 200, keyword varchar(256), latency_threshold_ms integer,
    fail_threshold integer not null default 3, enabled boolean not null default true,
    last_status varchar(12) default 'unknown', last_run_at bigint, consecutive_failures integer not null default 0,
    created_at bigint not null, updated_at bigint not null
  )`)
  await run(`create table if not exists synthetic_results (
    id varchar(32) primary key, check_id varchar(32) not null, ok boolean not null,
    outcome varchar(12) not null, status_code integer, latency_ms integer,
    latency_exceeded boolean not null default false, error varchar(256), checked_at bigint not null
  )`)
  await run(`create index if not exists idx_syn_checks_team_app on synthetic_checks(team_id, app_id, updated_at desc)`)
  await run(`create index if not exists idx_syn_results_check_time on synthetic_results(check_id, checked_at desc)`)
  await run(`create index if not exists idx_syn_results_checked_at on synthetic_results(checked_at)`)

  // ==================== D1 · 数据主体权利 DSR（双栈同构，对齐 D1 0033） ====================
  // 列名/列宽/默认值与 D1 版逐字对齐（team_id varchar(32) 对齐 D2 既有表现实；app_id varchar(64) 对齐 applications），
  // 保证双栈 JSON 响应同形状。issues/events/replays 为 DSR 命中与擦除目标表（复用既有表，不新建）。
  await run(`create table if not exists dsr_requests (
    id varchar(32) primary key, team_id varchar(32),
    app_id varchar(64) not null default '', subject_type varchar(16) not null,
    subject_value varchar(256) not null, request_type varchar(16) not null,
    mode varchar(16), export_format varchar(8), status varchar(24) not null default 'draft',
    hit_events integer not null default 0, hit_issues integer not null default 0,
    hit_replays integer not null default 0,
    requested_by varchar(64) not null, approved_by varchar(64), executed_by varchar(64),
    reject_reason varchar(512),
    rows_affected_events integer not null default 0, rows_affected_issues integer not null default 0,
    rows_affected_replays integer not null default 0,
    result_json text,
    created_at bigint not null, decided_at bigint, executed_at bigint, completed_at bigint
  )`)
  await run(`create index if not exists idx_dsr_req_team_status on dsr_requests(team_id, status, created_at)`)
  await run(`create index if not exists idx_dsr_req_subject on dsr_requests(team_id, subject_type, subject_value)`)
  await run(`create table if not exists dsr_audit_logs (
    id varchar(32) primary key, request_id varchar(32) not null,
    actor_id varchar(64) not null, action varchar(24) not null,
    detail_json text, ts bigint not null
  )`)
  await run(`create index if not exists idx_dsr_audit_request on dsr_audit_logs(request_id, ts)`)

  // ==================== A3 · 实验分析（双栈同构，对齐 D1 0034 / cloudflare/migrations/0034_experiments.sql） ====================
  // 列名/列宽/默认值与 D1 版逐字对齐（app_id varchar(64) 对齐 applications；team_id varchar(32) 对齐 D2 既有表现实），
  // 保证双栈 JSON 响应同形状。JSON 字段保持 text（JSON 均在 JS 端 JSON.parse，规避 toPgSql 盲替换 `?`
  // 与 JSONB `?`/`?|` 算子冲突）。
  await run(`create table if not exists experiments (
    id varchar(32) primary key,
    app_id varchar(64) not null,
    team_id varchar(32),
    key varchar(64) not null,
    name varchar(80) not null,
    description varchar(512),
    status varchar(16) not null default 'draft',
    salt varchar(32) not null,
    traffic_pct integer not null default 100,
    variants_json text not null,
    goal_metric_json text,
    started_at bigint,
    ended_at bigint,
    created_by varchar(64),
    updated_by varchar(64),
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`create unique index if not exists uq_experiments_app_key on experiments(app_id, key)`)
  await run(`create index if not exists idx_experiments_app_status on experiments(app_id, status, updated_at)`)
  await run(`create index if not exists idx_experiments_team on experiments(team_id, updated_at)`)
  // 曝光表：唯一索引 (experiment_id, visitor_id) 去重——写入一律 on conflict do nothing，已记录变体永不改写
  await run(`create table if not exists experiment_exposures (
    id varchar(32) primary key,
    experiment_id varchar(32) not null,
    app_id varchar(64) not null,
    team_id varchar(32),
    visitor_id varchar(64) not null,
    session_id varchar(64),
    variant varchar(32) not null,
    exposed_at bigint not null
  )`)
  await run(`create unique index if not exists uq_exp_exposure_dedup on experiment_exposures(experiment_id, visitor_id)`)
  await run(`create index if not exists idx_exp_exposure_variant_ts on experiment_exposures(experiment_id, variant, exposed_at)`)
  await run(`create index if not exists idx_exp_exposure_app_ts on experiment_exposures(app_id, exposed_at)`)

  // ==================== D3 · 用量计量与套餐/定价（双栈同构，对齐 D1 0035 / cloudflare/migrations/0035_metering.sql） ====================
  // 列名/列宽/默认值与 D1 版逐字对齐（app_id varchar(64) 对齐 applications；team_id varchar(32) 对齐 teams/team_members），
  // 保证双栈 JSON 响应同形状。JSON 字段保持 text（全部在 JS 端 JSON.parse，规避 toPgSql 盲替换 `?` 与 JSONB `?`/`?|` 算子冲突）。
  // enabled 用 boolean（D1 用 integer 0/1，服务层统一 Boolean() 映射，沿用 db.js:673 既有惯例）。
  //
  // ⚠️ 保留策略红线：`usage_daily` / `quota_events` 是账单与争议凭证，保留 25 个自然月，
  //    **不在** governance.js cleanupExpiredData() 的清理清单内（其清理由 meteringDailyTick 独立执行）。
  //    禁止后续把这两张表加入 cleanupExpiredData()——详见该函数末尾的显式排除注释。
  //
  // 日切口径：`day` = yyyyMMdd（UTC 自然日），与既有 metric_daily_stats（0022 迁移）同范式；
  // period_key='YYYY-MM' 与 day 可互推，故不建 usage_monthly 冗余表（避免双写账本漂移）。
  await run(`create table if not exists usage_daily (
    team_id varchar(32) not null default '',
    app_id varchar(64) not null default '',
    metric varchar(24) not null,
    day integer not null,
    value bigint not null default 0,
    updated_at bigint not null,
    primary key (team_id, app_id, metric, day)
  )`)
  await run(`create index if not exists idx_usage_team_day on usage_daily(team_id, day)`)
  await run(`create index if not exists idx_usage_app_day on usage_daily(app_id, day)`)
  await run(`create table if not exists plans (
    id varchar(32) primary key,
    code varchar(32) not null unique,
    name varchar(64) not null,
    quota_json text not null,
    soft_limit_pct integer not null default 80,
    hard_action varchar(16) not null default 'none',
    price_hint_json text,
    enabled boolean not null default true,
    created_at bigint not null,
    updated_at bigint not null
  )`)
  await run(`create table if not exists team_plans (
    team_id varchar(32) primary key,
    plan_id varchar(32) not null,
    quota_override_json text,
    updated_by varchar(64),
    updated_at bigint not null
  )`)
  await run(`create table if not exists quota_events (
    id varchar(32) primary key,
    team_id varchar(32) not null,
    metric varchar(24) not null,
    period_key varchar(8) not null,
    level varchar(8) not null,
    value bigint not null,
    quota bigint not null,
    notified integer not null default 0,
    created_at bigint not null
  )`)
  await run(`create unique index if not exists uq_quota_event on quota_events(team_id, metric, period_key, level)`)
  await run(`create index if not exists idx_quota_events_team_period on quota_events(team_id, period_key)`)
  // 种子档位（on conflict(code) do nothing 幂等）：无 team_plans 行时逻辑默认挂 free，不写物理行（PRD Q5）。
  const meteringSeedAt = Date.now()
  for (const seed of [
    ['plan_free', 'free', '免费版', '{"events":100000,"replay_sessions":1000,"seats":3,"retention_days":7}'],
    ['plan_pro', 'pro', '专业版', '{"events":5000000,"replay_sessions":50000,"seats":20,"retention_days":30}'],
    ['plan_enterprise', 'enterprise', '企业版', '{"events":-1,"replay_sessions":-1,"seats":-1,"retention_days":90}']
  ]) {
    await run(`insert into plans (id, code, name, quota_json, soft_limit_pct, hard_action, price_hint_json, enabled, created_at, updated_at)
      values (?, ?, ?, ?, 80, 'none', null, true, ?, ?) on conflict (code) do nothing`,
      [seed[0], seed[1], seed[2], seed[3], meteringSeedAt, meteringSeedAt])
  }
  // D3 · 回放会话去重（口径：会话键 = coalesce(base_session_id, session_id)，见架构 §2.6）：
  // replay_events 此前仅有 session_id 侧索引，重算与去重点查按 base_session_id 扫描会退化为全表扫，故补索引。
  await run(`create index if not exists idx_replay_events_base_session on replay_events(base_session_id)`)
  await run(`create index if not exists idx_replay_events_app_session_ts on replay_events(app_id, session_id, created_at)`)
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

/**
 * 执行查询，返回第一行（语义对齐 Cloudflare D1 的 .first()）。
 * @returns {Promise<object|null>}
 */
export async function first(sql, params = []) {
  const rows = await all(sql, params)
  return rows[0] ?? null
}

/** 创建 PostgreSQL 连接池，支持 DATABASE_URL / PG_URL 或分项环境变量配置 */
function createDbClient() {
  const timeoutMs = positiveInt(process.env.PG_QUERY_TIMEOUT_MS, 5000, 1000, 60000)
  return new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      process.env.PG_URL ||
      `postgresql://${encodeURIComponent(process.env.PGUSER || 'postgres')}:${encodeURIComponent(process.env.PGPASSWORD || '')}@${process.env.PGHOST || '127.0.0.1'}:${Number(process.env.PGPORT || 5432)}/${dbName}`,
    max: positiveInt(process.env.PG_POOL_SIZE, 10, 1, 100),
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs
  })
}

function positiveInt(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback
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
