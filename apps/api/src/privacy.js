/**
 * @file 后端查询层隐私脱敏（mask-at-query）
 *
 * 与 SDK 的 sanitizer（src/core/sanitizer.js）保持同一套 PII 规则，作为
 * 「查询侧安全网」：当某应用以 raw 模式全量采集（SDK off 档）入库原文时，
 * 后端在响应边界按查看者授权情况掩码；对 balanced 档（SDK 采集层已脱敏）
 * 则是幂等兜底。
 *
 * 设计依据见 ADR-007（outputs/adr-privacy-collection-layer.md）：
 * - 凭据类（password/token/secret/...）在任何档位都不应明文出现在响应里。
 * - 通用 PII（邮箱/手机/身份证/银行卡/JWT）默认掩码；授权查看者（raw-access）
 *   可看原文，由上游 RBAC / 角色体系决定，此处先用最小可行的 token 闸门。
 *
 * 部署决策（2026-08-14 用户拍板）：
 * - 当前部署**不做查看者权限分级**——任何能访问 API 的调用方都视为可查看原文。
 *   因此查询侧脱敏**默认关闭**（queryMaskingEnabled()===false），中间件为 pass-through；
 *   通过环境变量 EYS_QUERY_MASKING=on 可重新启用 mask-at-query，未来接入 RBAC 时再细分角色。
 * - raw PII 入库仅对**新建且显式开启 raw** 的应用生效；存量应用隐私档位保持 balanced
 *   （SDK 采集层已脱敏，DB 无裸 PII），不受影响。
 *
 * 本模块为纯函数，不依赖数据库连接，可独立单测。
 */

import { timingSafeEqual } from 'node:crypto'

/**
 * 文本中的 PII 模式（与 SDK sanitizer.js 的 PII_PATTERNS 对齐）。
 * 所有模式均带边界断言，避免把普通长数字串误判。
 */
const PII_PATTERNS = [
  { name: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  { name: 'phone', re: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g },
  { name: 'idcard', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { name: 'bankcard', re: /(?<!\d)\d{16,19}(?!\d)/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g }
]

/** 凭据类字段名（大小写不敏感匹配），命中即整字段替换为 [REDACTED]。 */
export const CREDENTIAL_KEYS = new Set([
  'password', 'passwd', 'pwd', 'token', 'secret', 'authorization', 'cookie',
  'apikey', 'api_key', 'accesskey', 'access_key', 'privatekey', 'private_key',
  'credential', 'idtoken', 'id_token', 'refreshtoken', 'refresh_token',
  'jwt', 'sessionid', 'session_id'
])

const MAX_DEPTH = 4
const MAX_ITEMS = 100

/**
 * 对字符串中的 PII 形态做正则脱敏（邮箱 / 手机号 / 身份证 / 银行卡 / JWT）。
 * 与 SDK redactPiiText 行为一致：命中即整体替换为 [REDACTED]。
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
 * 递归脱敏对象 / 数组中的敏感字段（查询侧安全网，始终启用 PII 掩码）。
 * - 深度限制 MAX_DEPTH 层，数组和对象最多遍历 MAX_ITEMS 项，防止死循环与超大结构。
 * - key 命中 CREDENTIAL_KEYS（大小写不敏感）时整体替换为 [REDACTED]。
 * - 字符串叶子值统一做 PII 文本脱敏。
 * @param {*} value
 * @param {number} [depth=0]
 * @returns {*}
 */
export function maskValue(value, depth = 0) {
  if (depth > MAX_DEPTH || value == null) return value
  if (typeof value === 'string') return redactPiiText(value)
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(item => maskValue(item, depth + 1))
  if (typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
    out[key] = CREDENTIAL_KEYS.has(String(key).toLowerCase()) ? '[REDACTED]' : maskValue(item, depth + 1)
  }
  return out
}

/**
 * 查询侧脱敏是否启用。
 * 默认关闭：当前部署模型为「访问即查看原文」（无查看者权限分级，见 ADR-007
 * 2026-08-14 决策），故对所有 /api 查询响应不做掩码，调用方看到入库原文。
 * 设为 'on'（环境变量 EYS_QUERY_MASKING=on）即重新启用 mask-at-query，
 * 配合 isAuthorizedRaw 的 raw-access 令牌做角色级掩码，便于未来接入 RBAC。
 * @returns {boolean}
 */
export function queryMaskingEnabled() {
  return process.env.EYS_QUERY_MASKING === 'on'
}

/**
 * 判断当前请求是否被授权查看原始（未脱敏）PII。仅在查询侧脱敏启用
 * （queryMaskingEnabled()===true）时生效；当前默认关闭，故本函数为占位。
 * 最小可行模型：当环境变量 EYS_RAW_ACCESS_TOKEN 已配置时，要求请求头
 * `x-eys-raw-access` 与其常量时间相等；未配置时一律视为未授权（掩码）。
 *
 * 注意：这是 RBAC / 查看者角色体系的临时替代，后续应替换为真实的
 * 用户角色 / 权限校验（见 ADR-007 Open Questions）。
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isAuthorizedRaw(req) {
  const expected = process.env.EYS_RAW_ACCESS_TOKEN
  if (!expected) return false
  const provided = req.get('x-eys-raw-access') || ''
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 不启用查询侧掩码的路由前缀（写入 / 配置 / 静态类）。 */
export const MASK_SKIP_PREFIXES = [
  '/api/collect', '/api/collect.gif', '/api/spans', '/api/sourcemaps',
  '/api/internal', '/api/capabilities', '/api/settings', '/api/applications',
  '/api/alert-channels', '/api/alert-deliveries', '/api/maintenance', '/api/sdk'
]

/**
 * 构造查询侧隐私脱敏中间件。
 * - 默认（queryMaskingEnabled()===false）为 pass-through：访问即查看原文。
 * - 启用时（EYS_QUERY_MASKING=on）：对所有 /api 查询响应递归掩码 PII 与凭据字段；
 *   命中 MASK_SKIP_PREFIXES 或为授权查看者（isAuthorizedRaw）时跳过。
 * @param {{ skipPrefixes?: string[] }} [options]
 * @returns {import('express').RequestHandler}
 */
export function createMaskingMiddleware(options = {}) {
  const skipPrefixes = options.skipPrefixes || MASK_SKIP_PREFIXES
  return (req, res, next) => {
    if (!queryMaskingEnabled()) return next() // 部署决策：访问即看原文，默认不掩码
    const path = req.path
    const skip = !path.startsWith('/api/') || skipPrefixes.some(prefix => path.startsWith(prefix))
    if (skip || isAuthorizedRaw(req)) return next()
    const originalJson = res.json.bind(res)
    res.json = (body) => originalJson(maskValue(body))
    next()
  }
}
