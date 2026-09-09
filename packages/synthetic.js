/**
 * @file B3 · 合成监控（Synthetic Monitoring / 主动拨测）—— 双端共享纯逻辑真相源。
 *
 * 设计要点（对齐 packages/slo.js 的分层原则）：
 * - 零三方依赖；Node (apps/api) 与 Cloudflare Worker (cloudflare/worker.js) 同源 import，
 *   杜绝两端判定漂移（四步判定规则 / SSRF 字面量校验 / 到期判断 / 参数收敛）。
 * - 仅放无 IO 的纯函数；fetch 执行、DNS 解析、SQL 方言差异分置两端（service 层负责）。
 * - SSRF 双层防护（PRD 12 Q2 + Lead 拍板）：
 *     第一层（本模块，双端共用）：仅 https + 主机名字面量黑名单（含十进制/十六进制
 *     IPv4 绕过与 IPv6 私网段）；
 *     第二层（Node 独有）：执行时 dns.lookup 解析后经 assertIpsAllowed 校验私网 IP；
 *     Worker 侧不暴露 DNS，仅保留第一层字面量兜底（Workers 出站网络模型下风险可控）。
 * - 数据最小化（Q3）：keyword 匹配仅在服务端内存中做，响应体原文永不落库。
 */

/** 允许的探测间隔（秒）：分钟级三档（PRD FR-1：60 | 300 | 600）。 */
export const PROBE_INTERVALS = [60, 300, 600]

/** 默认探测间隔（秒）。 */
export const DEFAULT_INTERVAL_SECONDS = 300

/** 默认探测超时（毫秒）；允许范围 1000–30000。 */
export const DEFAULT_TIMEOUT_MS = 10000
export const TIMEOUT_MS_MIN = 1000
export const TIMEOUT_MS_MAX = 30000

/** 默认期望状态码（PRD FR-1）。 */
export const DEFAULT_EXPECTED_STATUS = 200

/** 默认连续失败告警阈值（PRD FR-4）；上限 100。 */
export const DEFAULT_FAIL_THRESHOLD = 3
export const FAIL_THRESHOLD_MAX = 100

/** 字段长度上限（对齐 DDL varchar 宽度）。 */
export const NAME_MAX = 80
export const URL_MAX = 512
export const KEYWORD_MAX = 256
/** 失败原因摘要截断长度（落库 error 列上限）。 */
export const ERROR_MAX = 256

/** keyword 匹配读取的响应体上限（Q3：仅内存匹配，不落库原文）。 */
export const BODY_SNIPPET_LIMIT = 64 * 1024

/** 单次 tick 最多执行的到期探针数，超出顺延下一 tick（PRD §6 Worker tick 单次超量）。 */
export const TICK_BATCH_LIMIT = 20

/** 禁止的主机名字面量（含 metadata 服务端点）。 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal'
])

/** 禁止的主机名后缀（内网/本地域）。 */
const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local', '.localdomain', '.lan', '.home.arpa']

/**
 * 解析 IPv4 字面量为 32 位无符号整数；非 IPv4 形式返回 null。
 * 兼容十进制整数（2130706433）与十六进制（0x7f000001）等绕过写法。
 * @param {string} host
 * @returns {number|null}
 */
function parseIpv4(host) {
  const s = String(host || '').trim().toLowerCase()
  if (!s) return null
  if (/^0x[0-9a-f]+$/.test(s) || /^\d+$/.test(s)) {
    const n = s.startsWith('0x') ? parseInt(s.slice(2), 16) : parseInt(s, 10)
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null
    return n
  }
  const parts = s.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = parseInt(part, 10)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value
}

/**
 * IPv4 是否落入私网/保留段（0.0.0.0/8、10/8、127/8、169.254/16、172.16/12、
 * 192.168/16、100.64/10、组播与保留段 224+/240+）。
 * @param {number} n 32 位无符号整数
 * @returns {boolean}
 */
function isPrivateIpv4(n) {
  const a = (n >>> 24) & 0xff
  const b = (n >>> 16) & 0xff
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return a >= 224
}

/**
 * IPv6 字面量是否落入私网/保留段（::1 回环、:: 未指定、fc00::/7 唯一本地、
 * fe80::/10 链路本地、::ffff:x.y.z.w 映射的私网 IPv4）。
 * @param {string} host 小写、已去 zone 的 IPv6 字面量
 * @returns {boolean}
 */
function isPrivateIpv6(host) {
  const s = String(host || '').toLowerCase().split('%')[0]
  if (!s || !s.includes(':')) return false
  if (s === '::' || s === '::1') return true
  // IPv4 映射地址 ::ffff:10.0.0.1 → 复用 IPv4 判定
  if (s.startsWith('::ffff:')) {
    const v4 = parseIpv4(s.slice(7))
    return v4 != null ? isPrivateIpv4(v4) : false
  }
  const first = s.split(':')[0]
  if (!first) return false
  // fc00::/7（fc/fd 开头）唯一本地；fe80-febf 链路本地
  if (/^f[cd][0-9a-f]{2}$/.test(first)) return true
  if (/^fe[89ab][0-9a-f]$/.test(first)) return true
  return false
}

/**
 * 主机名字面量是否被禁止（黑名单 / 内网后缀 / 私网 IP 字面量）。
 * @param {string} hostname 小写主机名
 * @returns {boolean}
 */
export function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (BLOCKED_HOSTNAMES.has(host)) return true
  if (BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) return true
  const v4 = parseIpv4(host)
  if (v4 != null) return isPrivateIpv4(v4)
  if (host.includes(':')) return isPrivateIpv6(host)
  return false
}

/**
 * SSRF 第一层：创建/更新探针时校验 URL（纯字符串，双端共用）。
 * 规则：仅允许 https 协议；主机名不得命中内网/保留黑名单（含 IP 字面量与
 * 十进制/十六进制 IPv4 绕过写法）。
 * @param {string} url
 * @returns {{ok: boolean, error?: string, value?: {url: string, hostname: string}}}
 */
export function validateProbeUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return { ok: false, error: '探针 URL 不能为空' }
  if (raw.length > URL_MAX) return { ok: false, error: `探针 URL 长度不能超过 ${URL_MAX}` }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, error: '探针 URL 格式无效' }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: '探针 URL 仅允许 https 协议（SSRF 防护）' }
  }
  const hostname = String(parsed.hostname || '').toLowerCase()
  if (!hostname) return { ok: false, error: '探针 URL 缺少主机名' }
  if (isBlockedHostname(hostname)) {
    return { ok: false, error: `探针 URL 禁止指向内网/保留地址：${hostname}` }
  }
  return { ok: true, value: { url: parsed.toString(), hostname } }
}

/**
 * SSRF 第二层：执行时校验（Node 传 dns.lookup 解析出的 IP 数组；Worker 传 [] 跳过，
 * 仅保留第一层字面量兜底——Workers 不暴露 fetch 前的 DNS 解析）。
 * @param {string[]} ipList
 * @returns {{ok: boolean, error?: string}}
 */
export function assertIpsAllowed(ipList) {
  const ips = Array.isArray(ipList) ? ipList : []
  if (!ips.length) return { ok: true }
  for (const item of ips) {
    const ip = String(item || '').toLowerCase().split('%')[0]
    if (!ip) continue
    const v4 = parseIpv4(ip)
    if (v4 != null) {
      if (isPrivateIpv4(v4)) return { ok: false, error: `SSRF 拒绝：目标解析到私网地址 ${ip}` }
      continue
    }
    if (isPrivateIpv6(ip)) return { ok: false, error: `SSRF 拒绝：目标解析到私网地址 ${ip}` }
  }
  return { ok: true }
}

/**
 * 到期判断（tick 用）：due = 无 last_run_at 或 now - last_run_at >= interval*1000 - jitter。
 * @param {object} check 探针定义行（last_run_at / interval_seconds，snake_case 双端一致）
 * @param {number} now 当前毫秒时间戳
 * @param {number} [jitterMs=0] 容忍的提前量（毫秒）
 * @returns {boolean}
 */
export function isDue(check, now, jitterMs = 0) {
  const last = Number(check?.last_run_at)
  if (!Number.isFinite(last) || last <= 0) return true
  const intervalMs = Math.max(1, Number(check?.interval_seconds) || DEFAULT_INTERVAL_SECONDS) * 1000
  return now - last >= intervalMs - Number(jitterMs || 0)
}

/**
 * 失败原因摘要截断（落库 error 列，Q3 不落响应体原文）。
 * @param {string} text
 * @returns {string}
 */
export function clipError(text) {
  return String(text ?? '').slice(0, ERROR_MAX)
}

/**
 * 四步判定规则（PRD §5.2，双端同源；输入为已完成的 fetch 产物）：
 * ① fetch 抛错/超时 → fail|timeout；② 状态码 ≠ 期望 → fail；
 * ③ 配置 keyword 且响应体未命中 → fail；④ 通过但超时延阈值 → success + latencyExceeded。
 *
 * @param {object} params
 * @param {object} params.check 探针定义（expected_status / keyword / latency_threshold_ms）
 * @param {number|null} params.statusCode 响应状态码（网络错误为 null）
 * @param {string} params.bodySnippet 响应体片段（≤ BODY_SNIPPET_LIMIT，仅内存匹配）
 * @param {number} params.latencyMs 耗时（毫秒）
 * @param {Error|string|null} params.error fetch 异常（超时/网络错误）
 * @returns {{ok: boolean, outcome: 'success'|'fail'|'timeout', latencyExceeded: boolean, error: string|null}}
 */
export function evaluateProbe({ check, statusCode, bodySnippet, latencyMs, error } = {}) {
  // ① fetch 抛错 / 超时（AbortSignal.timeout 触发的 TimeoutError 含 abort 字样）
  if (error) {
    const message = clipError(typeof error === 'string' ? error : (error?.message || String(error)))
    return { ok: false, outcome: /timeout|abort/i.test(message) ? 'timeout' : 'fail', latencyExceeded: false, error: message || '网络错误' }
  }
  // ② 状态码断言
  const expected = Number(check?.expected_status ?? DEFAULT_EXPECTED_STATUS)
  const status = Number(statusCode)
  if (status !== expected) {
    return {
      ok: false,
      outcome: 'fail',
      latencyExceeded: false,
      error: `状态码 ${Number.isFinite(status) ? status : '无'} ≠ 期望 ${expected}`
    }
  }
  // ③ 关键词断言（bodySnippet 仅在服务端内存匹配，不落库原文，Q3）
  const keyword = check?.keyword ? String(check.keyword) : ''
  if (keyword && !String(bodySnippet ?? '').includes(keyword)) {
    return { ok: false, outcome: 'fail', latencyExceeded: false, error: '响应体未命中关键词' }
  }
  // ④ 通过；时延阈值 → success 但记 latency_exceeded（不计入失败）
  const threshold = check?.latency_threshold_ms
  const latencyExceeded = threshold != null
    && Number.isFinite(Number(threshold))
    && Number(latencyMs) > Number(threshold)
  return { ok: true, outcome: 'success', latencyExceeded, error: null }
}

/**
 * 参数收敛（创建/更新时双端共用，杜绝两端校验漂移）。
 * 同时兼容 camelCase（API body）与 snake_case（DB 行回填编辑）两种入参风格。
 * @param {object} input
 * @returns {{ok: boolean, value?: object, error?: string}}
 */
export function normalizeCheckInput(input = {}) {
  const name = String(input.name || '').trim().slice(0, NAME_MAX)
  if (!name) return { ok: false, error: '探针名称不能为空' }
  const urlCheck = validateProbeUrl(input.url)
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error }

  const intervalSeconds = Number(input.intervalSeconds ?? input.interval_seconds ?? DEFAULT_INTERVAL_SECONDS)
  if (!PROBE_INTERVALS.includes(intervalSeconds)) {
    return { ok: false, error: `探测间隔仅允许 ${PROBE_INTERVALS.join(' / ')} 秒` }
  }

  let timeoutMs = Math.round(Number(input.timeoutMs ?? input.timeout_ms ?? DEFAULT_TIMEOUT_MS))
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS
  timeoutMs = Math.max(TIMEOUT_MS_MIN, Math.min(TIMEOUT_MS_MAX, timeoutMs))

  const expectedStatus = Math.round(Number(input.expectedStatus ?? input.expected_status ?? DEFAULT_EXPECTED_STATUS))
  if (!Number.isFinite(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
    return { ok: false, error: '期望状态码须为 100–599 的整数' }
  }

  let keyword = String(input.keyword ?? '').trim()
  if (keyword.length > KEYWORD_MAX) keyword = keyword.slice(0, KEYWORD_MAX)

  let latencyThresholdMs = null
  const latencyInput = input.latencyThresholdMs ?? input.latency_threshold_ms
  if (latencyInput != null && latencyInput !== '') {
    const n = Math.round(Number(latencyInput))
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: '时延阈值须为正整数（毫秒）' }
    latencyThresholdMs = n
  }

  let failThreshold = Math.round(Number(input.failThreshold ?? input.fail_threshold ?? DEFAULT_FAIL_THRESHOLD))
  if (!Number.isFinite(failThreshold) || failThreshold < 1) failThreshold = DEFAULT_FAIL_THRESHOLD
  failThreshold = Math.min(FAIL_THRESHOLD_MAX, failThreshold)

  // 首版仅支持 GET（PRD FR-1 method 默认 GET）
  const method = 'GET'
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled)

  return {
    ok: true,
    value: {
      name,
      url: urlCheck.value.url,
      method,
      intervalSeconds,
      timeoutMs,
      expectedStatus,
      keyword: keyword || null,
      latencyThresholdMs,
      failThreshold,
      enabled
    }
  }
}
