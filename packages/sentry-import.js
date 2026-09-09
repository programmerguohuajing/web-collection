/**
 * Sentry issue 导入映射器（双端同源：Node/PG 与 Worker/D1 共用）。
 *
 * 职责：把 Sentry 导出的 issue（JSON 导出文件或 webhook payload）规整为
 * Web Collection 的 issue 事件形状。指纹计算**不在此处**——各栈必须使用
 * 自己的指纹公式与 issues 表写入（Node: utils/domain.js `fingerprint()`；
 * Worker: worker.js `issueKey()` + `sha256()`），保证与本栈存量事件去重对齐。
 */

/** 与两栈指纹公式一致的 FetchError 家族判定（source 参与/排除指纹） */
const FETCH_ERROR_FAMILY = ['FetchError', 'ResourceError', 'SseError', 'WebSocketError']

/**
 * 规整单条 Sentry issue。
 * 兼容：JSON 导出数组项（{issue_id,title,culprit,level,count,first_seen,last_seen,...}）、
 * 带 latest_event/event 的 webhook payload、以及简化后的自定义 JSON。
 * @param {object} entry - Sentry issue 条目
 * @returns {object} 规整结果 {name,message,stack,culprit,url,level,release,count,firstSeen,lastSeen,sentryIssueId,source}
 */
export function mapSentryIssue(entry = {}) {
  const latest = entry.latest_event || entry.latestEvent || entry.event || {}
  const meta = latest.metadata || entry.metadata || {}
  const title = String(entry.title ?? latest.title ?? '').trim()
  const culprit = String(entry.culprit ?? latest.culprit ?? '').trim()
  const name = (String(meta.type ?? '').trim() || title.split('\n')[0].trim() || 'SentryError').slice(0, 150)
  const message = (String(meta.value ?? '').trim() || title || name).slice(0, 2000)
  return {
    name,
    message,
    stack: extractStack(latest).slice(0, 8000),
    culprit: culprit.slice(0, 300),
    url: String(latest.request?.url ?? latest.request?.headers?.Referer ?? entry.url ?? '').trim().slice(0, 1000),
    level: String(entry.level ?? latest.level ?? 'error').slice(0, 32),
    release: String(latest.release ?? entry.release ?? 'imported').slice(0, 64),
    count: Math.max(1, Number(entry.count ?? 1) || 1),
    firstSeen: tsMs(entry.first_seen ?? entry.firstSeen ?? entry.firstSeenMs),
    lastSeen: tsMs(entry.last_seen ?? entry.lastSeen ?? entry.lastSeenMs),
    sentryIssueId: String(entry.issue_id ?? entry.id ?? '').slice(0, 64),
    // FetchError 家族的 source 参与指纹：Sentry 场景用 culprit 近似还原端点来源
    source: FETCH_ERROR_FAMILY.includes(name) ? culprit.slice(0, 300) : ''
  }
}

/**
 * 批量规整 + 容错。返回 {mapped, skipped}。
 * @param {unknown} input - 数组或含 issues/items 键的对象
 */
export function mapSentryIssues(input) {
  const raw = Array.isArray(input) ? input : (Array.isArray(input?.issues) ? input.issues : (Array.isArray(input?.items) ? input.items : null))
  if (!raw) return { mapped: [], skipped: 0, invalid: 'payload 需为 issue 数组或含 issues/items 数组键' }
  const mapped = []
  let skipped = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') { skipped++; continue }
    const m = mapSentryIssue(item)
    if (!m.name && !m.message) { skipped++; continue }
    mapped.push(m)
  }
  return { mapped, skipped }
}

/** 从 Sentry event 的 exception stacktrace frames 拼回可读 stack 文本 */
function extractStack(latest) {
  if (typeof latest.stack === 'string' && latest.stack.trim()) return latest.stack.trim()
  const values = []
  for (const entryItem of Array.isArray(latest.entries) ? latest.entries : []) {
    if (entryItem?.type === 'exception') {
      for (const v of entryItem?.data?.values || []) {
        const frames = v?.stacktrace?.frames || []
        // Sentry frames 自旧到新排列，倒序拼成与 JS 堆栈一致的自顶向下文本
        for (const f of [...frames].reverse()) {
          const loc = [f.abs_path || f.filename, f.lineno, f.colno].filter(Boolean).join(':')
          values.push([loc || '(unknown)', f.function].filter(Boolean).join(' '))
        }
      }
    }
  }
  if (values.length) return values.join('\n')
  const frames = latest.stacktrace?.frames || []
  for (const f of [...frames].reverse()) {
    const loc = [f.filename || f.abs_path, f.lineno, f.colno].filter(Boolean).join(':')
    values.push([loc || '(unknown)', f.function].filter(Boolean).join(' '))
  }
  return values.join('\n')
}

/** ISO/epoch 秒/epoch 毫秒 → epoch 毫秒（非法回退当前时间） */
function tsMs(value) {
  if (value === null || value === undefined || value === '') return Date.now()
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? Math.round(n) : Math.round(n * 1000)
  const t = Date.parse(String(value))
  return Number.isFinite(t) ? t : Date.now()
}
