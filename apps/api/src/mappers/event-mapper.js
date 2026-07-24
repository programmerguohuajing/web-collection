import { parseJson } from '../utils/json.js'

/**
 * 将数据库行映射为前端事件对象（驼峰命名）。
 * 将 snake_case 列名转为 camelCase，并将 JSONB 字段解析为对象。
 *
 * @param {object} row - 数据库行
 * @returns {object} 前端格式的事件对象
 */
export function mapEvent(row) {
  return {
    id: row.id,
    ts: Number(row.ts),
    type: row.type,
    appId: row.app_id,
    release: row.release_name,
    userId: row.user_id,
    userName: row.user_name,
    userPhone: maskPhone(row.user_phone),
    sessionId: row.session_id,
    deviceId: row.device_id,
    traceId: row.trace_id,
    spanId: row.span_id,
    url: row.url,
    path: row.path,
    title: row.title,
    referrer: row.referrer,
    userAgent: row.user_agent,
    sdkVersion: row.sdk_version,
    environment: row.environment,
    source: row.source,
    context: parseJson(row.context_json),
    browser: row.browser,
    os: row.os,
    device: row.device,
    name: row.name,
    metric: row.metric,
    value: row.value == null ? undefined : Number(row.value),
    message: row.message,
    stack: row.stack,
    props: parseJson(row.props_json),
    breadcrumbs: parseJson(row.breadcrumbs_json)
  }
}

function maskPhone(phone = '') {
  return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
}
