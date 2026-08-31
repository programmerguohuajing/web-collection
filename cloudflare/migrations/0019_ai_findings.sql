-- Phase 6 · M6：AI 主动诊断「洞察流」落库表（Cloudflare D1）
-- 由定时/异常扫描（Cron / Durable Objects alarm）写入，控制台以红点/卡片呈现。
-- 点开某条洞察即调用 /api/ai/diagnose 作深诊断（scope 复用 P0 引擎）。

create table if not exists ai_findings (
  id text primary key,
  scope text not null,             -- 'error-cluster' | 'release-regression' | 'perf-regression' | 'metric-drop'
  object text not null,            -- 诊断对象（错误名 / release 名 / 窗口标识）
  app_id text,
  summary text,                    -- 一句话结论
  evidence_json text,              -- 证据列表（JSON 数组）
  detail_json text,                -- 结构化对比数据（JSON）
  confidence real,                 -- 规则置信度 0-1
  status text default 'open',      -- 'open' | 'ack' | 'resolved' | 'ignored'
  created_at integer not null,
  updated_at integer
);
create index if not exists idx_findings_scope_obj on ai_findings(scope, object);
create index if not exists idx_findings_app_created on ai_findings(app_id, created_at);
