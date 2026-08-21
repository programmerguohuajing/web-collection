-- Phase 1 · M1：AI 诊断知识库与诊断记录表（Cloudflare D1）
-- 注意：SQLite ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS；迁移由 d1_migrations
-- 追踪只会执行一次，无需幂等。向量不在此存储——Cloudflare 路径存在 Vectorize 索引
-- （wrangler vectorize create ai-kb），此表仅存原文与元数据。

-- 诊断记录（用于缓存/评估/反馈关联）
create table if not exists ai_diagnoses (
  id text primary key,
  ref_type text not null,          -- 'trace' | 'error'
  ref_id text not null,            -- traceId 或 issue fingerprint
  app_id text,
  request_summary text,            -- 收到的请求摘要（JSON）
  response_json text,              -- 结构化诊断（JSON）
  model text,
  confidence real,
  degraded integer default 0,
  created_at integer not null
);
create index if not exists idx_diag_ref on ai_diagnoses(ref_type, ref_id);

-- 用户反馈
create table if not exists ai_feedback (
  id text primary key,
  diagnosis_id text,
  rating text,                     -- 'up' | 'down'
  correction text,
  created_at integer not null
);

-- RAG 原文（向量只存 id+向量于 Vectorize，原文与元数据存此便于回取与展示来源）
create table if not exists ai_kb_chunks (
  id text primary key,             -- hash(source,source_id,chunk_idx)
  source_type text,                -- issue | runbook | doc | code
  source_id text,
  app_id text,                     -- 租户隔离；文档可为 'global'
  chunk_idx integer,
  text text,
  metadata_json text,
  updated_at integer
);
create index if not exists idx_kb_src on ai_kb_chunks(source_type, source_id);

-- 摄取元数据（增量判定）
create table if not exists ai_kb_meta (
  id text primary key,
  source_type text,
  source_id text,
  content_hash text,
  version text,
  updated_at integer
);

-- ADR-005：解法字段，闭环 issue 时选填；空值不进 KB
-- 注意：resolution_notes 列已由 0016_issue_resolution_notes.sql 添加，此处不再重复添加
