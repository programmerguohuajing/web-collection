-- 0010: replays 表新增 user_agent，供回放「会话信息」展示设备/浏览器/OS。
-- 回放记录此前只存 user_id/user_name/user_phone，丢失了 SDK 上报的 userAgent，
-- 导致前端「设备」一栏只能写死为「未采集」。SDK 上报的回放事件本身携带 userAgent
-- （来自采集 base），此处落库后在 replayList / replayEvents 中返回，前端据此推导设备。
ALTER TABLE replays ADD COLUMN user_agent TEXT;
