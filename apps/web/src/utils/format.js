export function formatDuration(value) {
  const milliseconds = Math.max(0, Number(value))
  if (!Number.isFinite(milliseconds)) return '-'
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60000) return `${Math.round(milliseconds / 100) / 10}s`
  const seconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

export function readableText(...values) {
  return firstReadable(values) || '-'
}

export function behaviorDetailLabel(event = {}) {
  const props = event.props || {}
  if (event.type === 'track') return readableText(event.name)
  if (event.type !== 'behavior') return '-'

  if (event.name === 'click' || event.name === 'exposure') {
    return readableText(props.elementLabel, props.label, props.text, props.ariaLabel, props.alt, props.title, props.name, props.id)
  }
  if (event.name === 'page_leave') return props.stayTime == null ? '-' : `停留 ${formatDuration(props.stayTime)}`
  if (event.name === 'scroll') {
    const depth = formatPercent(props.depth)
    const maxDepth = formatPercent(props.maxDepth)
    return depth === '-' && maxDepth === '-' ? '-' : `当前 ${depth} · 最深 ${maxDepth}`
  }
  if (['route', 'replaceState', 'pushState', 'hashchange', 'popstate'].includes(event.name)) {
    return props.from || props.to ? `${props.from || '-'} → ${props.to || '-'}` : '-'
  }
  return '-'
}

export function formatErrorLocation(event = {}) {
  const { source, line, column } = event.props || {}
  if (source && line) return `${source}:${line}:${column || 0}`
  const match = [...String(event.stack || '').matchAll(/((?:https?:\/\/|\/)[^():\s]+):(\d+):(\d+)/g)]
    .find(item => !/web-collection-sdk(?:\.[\w-]+)?\.js/i.test(item[1]))
  return match ? `${match[1]}:${match[2]}:${match[3]}` : '-'
}

export function scoreWebVitals(perf = {}) {
  const checks = [['fcp', 1800, 3000, 10], ['lcp', 2500, 4000, 25], ['inp', 200, 500, 25], ['cls', 0.1, 0.25, 25], ['ttfb', 800, 1800, 15]]
  let score = 0
  let measured = 0
  for (const [name, good, poor, weight] of checks) {
    if (perf[name] == null) continue
    measured++
    score += perf[name] <= good ? weight : perf[name] <= poor ? weight / 2 : 0
  }
  return measured ? { score: Math.round(score), grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : score >= 25 ? 'D' : 'F', measured } : null
}

export function formatSpanId(event = {}) {
  return firstPresent(event.spanId, event.span_id) || '-'
}

export function formatSpanStatus(event = {}) {
  const props = event.props && typeof event.props === 'object' ? event.props : {}
  const status = firstPresent(props.status, props.statusCode, props.status_code, event.status, event.statusCode, event.status_code)
  const numericStatus = Number(status)
  const failed = event.type === 'error'
    || props.failed === true
    || props.failed === 'true'
    || props.statusClass === 'network_error'
    || String(status).toUpperCase() === 'ERROR'
    || (Number.isFinite(numericStatus) && numericStatus >= 400)

  if (failed && (!status || numericStatus === 0)) return 'ERROR'
  return status == null ? 'OK' : String(status)
}

export function spanStatusType(event = {}) {
  const status = formatSpanStatus(event)
  const numericStatus = Number(status)
  if (status === 'ERROR' || status === 'FAILED' || (Number.isFinite(numericStatus) && numericStatus >= 400)) return 'danger'
  if (Number.isFinite(numericStatus) && numericStatus >= 300) return 'warning'
  if (status === 'UNSET' || status === '-') return 'info'
  return 'success'
}

/**
 * 性能/告警 metric 名 → 中文映射
 * 涵盖 SDK 在 performance/*.js 上报的所有 metric，以及告警渠道配置/告警记录里使用的 metric。
 * 涉及单位说明：memory 上报的 value 是 Chrome performance.memory.usedJSHeapSize（字节）。
 */
export const METRIC_LABELS = {
  // Web Vitals / Core Web Vitals
  fcp: '首次内容渲染',
  lcp: '最大内容渲染',
  cls: '累积布局偏移',
  inp: '交互延迟',
  fid: '首次输入延迟',
  ttfb: '首字节时间',
  // 自定义性能指标
  longtask: '长任务',
  tbt: '总阻塞时间',
  white_screen: '首页白屏时间',
  blank_screen_rate: '白屏率',
  first_screen: '首屏完成时间',
  route_render: '路由切换渲染',
  data_ready: '页面数据就绪',
  dom_ready: 'DOM Ready',
  page_load: '页面完全加载',
  js_boot: 'JavaScript 初始化',
  // 网络请求阶段
  resource_failure_rate: '资源加载失败率',
  slow_api_rate: '慢接口率',
  dns: 'DNS 查询',
  tcp: 'TCP 连接',
  tls: 'TLS 握手',
  request: '服务端响应',
  download: 'HTML 下载',
  cache_hit_rate: '缓存命中率',
  redirect: '重定向耗时',
  redirect_count: '重定向次数',
  // 运行时监控
  memory: '内存使用',
  // 告警/错误事件 metric
  error: '错误',
  log_error: 'Error 日志',
  regression: '回归'
}

export function metricLabel(metric) {
  return METRIC_LABELS[metric] || metric || '-'
}

/**
 * 事件流 event.name → 中文映射（性能/行为/网络事件名称，非告警 metric）
 * 与 METRIC_LABELS 区分：同一个英文 key（如 error）在两个语境下中文不同——
 * 事件流里 'error' 指未捕获脚本异常（→ 脚本错误），告警里指错误告警（→ 错误）。
 */
export const EVENT_NAME_LABELS = {
  // 行为
  click: '点击',
  pv: '页面访问',
  pageview: '页面访问',
  page_leave: '页面离开',
  scroll: '滚动',
  stay: '停留',
  exposure: '曝光',
  route: '路由切换',
  replaceState: '路由切换',
  pushState: '路由切换',
  popstate: '路由切换',
  hashchange: '路由切换',
  // 埋点
  track: '埋点',
  // 网络/资源
  fetch: '接口请求',
  xhr: '接口请求',
  websocket: 'WebSocket',
  sse: 'SSE',
  resource: '资源加载',
  // 错误
  error: '脚本错误',
  unhandledrejection: 'Promise 异常'
}

export function eventNameLabel(name) {
  return EVENT_NAME_LABELS[name] || name || '-'
}

/**
 * 级别（告警/日志）→ 中文映射 + 对应 el-tag 类型
 * 涵盖日志查询参数（log/info/warn/error）和告警级别（warning/error/critical）。
 */
export const LEVEL_LABELS = {
  log: '普通',
  info: '提示',
  warn: '警告',
  warning: '警告',
  error: '错误',
  critical: '严重'
}

export function levelLabel(level) {
  return LEVEL_LABELS[level] || level || '-'
}

export function levelTagType(level) {
  if (level === 'critical' || level === 'error') return 'danger'
  if (level === 'warn' || level === 'warning') return 'warning'
  if (level === 'info') return 'info'
  return 'info'
}

/**
 * 告警/性能 metric → el-tag 类型
 * 错误/回归类 → danger（红色）；性能指标类 → warning（黄色）；其他 → info
 */
export function metricTagType(metric) {
  if (metric === 'error' || metric === 'log_error' || metric === 'regression') return 'danger'
  if (METRIC_LABELS[metric]) return 'warning'
  return 'info'
}

function formatPercent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${Math.round(number)}%` : '-'
}

function firstReadable(values) {
  for (const value of values) {
    if (value == null) continue
    if (typeof value === 'string') {
      const text = value.trim()
      if (text && text !== '[object Object]') return text
      continue
    }
    if (typeof value === 'object') {
      const nested = firstReadable([value.message, value.error, value.reason, value.detail, value.title, value.name].filter(item => item !== value))
      if (nested) return nested
      try { return JSON.stringify(value) } catch { continue }
    }
    return String(value)
  }
  return ''
}

function firstPresent(...values) {
  return values.find(value => value != null && value !== '')
}
