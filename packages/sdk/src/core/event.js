/** 当前 SDK 版本号 */
export const SDK_VERSION = '0.1.16'

/** 默认敏感字段列表，这些 key 对应的值会被自动脱敏替换为 [REDACTED] */
const DEFAULT_REDACT_KEYS = ['password', 'token', 'secret', 'authorization', 'cookie']

/**
 * 判断事件来源：手动上报（manual）还是自动采集（auto）
 * 若事件已显式设置 source 字段则直接返回，否则根据 type 推断
 * @param {{ type: string, source?: string }} event
 * @returns {'manual' | 'auto'}
 */
export function eventSource(event) {
  if (event.source) return event.source
  // track 类型为用户主动调用，归为手动上报
  if (event.type === 'track') return 'manual'
  // behavior / perf / error / replay / log 均为 SDK 自动采集
  if (event.type === 'behavior' || event.type === 'perf' || event.type === 'error' || event.type === 'replay' || event.type === 'log') return 'auto'
  return 'manual'
}

/**
 * 将事件映射到采样分类（category），用于按类别独立控制采样率
 * - error  → error
 * - replay → replay
 * - behavior（含 exposure）→ exposure / behavior
 * - perf（网络请求类 metric）→ requests，其余指标 → performance
 * @param {{ type: string, name?: string, metric?: string }} event
 * @returns {string | undefined}
 */
export function eventCategory(event) {
  if (event.type === 'error') return 'error'
  if (event.type === 'replay') return 'replay'
  // exposure 是行为监控的子类型，单独拆分为独立分类以便精细控制采样
  if (event.type === 'behavior') return event.name === 'exposure' ? 'exposure' : 'behavior'
  if (event.type === 'perf') return ['fetch', 'xhr', 'websocket', 'sse', 'fetch_body', 'xhr_body'].includes(event.metric) ? 'requests' : 'performance'
  return undefined
}

/**
 * 根据分类和配置的采样率表，计算当前事件是否应被采样
 * - 优先使用按 category 配置的采样率，否则使用全局 fallback
 * - 结果被钳位在 [0, 1] 范围内，非数字回退为 1（全量采集）
 * @param {string} [category]
 * @param {Record<string, number>} [rates]
 * @param {number} [fallback=1]
 * @returns {number}
 */
export function sampleRateFor(category, rates = {}, fallback = 1) {
  const value = category && rates[category] != null ? Number(rates[category]) : Number(fallback)
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
}

/**
 * 递归脱敏对象/数组中的敏感字段
 * - 深度限制 4 层，防止死循环和性能问题
 * - 数组和对象最多遍历 100 项，防止超大数据结构
 * - 为字符串的 key 会转为小写后与 redactKeys 做大小写不敏感匹配
 * @param {*} value               - 待脱敏的值
 * @param {string[]} redactKeys   - 敏感字段名列表
 * @param {number} [depth=0]      - 当前递归深度
 * @returns {*} 脱敏后的值
 */
export function redactObject(value, redactKeys = DEFAULT_REDACT_KEYS, depth = 0) {
  if (depth > 4 || value == null) return value
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactObject(item, redactKeys, depth + 1))
  if (typeof value !== 'object') return value
  // 构造小写集合实现大小写不敏感匹配，避免大小写变体导致漏脱敏
  const keys = new Set(redactKeys.map(key => String(key).toLowerCase()))
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, keys.has(key.toLowerCase()) ? '[REDACTED]' : redactObject(item, redactKeys, depth + 1)]))
}

/**
 * 对事件整体做隐私清洗：props、context、breadcrumbs 及字符串 message 中的敏感字段全部脱敏
 * @param {object} event
 * @param {{ redactKeys?: string[] }} [privacy={}]
 * @returns {object} 脱敏后的事件副本
 */
export function sanitizeEvent(event, privacy = {}) {
  // 合并默认脱敏键和用户自定义键
  const redactKeys = [...DEFAULT_REDACT_KEYS, ...(privacy.redactKeys || [])]
  const result = { ...event }
  if (result.props) result.props = redactObject(result.props, redactKeys)
  if (result.context) result.context = redactObject(result.context, redactKeys)
  if (result.breadcrumbs) result.breadcrumbs = redactObject(result.breadcrumbs, redactKeys)
  // 字符串类型的 message 使用正则匹配脱敏（处理 key=value 或 key: value 格式）
  if (typeof result.message === 'string') result.message = redactText(result.message, redactKeys)
  return result
}

/**
 * 对文本中出现的敏感 key=value 模式做正则脱敏
 * 例如 "password=abc123" → "password=[REDACTED]"
 * @param {string} value
 * @param {string[]} keys
 * @returns {string}
 */
function redactText(value, keys) {
  // 转义正则特殊字符后拼接成 alternation 模式
  const pattern = keys.map(key => String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return pattern ? value.replace(new RegExp(`(${pattern})([=: ]+)[^,; ]+`, 'gi'), '$1$2[REDACTED]') : value
}
