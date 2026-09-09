/**
 * PRD 04 远程采集配置——SDK 端拉取模块。
 *
 * 失效安全契约（PRD §7）：
 * - 启动 + 每 ttl（默认 5 分钟）拉取 GET {origin}/sdk-config；
 * - 拉取失败 / 超时 3s / 响应非法 → 沿用上次配置；从未拉到 → null（调用方使用内置默认全开）；
 * - ETag 协商：304 免传输；绝不因配置系统故障停采。
 */

import { SDK_VERSION } from '../core/event.js'

const DEFAULT_TTL_MS = 300000
const FETCH_TIMEOUT_MS = 3000

/**
 * 请求参数携带两个彼此独立的版本维度（后端据此做配置灰度）：
 * - sdk_version：SDK 包自身版本，由本模块自动注入，接入方不可覆盖；
 * - release：接入方应用的发布版本，来自 createEys({ release })。
 *
 * 历史沿革：早期版本把 release 值塞进了 sdk_version 参数，导致后端无法按真实 SDK 版本灰度，
 * 且 scope.sdkVersionMax 实际约束的是应用版本。现拆分为两个参数；
 * 后端对仅带 sdk_version 的旧版 SDK 仍按原语义兼容。
 *
 * @param {object} opts
 * @param {string} opts.endpoint - 采集端点（用于推导同源 /sdk-config 地址）
 * @param {string} opts.appId
 * @param {string} [opts.release] - 应用发布版本
 * @param {string} [opts.environment]
 * @param {boolean|string} [opts.remoteConfig=true] - false 关闭；字符串作为自定义配置地址
 * @param {(config: object|null) => void} opts.onConfig - 每次配置应用时回调（null 表示无远程配置）
 * @returns {{ getConfig: () => object|null, getConfigVersion: () => number, destroy: () => void }}
 */
export function setupRemoteConfig({ endpoint, appId, release, environment, remoteConfig = true, onConfig }) {
  if (remoteConfig === false || typeof window === 'undefined' || typeof fetch !== 'function') {
    onConfig?.(null)
    return { getConfig: () => null, getConfigVersion: () => 0, destroy: () => {} }
  }

  const configUrl = resolveConfigUrl(endpoint, remoteConfig)
  let current = null
  let etag = ''
  let timer = null
  let destroyed = false

  async function refresh() {
    if (destroyed) return
    try {
      const headers = etag ? { 'if-none-match': etag } : {}
      const controller = new AbortController()
      const kill = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const url = new URL(configUrl, location.href)
        url.searchParams.set('app_id', appId || 'default')
        url.searchParams.set('sdk_version', SDK_VERSION)
        if (release) url.searchParams.set('release', release)
        if (environment) url.searchParams.set('platform', environment)
        const res = await fetch(url.toString(), { headers, signal: controller.signal, credentials: 'omit' })
        if (res.status === 304) return // 未变化，沿用当前配置
        if (!res.ok) return // 拉取失败：沿用上次/默认
        const body = await res.json()
        if (!body || typeof body !== 'object') return
        current = normalize(body)
        etag = res.headers.get('etag') || `"cfg-${current.config_version}"`
        onConfig?.(current)
      } finally {
        clearTimeout(kill)
      }
    } catch {
      // 超时/网络错误：失效安全，沿用上次配置
    }
  }

  function schedule() {
    const ttl = Number(current?.ttl_ms) > 0 ? Math.max(30000, Number(current.ttl_ms)) : DEFAULT_TTL_MS
    timer = setTimeout(() => { refresh().finally(schedule) }, ttl)
    if (typeof timer.unref === 'function') timer.unref()
  }

  refresh().finally(schedule)
  return {
    getConfig: () => current,
    getConfigVersion: () => Number(current?.config_version || 0),
    destroy: () => { destroyed = true; if (timer) clearTimeout(timer) }
  }
}

function resolveConfigUrl(endpoint, remoteConfig) {
  if (typeof remoteConfig === 'string' && remoteConfig) return remoteConfig
  try {
    const url = new URL(endpoint, location.href)
    const suffix = '/api/collect'
    url.pathname = url.pathname.endsWith(suffix)
      ? url.pathname.slice(0, -suffix.length) + '/sdk-config'
      : url.pathname.replace(/\/$/, '') + '/sdk-config'
    url.search = ''
    return url.toString()
  } catch {
    return '/sdk-config'
  }
}

/** 只保留已知字段并做类型钳位，防止服务端异常结构污染运行时（对齐 packages/collect-config.js 形状）。 */
function normalize(body) {
  const num01 = value => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined
  }
  const sampling = body.sampling && typeof body.sampling === 'object' ? body.sampling : {}
  const rateLimit = Number(body.rate_limits?.per_event_per_user_10min)
  const result = {
    config_version: Number(body.config_version) || 0,
    ttl_ms: Number(body.ttl_ms) > 0 ? Number(body.ttl_ms) : DEFAULT_TTL_MS,
    master_switch: body.master_switch === 'off' ? 'off' : 'on',
    sampling: {
      error: num01(sampling.error),
      performance: num01(sampling.performance),
      replay: num01(sampling.replay),
      behavior: num01(sampling.behavior)
    },
    blocked_events: Array.isArray(body.blocked_events) ? body.blocked_events.map(String).slice(0, 100) : [],
    plugins: body.plugins && typeof body.plugins === 'object'
      ? Object.fromEntries(Object.entries(body.plugins).map(([key, value]) => [String(key).slice(0, 32), value !== false]))
      : {},
    rate_limits: { per_event_per_user_10min: Number.isFinite(rateLimit) && rateLimit > 0 ? Math.floor(rateLimit) : 500 }
  }
  // C1 · OTLP 导出配置：仅当远端显式携带 otlp 块时透传（默认不含 → 导出保持关闭，绝不因配置故障误开）。
  if (body.otlp && typeof body.otlp === 'object') result.otlp = normalizeOtlp(body.otlp)
  // A3 · 实验定义块（PRD 14 §3.3）：白名单透传 running 实验（key/salt/traffic/variants），
  // 供通用原语 getVariant 做客户端一致性分桶；钳位防服务端异常结构污染运行时。
  // 仅当 items 非空时挂载（空块缺省 → SDK 按无实验处理）。
  if (body.experiments && typeof body.experiments === 'object' && Array.isArray(body.experiments.items)) {
    const items = body.experiments.items.slice(0, 20).map(item => ({
      key: typeof item?.key === 'string' ? item.key.slice(0, 64) : '',
      salt: typeof item?.salt === 'string' ? item.salt.slice(0, 32) : '',
      traffic_pct: Math.max(0, Math.min(100, Math.floor(Number(item?.traffic_pct) || 0))),
      variants: Array.isArray(item?.variants)
        ? item.variants.slice(0, 4).map(variant => ({
            name: typeof variant?.name === 'string' ? variant.name.slice(0, 32) : '',
            weight: Math.max(0, Math.floor(Number(variant?.weight) || 0))
          })).filter(variant => variant.name)
        : []
    })).filter(item => item.key && item.salt && item.variants.length)
    if (items.length) result.experiments = { items }
  }
  return result
}

/** 规范化远端 OTLP 导出配置：白名单字段 + 钳位，防注入任意键/超长端点。 */
function normalizeOtlp(input) {
  const clamp01Local = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1
  }
  const headers = {}
  if (input.headers && typeof input.headers === 'object') {
    for (const [key, value] of Object.entries(input.headers)) {
      if (value == null) continue
      headers[String(key).slice(0, 256)] = String(value).slice(0, 4096)
    }
  }
  return {
    enabled: Boolean(input.enabled),
    endpoint: typeof input.endpoint === 'string' ? input.endpoint.slice(0, 2048) : '',
    protocol: input.protocol === 'http/protobuf' ? 'http/protobuf' : 'http/json',
    headers,
    samplingRate: clamp01Local(input.samplingRate),
    metrics: input.metrics === false ? false : true,
    metricsEndpoint: typeof input.metricsEndpoint === 'string' ? input.metricsEndpoint.slice(0, 2048) : '',
    timeout: Number.isFinite(Number(input.timeout)) && Number(input.timeout) > 0 ? Math.min(60000, Number(input.timeout)) : 10000
  }
}
