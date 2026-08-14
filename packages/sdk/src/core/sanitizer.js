/**
 * @file Privacy v2 —— 统一 sanitizer 引擎
 *
 * 作为隐私清洗的唯一事实来源（single source of truth），覆盖：
 * - 事件字段脱敏（props / context / breadcrumbs / message）
 * - 「值级」PII 文本脱敏（邮箱 / 手机号 / 身份证 / 银行卡 / JWT）
 * - 用户手机号不可逆 hash（默认不发送明文）
 * - URL query 敏感参数剥离（balanced 仅剥敏感键，strict 丢弃整个 query）
 * - 请求 / 响应 Header 默认丢弃 Authorization / Cookie / Set-Cookie / Proxy-Authorization
 * - 请求 / 响应 body 默认脱敏（支持自定义 requestResponseSanitizer 钩子）
 * - 三档策略 strict | balanced | off（生产环境默认 balanced）
 * - 同意分类（essential / performance / analytics / replay / diagnostics）与 GPC / DNT 策略映射
 *
 * 使用：`const sanitizer = createSanitizer(cfg.privacy)`，
 * 之后在 `push` 中调用 `sanitizer.sanitizeEvent(event)`，在各采集模块中调用
 * `sanitizeText` / `sanitizePair` / `userPhone` / `hashIdentifier` 等。
 */

/** 隐私策略档位 */
export const PRIVACY_MODES = ['off', 'balanced', 'strict']

/** 同意分类 */
export const CONSENT_CATEGORIES = ['essential', 'performance', 'analytics', 'replay', 'diagnostics']

/** 默认脱敏字段（事件对象 key 大小写不敏感匹配） */
export const DEFAULT_REDACT_KEYS = [
  'password', 'passwd', 'pwd', 'token', 'secret', 'authorization', 'cookie',
  'apikey', 'api_key', 'accesskey', 'access_key', 'privatekey', 'private_key',
  'credential', 'idtoken', 'id_token', 'refreshtoken', 'refresh_token'
]

/** 默认丢弃的请求 / 响应头（大小写不敏感匹配） */
export const DEFAULT_DROP_HEADERS = ['authorization', 'cookie', 'set-cookie', 'proxy-authorization']

/** URL query 中默认剥离的敏感参数名（大小写不敏感） */
export const DEFAULT_SENSITIVE_QUERY_KEYS = [
  'password', 'passwd', 'pwd', 'token', 'secret', 'authorization', 'cookie',
  'apikey', 'api_key', 'accesskey', 'access_key', 'code', 'otp', 'auth',
  'key', 'sign', 'signature', 'jwt', 'sessionid', 'session_id',
  'phone', 'mobile', 'idcard', 'id_card', 'idnumber', 'id_number', 'cvv'
]

/**
 * 文本中的 PII 模式（仅匹配典型形态，避免误伤普通文本）：
 * - 邮箱
 * - 中国大陆手机号（11 位）
 * - 身份证号（18 位，末位可为 X）
 * - 银行卡号（16–19 位连续数字）
 * - JWT（三段 base64url）
 * 所有模式均带边界断言，避免把普通长数字串误判。
 */
const PII_PATTERNS = [
  { name: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  { name: 'phone', re: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g },
  { name: 'idcard', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { name: 'bankcard', re: /(?<!\d)\d{16,19}(?!\d)/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g }
]

/**
 * 对字符串中的 PII 形态做正则脱敏（邮箱 / 手机号 / 身份证 / 银行卡 / JWT）。
 * 非字符串或空串直接返回。
 * @param {string} value
 * @returns {string}
 */
export function redactPiiText(value) {
  if (typeof value !== 'string' || !value) return value
  let out = value
  for (const { re } of PII_PATTERNS) out = out.replace(re, '[REDACTED]')
  return out
}

/**
 * 不可逆 hash：FNV-1a 32 位 + 长度信息，用于把手机号等标识转换为不可还原的代称。
 * 供 userPhone / 选项 label 等场景使用，避免发送明文。
 * @param {string} value
 * @param {string} [salt='web-collection']
 * @returns {string}
 */
export function hashIdentifier(value, salt = 'web-collection') {
  if (value == null || value === '') return value
  const str = String(value)
  let h = 0x811c9dc5
  const data = `${salt}:${str}`
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `h_${(h >>> 0).toString(36)}${str.length.toString(36)}`
}

/**
 * 递归脱敏对象 / 数组中的敏感字段。
 * - 深度限制 4 层，数组和对象最多遍历 100 项，防止死循环与超大结构。
 * - key 命中 redactKeys（大小写不敏感）时整体替换为 [REDACTED]。
 * - redactPii=true 时，对所有字符串叶子值再做 PII 文本脱敏（精准匹配，不误伤普通文本）。
 * @param {*} value
 * @param {string[]} [redactKeys=DEFAULT_REDACT_KEYS]
 * @param {number} [depth=0]
 * @param {boolean} [redactPii=false]
 * @returns {*}
 */
export function redactObject(value, redactKeys = DEFAULT_REDACT_KEYS, depth = 0, redactPii = false) {
  if (depth > 4 || value == null) return value
  if (typeof value === 'string') return redactPii ? redactPiiText(value) : value
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactObject(item, redactKeys, depth + 1, redactPii))
  if (typeof value !== 'object') return value
  const keys = new Set(redactKeys.map(key => String(key).toLowerCase()))
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        keys.has(key.toLowerCase()) ? '[REDACTED]' : redactObject(item, redactKeys, depth + 1, redactPii)
      ])
  )
}

/**
 * 对文本中出现的敏感 key=value 模式做正则脱敏（处理 message 中的 "password=abc" 等）。
 * @param {string} value
 * @param {string[]} keys
 * @returns {string}
 */
export function redactText(value, keys) {
  const pattern = keys.map(key => String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return pattern ? value.replace(new RegExp(`(${pattern})([=: ]+)[^,; ]+`, 'gi'), '$1$2[REDACTED]') : value
}

/**
 * 剥离 URL 中的敏感 query 参数（balanced）或整个 query 串（strict）。
 * @param {string} url
 * @param {string} mode
 * @param {string[]} [sensitiveKeys=DEFAULT_SENSITIVE_QUERY_KEYS]
 * @returns {string}
 */
export function sanitizeUrl(url, mode, sensitiveKeys = DEFAULT_SENSITIVE_QUERY_KEYS) {
  if (typeof url !== 'string' || !url) return url
  if (mode === 'strict') {
    // 严格模式：丢弃整个 query string，仅保留 hash
    return url.replace(/\?[^#]*/, '')
  }
  try {
    const base = typeof location !== 'undefined' && location?.href ? location.href : 'http://localhost/'
    const u = new URL(url, base)
    const keys = new Set(sensitiveKeys.map(k => k.toLowerCase()))
    // 先收集需要剥离的键，避免在 forEach 中删除导致迭代跳过相邻条目。
    const toDelete = []
    u.searchParams.forEach((_v, k) => { if (keys.has(k.toLowerCase())) toDelete.push(k) })
    if (!toDelete.length) return url
    for (const k of toDelete) u.searchParams.delete(k)
    return u.toString()
  } catch {
    return url
  }
}

/**
 * 丢弃 headers 中的敏感键（大小写不敏感）。
 * @param {Record<string, string>|undefined} headers
 * @param {string[]} [dropHeaders=DEFAULT_DROP_HEADERS]
 * @returns {Record<string, string>|undefined}
 */
export function sanitizeHeaders(headers, dropHeaders = DEFAULT_DROP_HEADERS) {
  if (!headers || typeof headers !== 'object') return headers
  const drops = new Set(dropHeaders.map(h => h.toLowerCase()))
  const result = {}
  for (const [k, v] of Object.entries(headers)) {
    if (drops.has(k.toLowerCase())) continue
    result[k] = v
  }
  return result
}

/**
 * 脱敏单个 body（字符串尝试 JSON 解析后按 key / PII 清洗；对象直接递归；其余原样）。
 * @param {*} body
 * @param {string[]} redactKeys
 * @param {boolean} redactPii
 * @returns {*}
 */
function redactBody(body, redactKeys, redactPii) {
  if (body == null) return body
  if (typeof body === 'string') {
    const trimmed = body.trimStart()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(redactObject(JSON.parse(body), redactKeys, 0, redactPii))
      } catch {}
    }
    return redactPii ? redactPiiText(body) : body
  }
  if (typeof body === 'object') return redactObject(body, redactKeys, 0, redactPii)
  return body
}

/**
 * 解析同意分类，结合全局 consent 与浏览器 GPC / DNT 信号。
 * - 全局 consent='denied' 时，仅保留 essential（SDK 基础运行所需），其余一律拒绝。
 * - 浏览器发出 GPC / DNT 信号且用户未显式允许对应分类时，
 *   analytics / replay / diagnostics 降级为拒绝（尊重「不要追踪」）。
 * @param {{ consent?: string, consentCategories?: Record<string, boolean> }} [config={}]
 * @param {{ globalPrivacyControl?: boolean, doNotTrack?: string }|Window['navigator']} [navigatorLike={}]
 * @returns {Record<string, boolean>}
 */
export function resolveConsent(config = {}, navigatorLike = {}) {
  const explicit = config.consentCategories || {}
  const categories = {
    essential: true,
    performance: true,
    analytics: explicit.analytics !== undefined ? explicit.analytics : true,
    replay: explicit.replay !== undefined ? explicit.replay : true,
    diagnostics: explicit.diagnostics !== undefined ? explicit.diagnostics : true
  }
  const gpc = navigatorLike?.globalPrivacyControl === true
  const dnt = navigatorLike?.doNotTrack === '1' || navigatorLike?.doNotTrack === 'yes' || navigatorLike?.doNotTrack === 'true'
  if (gpc || dnt) {
    // 尊重「不要追踪」信号：仅在分类未被用户显式授权（默认 true）时降级为拒绝。
    if (explicit.analytics !== true) categories.analytics = false
    if (explicit.replay !== true) categories.replay = false
    if (explicit.diagnostics !== true) categories.diagnostics = false
  }
  if (config.consent === 'denied') {
    categories.essential = true
    categories.performance = false
    categories.analytics = false
    categories.replay = false
    categories.diagnostics = false
  }
  return categories
}

/**
 * 创建隐私 sanitizer 实例。
 *
 * 两级分类（与项目"全采集、入库全量、脱敏在下游"原则对齐，见 ADR-007）：
 * - 第一级 · 凭据（credentials）：password/token/secret/authorization/cookie/apikey/privatekey/jwt…
 *   及其对应请求头（Authorization/Cookie/Set-Cookie/Proxy-Authorization）。这类**不是遥测数据**，
 *   下游无合法分析用途，明文存储是安全 / 合规负债，因此**在所有档位（含 off）下都常驻剥离**。
 *   这是有意的 carve-out，不违反"采集层不丢弃"原则（原则针对行为 / 观测遥测，不含凭证）。
 * - 第二级 · 通用 PII（general PII）：自由文本中的邮箱 / 手机 / 身份证 / 银行卡 / JWT、
 *   表单值、URL query 敏感参数、请求 / 响应 body PII。这部分**受 mode 控制**：
 *   balanced / strict 在采集层脱敏；off 保留原文供全量采集。
 *
 * 默认 balanced 是**显式且刻意的隐私安全出厂默认**（非隐式），off 是显式 opt-in ——
 * 用于需要原始第二级 PII、且已具备下游（查询层）按角色脱敏能力的应用。
 *
 * @param {object} [privacy={}]
 * @param {('off'|'balanced'|'strict')} [privacy.mode='balanced']
 * @param {string[]} [privacy.redactKeys=[]]        - 额外脱敏字段名
 * @param {string[]} [privacy.dropHeaders]          - 额外丢弃的请求 / 响应头
 * @param {string[]} [privacy.sensitiveQueryKeys]   - 额外剥离的 URL query 参数名
 * @param {string}   [privacy.hashSalt='web-collection']
 * @param {boolean}  [privacy.textRedaction=true]   - 是否对文本做 PII 脱敏
 * @param {Function} [privacy.requestResponseSanitizer] - 自定义请求/响应清洗钩子 (pair) => pair
 * @returns {object} sanitizer 实例
 */
export function createSanitizer(privacy = {}) {
  const raw = privacy && typeof privacy === 'object' ? privacy : {}
  const mode = PRIVACY_MODES.includes(raw.mode) ? raw.mode : 'balanced'
  const redactKeys = [...DEFAULT_REDACT_KEYS, ...(Array.isArray(raw.redactKeys) ? raw.redactKeys : [])]
  const dropHeaders = [...new Set([...DEFAULT_DROP_HEADERS, ...(Array.isArray(raw.dropHeaders) ? raw.dropHeaders : [])])]
  const sensitiveQueryKeys = [...new Set([...DEFAULT_SENSITIVE_QUERY_KEYS, ...(Array.isArray(raw.sensitiveQueryKeys) ? raw.sensitiveQueryKeys : [])])]
  const textRedaction = raw.textRedaction !== false
  const hashSalt = typeof raw.hashSalt === 'string' && raw.hashSalt ? raw.hashSalt : 'web-collection'
  const requestResponseSanitizer = typeof raw.requestResponseSanitizer === 'function' ? raw.requestResponseSanitizer : null
  const redactPii = mode !== 'off' && textRedaction

  /** 对事件整体做隐私清洗 */
  function sanitizeEvent(event) {
    if (!event || typeof event !== 'object') return event
    const result = { ...event }
    if (result.props) result.props = redactObject(result.props, redactKeys, 0, redactPii)
    if (result.context) result.context = redactObject(result.context, redactKeys, 0, redactPii)
    if (result.breadcrumbs) result.breadcrumbs = redactObject(result.breadcrumbs, redactKeys, 0, redactPii)
    if (typeof result.message === 'string' && redactPii) result.message = redactPiiText(result.message)
    // 用户手机号：balanced / strict 默认不可逆 hash，不发明文
    if (result.userPhone && mode !== 'off') result.userPhone = hashIdentifier(result.userPhone, hashSalt)
    // URL query 敏感参数剥离 / 严格模式丢弃整个 query
    if (typeof result.url === 'string' && result.url) result.url = sanitizeUrl(result.url, mode, sensitiveQueryKeys)
    return result
  }

  /** 对 DOM 文本 / 点击 label / 自定义事件文本做 PII 脱敏（off 模式原样返回） */
  function sanitizeText(text) {
    if (!textRedaction) return text
    return redactPiiText(text)
  }

  /** 丢弃敏感请求 / 响应头 */
  function sanitizeHeadersFn(headers) {
    return sanitizeHeaders(headers, dropHeaders)
  }

  /**
   * 清洗一对请求 / 响应（用于 body 采样）。
   * 优先使用自定义 requestResponseSanitizer；否则默认丢弃敏感头并对 body 做字段 / PII 脱敏。
   * @param {{ url?: string, requestHeaders?: object, responseHeaders?: object, requestBody?: *, responseBody?: * }} pair
   * @returns {object}
   */
  function sanitizePair(pair = {}) {
    if (requestResponseSanitizer) {
      try {
        const out = requestResponseSanitizer({ ...pair })
        if (out && typeof out === 'object') return out
      } catch {}
    }
    const cleaned = { ...pair }
    if ('requestHeaders' in cleaned) cleaned.requestHeaders = sanitizeHeaders(cleaned.requestHeaders, dropHeaders)
    if ('responseHeaders' in cleaned) cleaned.responseHeaders = sanitizeHeaders(cleaned.responseHeaders, dropHeaders)
    cleaned.requestBody = redactBody(cleaned.requestBody, redactKeys, redactPii)
    cleaned.responseBody = redactBody(cleaned.responseBody, redactKeys, redactPii)
    return cleaned
  }

  /** 用户手机号不可逆 hash（off 模式原样返回） */
  function userPhone(phone) {
    if (!phone || mode === 'off') return phone
    return hashIdentifier(phone, hashSalt)
  }

  /** 通用不可逆 hash，用于选项 label 等受控标识 */
  function hashIdentifierFn(value) {
    return hashIdentifier(value, hashSalt)
  }

  return {
    mode,
    config: { redactKeys, dropHeaders, sensitiveQueryKeys, hashSalt, textRedaction },
    sanitizeEvent,
    sanitizeText,
    sanitizeHeaders: sanitizeHeadersFn,
    sanitizePair,
    userPhone,
    hashIdentifier: hashIdentifierFn
  }
}
