/**
 * @file PII 脱敏与敏感信息守卫
 *
 * 从 Cloudflare worker.js 抽取并统一导出（worker 与 ai-service 共享）。
 * 海外通道（overseas）调用前必须 maskPII 强脱敏，避免堆栈/用户信息出境。
 */
export function clip(v, n) { return String(v ?? '').slice(0, n) }
export function parse(value, fallback) { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback } catch { return fallback } }
export function maskPhone(v = '') { return String(v).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') }

export function cleanUrl(value) {
  try {
    const u = new URL(String(value))
    for (const key of ['token', 'password', 'key', 'secret', 'authorization']) u.searchParams.delete(key)
    return clip(u.toString(), 2048)
  } catch { return clip(value || '', 2048) }
}

/** 通用字段名/请求头/JSON 值脱敏（沿用 worker redact） */
export function redact(v) {
  return String(v)
    .replace(/(authorization|password|token|secret|cookie)(["'\s:=]+)[^\s,;}]+/gi, '$1$2[REDACTED]')
    .replace(/\b1\d{2}\d{4}(\d{4})\b/g, '***$1')
}

/**
 * 海外通道专用强脱敏：手机号、邮箱、身份证、URL query 参数、
 * Token/密钥、user_id/user_phone 全量掩码。对文本中的常见 PII 做保守替换。
 */
export function maskPII(text) {
  let out = String(text ?? '')
  // 手机号（中国大陆 1xx 开头 11 位）
  out = out.replace(/\b1[3-9]\d{9}\b/g, '[MASKED_PHONE]')
  // 邮箱
  out = out.replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, '[MASKED_EMAIL]')
  // 身份证（18 位，含 X）
  out = out.replace(/\b\d{17}[\dXx]\b/g, '[MASKED_ID]')
  // URL 中的敏感 query 参数值
  out = out.replace(/([?&](?:token|password|secret|key|authorization|sign|sig|api_key|apikey)=)[^&\s"]*/gi, '$1[MASKED]')
  // 常见 Token/密钥：长随机串（32+ 位 hex/base64 风格）
  out = out.replace(/\b(?:ey[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}|[A-Za-z0-9_-]{40,})\b/g, '[MASKED_TOKEN]')
  // 暴露 userId / user_phone 字段
  out = out.replace(/("?user_id"?\s*[:=]\s*"?)[^",}]+/gi, '$1[MASKED_USER]')
  out = out.replace(/("?user_phone"?\s*[:=]\s*"?)[^",}]+/gi, '$1[MASKED_USER]')
  return out
}
