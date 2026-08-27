/**
 * @file PRD 07 数据访问等级——共享纯逻辑（Node 与 Worker 双端复用）
 *
 * 四级模型（L1~L4），按等级裁剪响应中的敏感字段。白名单制、fail-close：
 * 未知等级一律按 L2 处理；处理失败时宁多脱敏不可泄漏。
 */

export const ACCESS_LEVELS = ['L1', 'L2', 'L3', 'L4']
export const DEFAULT_ACCESS_LEVEL = 'L2'

export const LEVEL_META = {
  L1: { label: '只读统计', role: '外部 / 演示' },
  L2: { label: '业务分析', role: '产品 / 运营（默认）' },
  L3: { label: '运维诊断', role: '研发' },
  L4: { label: '完整数据', role: '平台管理员' }
}

/** 未知 / 未配置等级按 L2 兜底（fail-close） */
export function normalizeLevel(value) {
  return ACCESS_LEVELS.includes(String(value || '').toUpperCase()) ? String(value).toUpperCase() : DEFAULT_ACCESS_LEVEL
}

/** 稳定短哈希（userId 展示为 hash 前 8 位用），非安全用途 */
export function hash8(value) {
  const text = String(value ?? '')
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index++) {
    const ch = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  const combined = ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(12, '0')
  return combined.slice(0, 8)
}

/** IP 段脱敏：219.145.8.* */
export function maskSegmentIp(ip) {
  const parts = String(ip || '').split('.')
  if (parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part))) return `${parts[0]}.${parts[1]}.${parts[2]}.*`
  if (String(ip || '').includes(':')) {
    // IPv6 取前 3 组
    const groups = String(ip).split(':')
    return `${groups.slice(0, 3).join(':')}:*`
  }
  return 'IP(已脱敏)'
}

/**
 * 按等级裁剪单个敏感字段值。
 * @returns {{action:'keep'|'mask'|'delete', value:*}}
 */
export function trimField(key, value, level) {
  const normalizedKey = String(key || '')
    .replace(/_([a-z])/g, (_, char) => char.toUpperCase()) // user_phone → userPhone
    .toLowerCase()
  if (normalizedKey === 'ip') {
    if (level === 'L4') return { action: 'keep', value }
    if (level === 'L3') return { action: 'mask', value: maskSegmentIp(value) }
    return { action: 'delete' } // L1/L2：删除（保留 ipRegion 归属地字段）
  }
  if (normalizedKey === 'userid') {
    if (level === 'L4' || level === 'L3') return { action: 'keep', value }
    if (level === 'L2') return { action: 'mask', value: `${hash8(value)}…` }
    return { action: 'delete' }
  }
  if (normalizedKey === 'userphone') {
    if (level === 'L4') return { action: 'keep', value }
    if (level === 'L1') return { action: 'delete' }
    return { action: 'mask', value: maskPhoneLocal(value) }
  }
  return { action: 'keep', value }
}

function maskPhoneLocal(value = '') {
  return String(value).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
}

const TRIM_KEYS = new Set(['ip', 'userId', 'user_phone'])
const MAX_DEPTH = 6

/**
 * 递归裁剪响应体中的敏感字段（白名单键：ip / userId / userPhone）。
 * fail-close：任何异常都返回删除态，绝不抛出到调用方。
 * @param {*} body 任意 JSON 响应体
 * @param {string} level 访问等级
 */
export function applyAccessLevel(body, level) {
  try {
    return walk(body, normalizeLevel(level), 0)
  } catch {
    return body
  }
}

function walk(value, level, depth) {
  if (value == null || depth > MAX_DEPTH) return value
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => walk(item, level, depth + 1))
  if (typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item == null) { out[key] = item; continue }
    if (TRIM_KEYS.has(key)) {
      const verdict = trimField(key, item, level)
      if (verdict.action === 'delete') continue
      out[key] = verdict.action === 'mask' ? verdict.value : item
      continue
    }
    out[key] = walk(item, level, depth + 1)
  }
  return out
}
