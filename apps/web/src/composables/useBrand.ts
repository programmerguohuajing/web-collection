/**
 * @file D4 · 白标 / 私有化交付（PRD 16）—— 前端品牌消费单例。
 *
 * 模块级单例（与 useAuth 同风格：模块作用域 ref，非每次调用新建）。
 * 唯一数据源为运行时引导脚本 `/brand.js` 注入的 `window.__BRAND__`（见后端
 * branding-service.renderBrandScript）；脚本未加载 / 能力位关闭时其值为 null，
 * 全部回落到内置默认，永不抛错。
 *
 * ⚠️ `Web Collection` 字面量只允许出现在本文件的默认值中一处（PRD §11 验收项）。
 */

import { ref, computed, type Ref, type ComputedRef } from 'vue'

/** 品牌对象（展示层字段，与后端 GET /api/brand / publicBrand 对齐）。 */
export interface Brand {
  name: string
  shortName: string
  logoUrl: string
  faviconUrl: string
  primaryColor: string
  loginTitle: string
  loginSubtitle: string
  loginFooter: string
  consoleDomain: string
  collectDomain: string
}

export interface AuthLike {
  role?: string
}

interface WindowWithBrand extends Window {
  __BRAND__?: Brand | null
}

/** 内置默认（与后端 BRAND_DEFAULTS 对齐；仅本文件 + 后端各一处字面量）。 */
const BUILTIN: Brand = {
  name: 'Web Collection',
  shortName: 'WC',
  logoUrl: '',
  faviconUrl: '',
  primaryColor: '#4f46e5',
  loginTitle: '',
  loginSubtitle: '前端遥测平台',
  loginFooter: '',
  consoleDomain: '',
  collectDomain: ''
}

/** 从任意来源（window.__BRAND__ 或 GET /api/brand 响应）归一化为安全 Brand 对象。 */
function toBrand(source: Partial<Brand> | null | undefined): Brand {
  const s = (source && typeof source === 'object' ? source : {}) as Partial<Brand>
  const name = String(s.name || BUILTIN.name)
  return {
    name,
    shortName: String(s.shortName || name.slice(0, 2).toUpperCase()),
    logoUrl: String(s.logoUrl || ''),
    faviconUrl: String(s.faviconUrl || ''),
    primaryColor: String(s.primaryColor || BUILTIN.primaryColor),
    loginTitle: String(s.loginTitle || name),
    loginSubtitle: String(s.loginSubtitle || BUILTIN.loginSubtitle),
    loginFooter: String(s.loginFooter || ''),
    consoleDomain: String(s.consoleDomain || ''),
    collectDomain: String(s.collectDomain || '')
  }
}

function readInitial(): Brand {
  const w = window as unknown as WindowWithBrand
  return toBrand(w.__BRAND__)
}

/** 模块级单例：品牌对象。 */
export const brand: Ref<Brand> = ref(readInitial())

/** 品牌名（回落内置）。 */
export const brandName: ComputedRef<string> = computed(() => brand.value?.name || BUILTIN.name)

/** 侧栏/登录方块缩写（空缺时取品牌名前 2 字符大写）。 */
export const brandShortName: ComputedRef<string> = computed(() => {
  const s = brand.value?.shortName
  if (s) return s
  const n = brand.value?.name || BUILTIN.name
  return n ? n.slice(0, 2).toUpperCase() : BUILTIN.shortName
})

/** 登录副标题（回落内置）。 */
export const brandSubtitle: ComputedRef<string> = computed(() => brand.value?.loginSubtitle || BUILTIN.loginSubtitle)

/** Logo URL（可能为空 → 调用方走缩写方块）。 */
export const brandLogoUrl: ComputedRef<string> = computed(() => brand.value?.logoUrl || '')

/** 页脚文本：`${name} · ${subtitle}`。 */
export const brandFooterText: ComputedRef<string> = computed(() => `${brandName.value} · ${brandSubtitle.value}`)

/** 告警默认标题前缀：`${name} 告警`（供 alert-channels.js 使用）。 */
export const alertSubjectPrefix: ComputedRef<string> = computed(() => `${brandName.value} 告警`)

/**
 * 白标能力位（前端视角）：`window.__BRAND__` 非 null 即视为能力开启。
 * 能力位关闭时 /brand.js 输出 `window.__BRAND__ = null` → 此处回落 false。
 */
export const whiteLabelEnabled: ComputedRef<boolean> = computed(() => {
  const w = window as unknown as WindowWithBrand
  return w.__BRAND__ !== null && w.__BRAND__ !== undefined
})

/** 是否可管理品牌：owner 恒可，admin 可，其余不可（沿用 role 字符串比较，避免引入 packages 依赖）。 */
export function canManageBrand(auth?: AuthLike | null): boolean {
  const role = auth?.role
  return role === 'owner' || role === 'admin'
}

/**
 * 登录后二次拉取 GET /api/brand（P1-4 按团队品牌预留；本批用于 PUT 后同步单例）。
 * 端点公开，无需鉴权头。
 * @returns {Promise<Brand>}
 */
export async function refreshBrand(): Promise<Brand> {
  try {
    const res = await fetch('/api/brand', { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`brand load failed: ${res.status}`)
    const data = (await res.json()) as Partial<Brand>
    brand.value = toBrand(data)
  } catch {
    /* 容错：保持既有单例值 */
  }
  return brand.value
}

/** 组合式入口：返回所有派生值 + 刷新方法。 */
export function useBrand() {
  return {
    brand,
    brandName,
    brandShortName,
    brandSubtitle,
    brandLogoUrl,
    brandFooterText,
    alertSubjectPrefix,
    whiteLabelEnabled,
    canManageBrand,
    refreshBrand
  }
}

export default useBrand
