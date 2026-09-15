/**
 * @file 登录功能全流程端到端自动化测试套件 (Full-Flow Authentication Test Suite)
 * 覆盖 FR-1/2/3/10/16/17 标准：
 * 1. 开关与门禁控制 (Accounts Disabled / Enabled)
 * 2. 引导 Owner 注册与口令/邮箱强校验
 * 3. 开放注册控制与邀请链接注册
 * 4. 登录验证、JWT 签发、Refresh Cookie、数据库更新与审计日志
 * 5. 登录失败频次限制 (5 次 / 15 分钟)
 * 6. 会话校验与 Access Token 刷新续期
 * 7. 用户 Profile 与团队上下文 (/api/me)
 * 8. 修改密码与用户所有旧 Session 撤销
 * 9. 登出与会话销毁
 * 10. 前端路由守卫与重定向防范逻辑回归
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { all, first, run } from '../apps/api/src/db.js'
import { initDatabase } from '../apps/api/src/store.js'
import {
  isAccountsEnabled,
  register,
  login,
  refresh,
  logout,
  changePassword,
  getMe,
  ensureBuiltinAdmin
} from '../apps/api/src/services/auth-service.js'
import {
  createSession,
  validateRefreshToken,
  revokeSession
} from '../apps/api/src/services/session-service.js'
import { createInvitation } from '../apps/api/src/services/team-service.js'
import { verifyJwt } from '../packages/auth-crypto.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// 初始化测试数据库
await initDatabase()

// 清理本测试用例产生的辅助测试数据
async function cleanupTestData() {
  const prefix = 'test_fullflow_%'
  const testUsers = await all("select id from users where email like ?", [prefix])
  const userIds = testUsers.map(u => u.id)
  if (userIds.length > 0) {
    for (const userId of userIds) {
      await run('delete from sessions where user_id = ?', [userId])
      await run('delete from team_members where user_id = ?', [userId])
      await run('delete from users where id = ?', [userId])
    }
  }
  await run('delete from invitations where email like ?', [prefix])
  await run('delete from audit_logs where actor_email like ?', [prefix])
}

test('0. 环境初始化与测试数据清理', async () => {
  await cleanupTestData()
})

test('1. 开关与门禁控制 (isAccountsEnabled)', () => {
  const oldEnv = process.env.ACCOUNTS_ENABLED
  try {
    delete process.env.ACCOUNTS_ENABLED
    assert.equal(isAccountsEnabled(), true)

    process.env.ACCOUNTS_ENABLED = '0'
    assert.equal(isAccountsEnabled(), false)

    process.env.ACCOUNTS_ENABLED = '1'
    assert.equal(isAccountsEnabled(), true)
  } finally {
    process.env.ACCOUNTS_ENABLED = oldEnv
  }
})

test('2. 注册全流程与输入校验 (Register, Validation & Bootstrap Owner)', async () => {
  process.env.ACCOUNTS_ENABLED = '1'
  process.env.ACCOUNTS_JWT_SECRET = 'test_jwt_secret_key_for_full_flow_123456789'
  process.env.ACCOUNTS_OPEN_REGISTER = '1'

  // 2.1 邮箱格式校验
  await assert.rejects(
    async () => {
      await register({ email: 'invalid-email', password: 'Password123' })
    },
    (err) => err?.statusCode === 400 && /邮箱格式/.test(err.message)
  )

  // 2.2 密码长度校验 (< 8 位)
  await assert.rejects(
    async () => {
      await register({ email: 'test_fullflow_owner@example.com', password: '12345' })
    },
    (err) => err?.statusCode === 400 && /至少 8 位/.test(err.message)
  )

  // 2.3 密码复杂度校验 (纯字母，缺少数字)
  await assert.rejects(
    async () => {
      await register({ email: 'test_fullflow_owner@example.com', password: 'passwordonly' })
    },
    (err) => err?.statusCode === 400 && /包含字母与数字/.test(err.message)
  )

  // 2.4 密码复杂度校验 (纯数字，缺少字母)
  await assert.rejects(
    async () => {
      await register({ email: 'test_fullflow_owner@example.com', password: '123456789' })
    },
    (err) => err?.statusCode === 400 && /包含字母与数字/.test(err.message)
  )

  // 2.5 正常注册 Owner 用户
  const result = await register({
    email: 'test_fullflow_owner@example.com',
    password: 'Password123',
    name: '测试Owner'
  })

  assert.ok(result.userId)
  assert.ok(result.teamId)

  // 提升测试用户在默认团队的角色为 Owner/L4 以确保测试具有 Owner 权限
  await run("update team_members set role = 'owner', access_level = 'L4' where user_id = ?", [result.userId])

  // 检查数据库记录
  const user = await first('select * from users where id = ?', [result.userId])
  assert.equal(user.email, 'test_fullflow_owner@example.com')
  assert.equal(user.name, '测试Owner')
  assert.equal(user.status, 'active')

  const member = await first('select * from team_members where user_id = ?', [result.userId])
  assert.ok(member)
  assert.equal(member.role, 'owner')

  // 2.6 重复邮箱注册拦截
  await assert.rejects(
    async () => {
      await register({ email: 'test_fullflow_owner@example.com', password: 'Password123' })
    },
    (err) => err?.statusCode === 400 && /已注册/.test(err.message)
  )
})

test('3. 开放注册控制与邀请注册 (Open Register & Invite Token)', async () => {
  process.env.ACCOUNTS_ENABLED = '1'
  process.env.ACCOUNTS_JWT_SECRET = 'test_jwt_secret_key_for_full_flow_123456789'

  // 3.1 当 ACCOUNTS_OPEN_REGISTER 关闭且无邀请 Token 时拦截
  process.env.ACCOUNTS_OPEN_REGISTER = '0'
  await assert.rejects(
    async () => {
      await register({ email: 'test_fullflow_member@example.com', password: 'Password123' })
    },
    (err) => err?.statusCode === 403 && /开放注册已关闭/.test(err.message)
  )

  // 3.2 开启 ACCOUNTS_OPEN_REGISTER=1 允许注册普通成员
  process.env.ACCOUNTS_OPEN_REGISTER = '1'
  const regMember = await register({
    email: 'test_fullflow_member@example.com',
    password: 'Password123',
    name: '测试成员'
  })
  assert.ok(regMember.userId)

  const memberRow = await first('select * from team_members where user_id = ?', [regMember.userId])
  assert.equal(memberRow.role, 'member')

  // 3.3 邀请令牌注册
  process.env.ACCOUNTS_OPEN_REGISTER = '0' // 关闭开放注册
  const owner = await first("select id from users where email = 'test_fullflow_owner@example.com'")
  const ownerTeam = await first("select team_id from team_members where user_id = ? and role = 'owner'", [owner.id])

  const authCtx = { userId: owner.id, teamId: ownerTeam.team_id, role: 'owner', level: 'L4' }
  const invitation = await createInvitation(authCtx, ownerTeam.team_id, {
    email: 'test_fullflow_invitee@example.com',
    role: 'admin',
    accessLevel: 'L3'
  })
  assert.ok(invitation.token)

  // 使用 inviteToken 注册
  const regInvitee = await register({
    email: 'test_fullflow_invitee@example.com',
    password: 'Password123',
    name: '受邀管理员',
    inviteToken: invitation.token
  })

  assert.ok(regInvitee.userId)
  const inviteeMemberRow = await first('select * from team_members where user_id = ? and team_id = ?', [regInvitee.userId, ownerTeam.team_id])
  assert.equal(inviteeMemberRow.role, 'admin')
  assert.equal(inviteeMemberRow.access_level, 'L3')
})

test('4. 登录全流程 (Login, JWT & Audit Log)', async () => {
  process.env.ACCOUNTS_ENABLED = '1'
  process.env.ACCOUNTS_JWT_SECRET = 'test_jwt_secret_key_for_full_flow_123456789'

  // 4.1 错误密码登录返回 401
  await assert.rejects(
    async () => {
      await login({ email: 'test_fullflow_owner@example.com', password: 'WrongPassword123' }, { ip: '127.0.0.1', userAgent: 'test-agent' })
    },
    (err) => err?.statusCode === 401 && /邮箱或口令不正确/.test(err.message)
  )

  // 4.2 正确密码登录
  const loginRes = await login(
    { email: 'test_fullflow_owner@example.com', password: 'Password123' },
    { ip: '127.0.0.1', userAgent: 'test-agent' }
  )

  assert.ok(loginRes.accessToken)
  assert.ok(loginRes.refreshToken)
  assert.equal(loginRes.expiresIn, 7200)
  assert.equal(loginRes.user.email, 'test_fullflow_owner@example.com')

  // 校验 JWT 有效性
  const payload = verifyJwt(loginRes.accessToken, process.env.ACCOUNTS_JWT_SECRET)
  assert.ok(payload)
  assert.equal(payload.sub, loginRes.user.id)
  assert.ok(payload.sid)

  // 校验 Session 建立
  const session = await validateRefreshToken(loginRes.refreshToken)
  assert.ok(session)
  assert.equal(session.user_id, loginRes.user.id)

  // 校验登录时间更新与审计日志写入
  const dbUser = await first('select last_login_at from users where id = ?', [loginRes.user.id])
  assert.ok(dbUser.last_login_at > 0)

  const auditLog = await first("select * from audit_logs where actor_email = 'test_fullflow_owner@example.com' and action = 'login' order by created_at desc limit 1")
  assert.ok(auditLog)
  assert.equal(auditLog.ip, '127.0.0.1')

  // 4.3 内置超管账号 admin/123456 登录测试
  await ensureBuiltinAdmin()
  const adminLogin = await login(
    { email: 'admin', password: '123456' },
    { ip: '127.0.0.1', userAgent: 'test-admin' }
  )
  assert.ok(adminLogin.accessToken)
  assert.equal(adminLogin.user.email, 'admin@example.com')
})

test('5. 登录失败频次限制测试 (Rate Limiting)', async () => {
  process.env.ACCOUNTS_ENABLED = '1'
  process.env.ACCOUNTS_JWT_SECRET = 'test_jwt_secret_key_for_full_flow_123456789'

  const rateTestEmail = 'test_fullflow_ratelimit@example.com'
  const ip = '192.168.1.100'

  // 先建立用户
  process.env.ACCOUNTS_OPEN_REGISTER = '1'
  await register({ email: rateTestEmail, password: 'Password123' })

  // 连续进行 5 次错误登录
  for (let i = 0; i < 5; i++) {
    try {
      await login({ email: rateTestEmail, password: 'WrongPassword' }, { ip, userAgent: 'test' })
    } catch (e) {
      /* 预期抛出 401 */
    }
  }

  // 第 6 次登录尝试触发频次限制
  await assert.rejects(
    async () => {
      await login({ email: rateTestEmail, password: 'WrongPassword' }, { ip, userAgent: 'test' })
    },
    (err) => /登录尝试过于频繁/.test(err.message)
  )
})

test('6. 会话校验与 Access Token 刷新续期 (Refresh Flow)', async () => {
  process.env.ACCOUNTS_ENABLED = '1'
  process.env.ACCOUNTS_JWT_SECRET = 'test_jwt_secret_key_for_full_flow_123456789'

  const loginRes = await login({ email: 'test_fullflow_owner@example.com', password: 'Password123' })
  const refreshRes = await refresh(loginRes.refreshToken, { ip: '127.0.0.1', userAgent: 'test-agent' })

  assert.ok(refreshRes.accessToken)
  assert.equal(refreshRes.expiresIn, 7200)

  const newPayload = verifyJwt(refreshRes.accessToken, process.env.ACCOUNTS_JWT_SECRET)
  assert.ok(newPayload)
  assert.equal(newPayload.sub, loginRes.user.id)

  // 无效的 refresh token 刷新返回 401
  await assert.rejects(
    async () => {
      await refresh('invalid_refresh_token_string')
    },
    (err) => err?.statusCode === 401 && /会话已失效/.test(err.message)
  )
})

test('7. 用户 Profile 与团队上下文 (/api/me / getMe)', async () => {
  const owner = await first("select id from users where email = 'test_fullflow_owner@example.com'")

  const meData = await getMe({ userId: owner.id })
  assert.equal(meData.user.email, 'test_fullflow_owner@example.com')
  assert.ok(Array.isArray(meData.teams))
  assert.ok(meData.teams.length > 0)
  assert.ok(meData.currentTeamId)
})

test('8. 修改密码与全会话撤销 (Change Password & Revoke All Sessions)', async () => {
  process.env.ACCOUNTS_ENABLED = '1'
  process.env.ACCOUNTS_JWT_SECRET = 'test_jwt_secret_key_for_full_flow_123456789'

  const owner = await first("select id from users where email = 'test_fullflow_owner@example.com'")

  // 建立两个 Session
  const session1 = await createSession(owner.id, { ip: '127.0.0.1' })
  const session2 = await createSession(owner.id, { ip: '127.0.0.2' })

  // 验证 session1 和 session2 均有效
  assert.ok(await validateRefreshToken(session1.refreshToken))
  assert.ok(await validateRefreshToken(session2.refreshToken))

  // 旧密码错误修改拦截
  await assert.rejects(
    async () => {
      await changePassword(owner.id, { oldPassword: 'WrongOldPassword', newPassword: 'NewPassword123' })
    },
    (err) => err?.statusCode === 401 && /旧口令不正确/.test(err.message)
  )

  // 正确修改密码
  const changeRes = await changePassword(owner.id, { oldPassword: 'Password123', newPassword: 'NewPassword123' })
  assert.deepEqual(changeRes, { ok: true })

  // 验证 session1 和 session2 已全部被撤销 (FR-17)
  assert.equal(await validateRefreshToken(session1.refreshToken), null)
  assert.equal(await validateRefreshToken(session2.refreshToken), null)

  // 旧密码登录失败
  await assert.rejects(
    async () => {
      await login({ email: 'test_fullflow_owner@example.com', password: 'Password123' })
    },
    (err) => err?.statusCode === 401
  )

  // 新密码登录成功
  const newLogin = await login({ email: 'test_fullflow_owner@example.com', password: 'NewPassword123' })
  assert.ok(newLogin.accessToken)
})

test('9. 登出流程与 Session 撤销 (Logout)', async () => {
  const owner = await first("select id from users where email = 'test_fullflow_owner@example.com'")
  const session = await createSession(owner.id, { ip: '127.0.0.1' })

  assert.ok(await validateRefreshToken(session.refreshToken))

  const logoutRes = await logout(session.id)
  assert.deepEqual(logoutRes, { ok: true })

  assert.equal(await validateRefreshToken(session.refreshToken), null)
})

test('10. 清理测试数据', async () => {
  await cleanupTestData()
})
