-- Phase 2 · 知识中枢：Article 主表 + 质量 + 历史（Cloudflare D1）
-- 部署：wrangler d1 migrations apply web-collection --remote
-- 注意：D1(SQLite) 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS；新表用 create table if not exists 即可。

-- Article 主表（可编辑 source of truth）；id 同时作为 ai_kb_chunks.source_id
create table if not exists ai_kb_articles (
  id text primary key,
  slug text,
  title text not null,
  type text not null,                 -- issue | runbook | doc | faq | feedback
  body text,                          -- markdown 权威正文（chunk 由其派生）
  visibility text not null default 'internal',  -- public | internal
  status text not null default 'published',     -- draft | published | archived
  tags_json text,
  linked_errors_json text,
  app_scope text not null default 'global',
  owner text,
  source_json text,                   -- {kind:'issue'|'manual'|'url'|'feedback', ref}
  version integer not null default 1,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists idx_kb_article_type on ai_kb_articles(type);
create index if not exists idx_kb_article_vis on ai_kb_articles(visibility);
create index if not exists idx_kb_article_status on ai_kb_articles(status);
create index if not exists idx_kb_article_app on ai_kb_articles(app_scope);

-- 质量指标：被 AI 引用 / 有用率 / 反馈 / 最近引用
create table if not exists ai_kb_quality (
  article_id text primary key,
  ai_citations integer not null default 0,
  up_count integer not null default 0,
  down_count integer not null default 0,
  useful_rate real,                   -- 0..1，由 up/(up+down) 派生；null 表示暂无反馈
  feedback_count integer not null default 0,
  last_cited_at integer
);
create index if not exists idx_kb_quality_cite on ai_kb_quality(ai_citations);

-- 编辑版本历史（快照用于回溯/回滚）
create table if not exists ai_kb_history (
  id text primary key,
  article_id text not null,
  version integer not null,
  editor text,
  note text,
  snapshot_json text,                 -- {title,type,visibility,status,body,tags,linkedErrors}
  created_at integer not null
);
create index if not exists idx_kb_hist_article on ai_kb_history(article_id, version);
