-- Phase 6 · M6+：对话式 AI 助手会话表（P2 多轮记忆）
-- scope=ask 的问答历史落库，支持历史回溯与「洞察一键追问」。

create table if not exists ai_conversations (
  id text primary key,
  app_id text,
  title text,                     -- 首轮问题作为标题
  messages_json text,             -- 完整多轮消息（JSON 数组）
  created_at integer not null,
  updated_at integer
);
create index if not exists idx_conv_app_updated on ai_conversations(app_id, updated_at);
