#!/usr/bin/env bash
# 修复 web-collection D1 events 表缺失二级索引
# 目的：消除全表扫描导致的 Rows read 爆量（曾累计 771M 行）
# 用法（D1 每日行读配额重置后 / 低峰期执行，避免建索引超时整批回滚）：
#   bash scripts/fix_events_indexes.sh
# 注意：每条 CREATE INDEX 单独执行；大表可能触发 30s 超时 (code 7429)，
#       失败请稍后单独重试该条；if not exists 保证幂等。
set -o pipefail
DB="web-collection"

echo "===== 1) 现有 events 索引 ====="
wrangler d1 execute "$DB" --remote --command "select name, sql from pragma_index_list('events')" \
  || echo "(查询失败：可能配额耗尽，请等 UTC 0 点重置后重试)"

echo "===== 2) events 行数 ====="
wrangler d1 execute "$DB" --remote --command "select count(*) as rows from events" \
  || echo "(查询失败：可能配额耗尽)"

echo "===== 3) 逐条补建索引（每条独立执行）====="
for SQL in \
  "create index if not exists idx_events_app_ts on events(app_id, ts DESC)" \
  "create index if not exists idx_events_ts on events(ts DESC)" \
  "create index if not exists idx_events_type_ts on events(type, ts DESC)" \
  "create index if not exists idx_events_type_name_ts on events(type, name, ts DESC)" \
  "create index if not exists idx_events_session on events(session_id, ts)" \
  "create index if not exists idx_events_trace on events(trace_id, ts)" \
  "create index if not exists idx_events_event_id on events(event_id)" \
  "create index if not exists idx_events_request_id on events(request_id)" \
  "create index if not exists idx_events_app_version on events(app_id, app_version, ts DESC)" ; do
  echo "----> $SQL"
  wrangler d1 execute "$DB" --remote --command "$SQL" || echo "    [失败] 该条未建，请稍后手动重试"
done

echo "===== 4) 复核索引 ====="
wrangler d1 execute "$DB" --remote --command "select name from pragma_index_list('events')" \
  || echo "(复核失败：可能配额耗尽)"
echo "DONE"
