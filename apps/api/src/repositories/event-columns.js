/**
 * events 表列白名单与裁剪工具。
 *
 * 用途：`listEventRows` 支持只取需要的列（避免 `select *` 拉取
 * breadcrumbs_json / context_json / stack 等大字段）。所有可被 `columns`
 * 参数引用的列必须登记在此，防止 SQL 注入。
 */

export const EVENT_COLUMNS = new Set([
  'id', 'ts', 'type', 'app_id', 'release_name', 'user_id', 'user_name',
  'user_phone', 'session_id', 'device_id', 'trace_id', 'span_id',
  'parent_span_id', 'url', 'path', 'title', 'referrer', 'user_agent',
  'sdk_version', 'environment', 'source', 'context_json', 'browser', 'os',
  'device', 'name', 'metric', 'value', 'message', 'stack', 'props_json',
  'breadcrumbs_json', 'app_version', 'product_id', 'event_id', 'request_id',
  'occurred_at', 'received_at', 'schema_version', 'batch_id', 'retry_count',
  'contract_status', 'contract_errors_json'
])

/**
 * 规范化列清单为 SQL 片段。
 * @param {string|string[]} [columns='*'] - '*' / 逗号串 / 数组
 * @returns {string} 可直接拼入 `select <...> from events` 的安全片段
 */
export function normalizeColumns(columns = '*') {
  if (columns === '*' || columns == null) return '*'
  const list = Array.isArray(columns)
    ? columns
    : String(columns).split(',').map((s) => s.trim())
  if (!list.length) return '*'
  for (const col of list) {
    if (!EVENT_COLUMNS.has(col)) {
      throw new Error(`unknown event column: ${col}`)
    }
  }
  return list.join(', ')
}
