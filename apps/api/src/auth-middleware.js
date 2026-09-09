/**
 * @file D2 身份中间件（PRD 09 附录 A 授权判定落地）
 * 在 masking / access-level 中间件之前解析 req.auth = { userId, email, teamId, role, level, via, sessionId }。
 * - via='session'：Bearer JWT（≤2h，含 sid）→ 校验服务端会话未撤销（登出即刻生效，D8）
 * - via='api_key'：x-api-key 匹配 ADMIN_API_KEY → 虚拟主体 system（owner/L4），操作均写审计
 * - accounts=false（默认）：no-op，req.auth=null，存量行为零变化
 * teamId 来自请求头 x-team-id（UI 下拉切换团队无需重发令牌），缺省取用户首个团队。
 */
import { first } from './db.js'
import { verifyJwt, sha256Hex } from '../../../packages/auth-crypto.js'
import { timingSafeEqual } from 'node:crypto'
import { isAccountsEnabled, isAccountsEnforced } from './services/auth-service.js'
import { getActiveSession } from './services/session-service.js'
import { normalizeLevel } from '../../../packages/access-level.js'

/** 免鉴权前缀（采集/静态/健康/公开端点，沿用 MASK_SKIP_PREFIXES 思路 + D2 公开端点） */
const AUTH_PUBLIC_PREFIXES = [
  '/api/collect',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/dashboards/shared/',
  '/api/capabilities',
  '/api/invitations/',
  '/api/brand'
]

/** 身份解析中间件：恒挂载（accounts=false 时为透传） */
export function identityMiddleware(req, res, next) {
  resolveAuth(req)
    .then(auth => {
      req.auth = auth
      // 严格模式（ACCOUNTS_ENFORCE=1）：accounts 开启后，受控管理接口未登录 → 401
      if (!auth && isAccountsEnabled() && isAccountsEnforced() && requiresAuth(req.path)) {
        return res.status(401).json({ error: '未登录或会话已失效' })
      }
      next()
    })
    .catch(err => {
      // JWT 密钥未配置等配置错误：不静默放行也不炸整站，按 503 暴露配置问题
      if (err && err.code === 'ACCOUNTS_JWT_SECRET_MISSING') return res.status(503).json({ error: err.message })
      next(err)
    })
}

function requiresAuth(path) {
  if (!path.startsWith('/api/')) return false
  return !AUTH_PUBLIC_PREFIXES.some(prefix => path.startsWith(prefix))
}

/** 解析请求身份；无凭据/未开启返回 null（不抛错，配置缺失除外） */
export async function resolveAuth(req) {
  if (!isAccountsEnabled()) return null
  const bearer = readBearer(req)
  if (bearer) {
    const payload = verifyJwt(bearer, jwtSecretValue())
    if (payload?.sub && payload.sid) {
      const session = await getActiveSession(payload.sid)
      if (session) {
        const user = await first('select id, email, status from users where id = ? and status = ?', [payload.sub, 'active'])
        if (user) return buildContext(req, { userId: user.id, email: user.email, sessionId: session.id, via: 'session' })
      }
    }
    return null
  }
  // 兼容期：ADMIN_API_KEY → 虚拟主体 system（owner/L4），M-b 默认关闭（PRD D2）
  const adminKey = req.get('x-api-key') || ''
  const expected = process.env.ADMIN_API_KEY || ''
  if (expected && adminKey && safeEqual(sha256Hex(adminKey), sha256Hex(expected)) && process.env.ALLOW_ADMIN_API_KEY !== 'false') {
    return { userId: 'system', email: null, teamId: null, role: 'owner', level: 'L4', via: 'api_key', sessionId: null }
  }
  return null
}

/** 组装上下文：按 (userId, teamId) 实时查角色/等级（团队切换无需重发令牌） */
async function buildContext(req, base) {
  const requestedTeamId = String(req.get('x-team-id') || '').slice(0, 32) || null
  let teamId = requestedTeamId
  let membership = null
  if (teamId) {
    membership = await first(`select m.role, m.access_level from team_members m
      where m.team_id = ? and m.user_id = ? and m.status = 'active'`, [teamId, base.userId])
  }
  if (!membership) {
    membership = await first(`select m.team_id, m.role, m.access_level from team_members m
      where m.user_id = ? and m.status = 'active' order by m.created_at limit 1`, [base.userId])
    teamId = membership?.team_id || null
  }
  const role = membership?.role || null
  const level = membership ? normalizeLevel(membership.access_level) : null
  return { ...base, teamId, role, level, via: base.via }
}

function readBearer(req) {
  const header = req.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

function jwtSecretValue() {
  const secret = process.env.ACCOUNTS_JWT_SECRET
  if (!secret) {
    const err = new Error('账号体系已开启但缺少 ACCOUNTS_JWT_SECRET 环境变量')
    err.code = 'ACCOUNTS_JWT_SECRET_MISSING'
    throw err
  }
  return secret
}

// re-export 供 index.js 组装 capabilities 使用
export { isAccountsEnabled }
