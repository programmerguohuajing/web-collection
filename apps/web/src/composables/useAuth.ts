/**
 * useAuth —— 账号体系前端状态与请求封装（模块级单例）。
 *
 * 负责：
 * - 访问令牌（localStorage `eys_at`）的持久化；
 * - 能力位（GET /api/capabilities，关键 `accounts`）的拉取；
 * - 当前用户与团队（GET /api/me）的加载；
 * - 鉴权请求头（Bearer 访问令牌 + `x-team-id` 当前团队）注入；
 * - 访问令牌过期（401）时基于 HttpOnly 刷新 Cookie 自动续期；
 * - 当前团队（localStorage `currentTeamId` + 请求头）切换。
 *
 * 设计要点：
 * - 所有组件共享同一份登录态（模块级 ref）。
 * - `authApi` 在收到 401 时尝试一次 `/api/auth/refresh`，成功后用新令牌重试；
 *   刷新依赖 HttpOnly 刷新 Cookie，因此 `dashboard.js` 的 `api()` 已开启 `credentials: 'include'`。
 * - 登录 / 注册 / 刷新三个端点走裸 `api()`，不参与 401 续期循环（避免死循环）。
 */
import { computed, ref } from 'vue'
import { api } from '../dashboard.js'

const TOKEN_KEY = 'eys_at'
const TEAM_KEY = 'currentTeamId'

export type Role = 'owner' | 'admin' | 'member' | 'viewer'
export type AccessLevel = 'L1' | 'L2' | 'L3' | 'L4'

export interface TeamSummary {
  id: string
  name: string
  slug: string
  role: Role
  level: AccessLevel
}

export interface AuthUser {
  id: string
  email: string
  name: string
}

export interface MeResponse {
  user: AuthUser
  teams: TeamSummary[]
  currentTeamId: string | null
  role: Role
  level: AccessLevel
}

export interface Capabilities {
  accounts: boolean
  openRegister?: boolean
  [key: string]: boolean | undefined
}

export const ROLE_OPTIONS: ReadonlyArray<{ value: Role; label: string }> = [
  { value: 'owner', label: 'Owner · 所有者' },
  { value: 'admin', label: 'Admin · 管理员' },
  { value: 'member', label: 'Member · 成员' },
  { value: 'viewer', label: 'Viewer · 只读' }
]

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  viewer: '只读'
}

/** 可经 UI 变更的 role 选项（Owner 不能经 UI 赋予，后端亦禁止改 Owner）。 */
export const CHANGEABLE_ROLE_OPTIONS: ReadonlyArray<{ value: Role; label: string }> = [
  { value: 'admin', label: 'Admin · 管理员' },
  { value: 'member', label: 'Member · 成员' },
  { value: 'viewer', label: 'Viewer · 只读' }
]

export const LEVEL_OPTIONS: ReadonlyArray<{ value: AccessLevel; label: string }> = [
  { value: 'L1', label: 'L1 · 只读统计' },
  { value: 'L2', label: 'L2 · 业务分析' },
  { value: 'L3', label: 'L3 · 运维诊断' },
  { value: 'L4', label: 'L4 · 完整数据' }
]

export const LEVEL_LABELS: Readonly<Record<AccessLevel, string>> = {
  L1: '只读统计',
  L2: '业务分析',
  L3: '运维诊断',
  L4: '完整数据'
}

const accessToken = ref<string>(localStorage.getItem(TOKEN_KEY) || '')
const currentTeamId = ref<string>(localStorage.getItem(TEAM_KEY) || '')
const capabilities = ref<Capabilities>({ accounts: false })
const me = ref<MeResponse | null>(null)

const isLoggedIn = computed(() => Boolean(accessToken.value))
const accountsEnabled = computed(() => capabilities.value?.accounts === true)
/** B2 · SLO 能力位（Node 先行 true；Worker 镜像验收前保持 false → 前端隐藏入口且页面显式提示）。 */
const sloEnabled = computed(() => capabilities.value?.slo === true)
/** B3 · 合成监控能力位（Node 先行 true；Worker 需 SYNTHETIC_ENABLED=1，默认 false → 显式提示不静默隐藏）。 */
const syntheticEnabled = computed(() => capabilities.value?.synthetic === true)
/** D1 · DSR 能力位（Node 先行 true；Worker 需 DSR_ENABLED=1，默认 false → 显式提示不静默隐藏）。 */
const dsrEnabled = computed(() => capabilities.value?.dsr === true)
/** A3 · 实验分析能力位（Node 先行 true；Worker 需 EXPERIMENTS_ENABLED=1，默认 false → 显式提示不静默隐藏）。 */
const experimentsEnabled = computed(() => capabilities.value?.experiments === true)
/** D3 · 用量计量 & 套餐能力位（Node 先行 true；Worker 需 METERING_ENABLED=1，默认 false → 显式提示不静默隐藏）。 */
const meteringEnabled = computed(() => capabilities.value?.metering === true)
/** D4 · 白标 / 私有化能力位（Node 先行 true；Worker 需 WHITE_LABEL_ENABLED=1，默认 false → 显式提示不静默隐藏）。 */
const whiteLabelEnabled = computed(() => capabilities.value?.whiteLabel === true)

function setToken(token: string): void {
  accessToken.value = token
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

function setCurrentTeamId(id: string): void {
  currentTeamId.value = id
  if (id) localStorage.setItem(TEAM_KEY, id)
  else localStorage.removeItem(TEAM_KEY)
}

/** 合并鉴权请求头：Bearer 访问令牌 + 当前团队 x-team-id。 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra || {}) }
  if (accessToken.value) headers['Authorization'] = `Bearer ${accessToken.value}`
  if (currentTeamId.value) headers['x-team-id'] = currentTeamId.value
  return headers
}

let refreshPromise: Promise<string | null> | null = null

async function doRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async (): Promise<string | null> => {
    try {
      const data = (await api('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      })) as { accessToken?: string } | undefined
      const token = data?.accessToken
      if (token) {
        setToken(token)
        return token
      }
      return null
    } catch {
      setToken('')
      me.value = null
      return null
    } finally {
      refreshPromise = null
    }
  })()
  return refreshPromise
}

/**
 * 鉴权请求封装：自动注入 Bearer / x-team-id 头；
 * 收到 401 且非鉴权端点时，尝试一次刷新后重试。
 */
export async function authApi<T = unknown>(path: string, options: Record<string, unknown> = {}): Promise<T> {
  const opts: Record<string, unknown> = {
    ...options,
    headers: authHeaders(options.headers as Record<string, string> | undefined)
  }
  const noRetry = ['/api/auth/refresh', '/api/auth/login', '/api/auth/register'].includes(path)
  try {
    return (await api(path, opts)) as T
  } catch (err) {
    const status = (err as { status?: number })?.status
    if (!noRetry && status === 401) {
      const token = await doRefresh()
      if (token) {
        opts.headers = authHeaders(opts.headers as Record<string, string> | undefined)
        return (await api(path, opts)) as T
      }
    }
    throw err
  }
}

export async function login(email: string, password: string): Promise<void> {
  const data = (await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  })) as { accessToken?: string; user?: AuthUser }
  if (!data?.accessToken) throw new Error('登录失败：服务端未返回访问令牌')
  setToken(data.accessToken)
  await loadMe()
}

export async function register(payload: {
  email: string
  password: string
  name?: string
  inviteToken?: string
}): Promise<boolean> {
  await api('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  // 后端注册仅返回 {userId, teamId}，不下发令牌；用刚注册的凭据走登录流程换取代币并加载用户信息，
  // 实现"注册即登录"的原始意图（纯前端，不依赖后端改动）。
  await login(payload.email, payload.password)
  return true
}

export async function logout(): Promise<void> {
  try {
    await api('/api/auth/logout', { method: 'POST', headers: authHeaders() })
  } catch {
    /* 网络异常不影响本地清理 */
  } finally {
    setToken('')
    me.value = null
    setCurrentTeamId('')
  }
}

export async function loadMe(): Promise<MeResponse | null> {
  if (!accessToken.value) {
    me.value = null
    return null
  }
  const data = await authApi<MeResponse>('/api/me')
  me.value = data
  if (data.currentTeamId) setCurrentTeamId(data.currentTeamId)
  else if (data.teams?.length && !currentTeamId.value) setCurrentTeamId(data.teams[0].id)
  return data
}

export async function switchTeam(teamId: string): Promise<void> {
  setCurrentTeamId(teamId)
  await loadMe()
}

let capabilitiesPromise: Promise<Capabilities> | null = null

export async function loadCapabilities(force = false): Promise<Capabilities> {
  if (capabilitiesPromise && !force) return capabilitiesPromise
  capabilitiesPromise = (async (): Promise<Capabilities> => {
    try {
      const data = (await api('/api/capabilities')) as Capabilities | undefined
      capabilities.value = { accounts: false, ...(data || {}) }
    } catch {
      capabilities.value = { accounts: false }
    }
    return capabilities.value
  })()
  return capabilitiesPromise
}

export function useAuth() {
  return {
    accessToken,
    currentTeamId,
    capabilities,
    me,
    isLoggedIn,
    accountsEnabled,
    sloEnabled,
    syntheticEnabled,
    dsrEnabled,
    experimentsEnabled,
    meteringEnabled,
    whiteLabelEnabled,
    authHeaders,
    authApi,
    login,
    register,
    logout,
    loadMe,
    switchTeam,
    loadCapabilities
  }
}
