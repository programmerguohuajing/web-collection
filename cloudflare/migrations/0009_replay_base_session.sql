-- 0009: replays 表新增 base_session_id，用于漏斗「流失会话 → 回放」精确关联。
-- 回放记录使用分段 sessionId（含 _segN 后缀），与事件表的全局 UUID session_id 属于不同标识体系；
-- 旧关联逻辑用 session_id 字符串前缀匹配，对不带 UUID 前缀的回放恒失败。
-- 新上报的回放会携带 baseSessionId（= 事件 UUID），写入本列；漏斗关联改为按 base_session_id 精确匹配。
-- 既有数据该列为 NULL，自然无法关联（符合预期，历史回放无法追溯到事件会话）。
ALTER TABLE replays ADD COLUMN base_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_replays_base_session ON replays(base_session_id);
