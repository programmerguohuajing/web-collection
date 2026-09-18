/**
 * AI Provider URL 安全校验：阻断凭据外送、明显 SSRF 与不安全 URL。
 */
export function validateProviderBaseUrl(value, { allowPrivate = false } = {}) {
  const text = String(value || '').trim()
  if (!text) return null
  let url
  try { url = new URL(text) } catch { throw new Error('baseUrl 必须是合法 URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('baseUrl 只允许 http/https')
  if (url.username || url.password) throw new Error('baseUrl 不允许携带用户名或密码')

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isMetadataHost(host) || isLinkLocal(host)) throw new Error('baseUrl 禁止访问云元数据或链路本地地址')
  if (!allowPrivate && isPrivateHost(host)) throw new Error('baseUrl 禁止访问 localhost/私网地址')
  return url
}

export function sameProviderOrigin(a, b) {
  if (!a || !b) return false
  try {
    return new URL(String(a)).origin.toLowerCase() === new URL(String(b)).origin.toLowerCase()
  } catch {
    return false
  }
}
function isPrivateHost(host) {
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true
  const m = /^172\.(\d{1,3})\./.exec(host)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  if (/^0\./.test(host) || host === '0.0.0.0') return true
  if (/^fc/i.test(host) || /^fd/i.test(host)) return true
  return false
}

function isLinkLocal(host) {
  if (/^169\.254\./.test(host)) return true
  if (/^fe8/i.test(host) || /^fe9/i.test(host) || /^fea/i.test(host) || /^feb/i.test(host)) return true
  return false
}

function isMetadataHost(host) {
  return host === '169.254.169.254' ||
    host === 'metadata.google.internal' ||
    host === 'metadata.google' ||
    host === 'instance-data.ec2.internal'
}
