/**
 * @file D2 认证加密原语（Node 与 Cloudflare Worker nodejs_compat 同源可用，零第三方依赖）
 * - 口令：scrypt 加盐哈希，自描述串 scrypt$N$r$p$saltB64$hashB64（绝不存明文/可逆）
 * - 会话访问令牌：紧凑 HS256 JWT（≤2h），密钥来自 ACCOUNTS_JWT_SECRET
 * - 不透明令牌：randomToken()（邀请链接 / 刷新令牌），库内只存 sha256Hex()
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64

/** 口令哈希（scrypt，返回自描述串） */
export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(password), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

/** 口令校验（timingSafeEqual 恒时比较；格式不符返回 false 不抛错） */
export function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = String(stored || '').split('$')
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const actual = scryptSync(String(password), salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/**
 * 签发紧凑 HS256 JWT。
 * @param {object} payload - 已含 sub/sid 等声明；exp 由 expiresInSec 自动补
 * @param {string} secret - HMAC 密钥（ACCOUNTS_JWT_SECRET）
 * @param {number} expiresInSec - 有效期（秒，≤2h）
 */
export function signJwt(payload, secret, expiresInSec = 7200) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSec }))
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

/** 校验 JWT（签名 + 过期），失败返回 null 不抛错 */
export function verifyJwt(token, secret) {
  try {
    const [header, body, sig] = String(token || '').split('.')
    if (!header || !body || !sig) return null
    const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

/** 生成不透明随机令牌（邀请链接 / 刷新令牌），URL 安全 */
export function randomToken(bytes = 32) { return randomBytes(bytes).toString('base64url') }

/** 令牌入库前的哈希（库内只存哈希，泄露库不泄露可用令牌） */
export function sha256Hex(value) { return createHash('sha256').update(String(value)).digest('hex') }
