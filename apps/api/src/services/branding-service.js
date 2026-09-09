/**
 * @file D4 · 白标 / 私有化交付（PRD 16）—— 品牌配置服务（Node + PostgreSQL）。
 *
 * 存储复用既有全局配置单行表 `platform_settings(id=1, config_json jsonb)`，
 * 品牌配置落在其 `brand` 块内，**不新建任何表、不做迁移**。读写沿用仓库既有
 * 「先读整行 config_json → JS 端 merge → 整行回写」范式（见 ai-settings-service.js /
 * governance.js），避免覆盖 retention / alerts / ai 其它块。
 *
 * 导出两套等价接口：
 *   1. 具名函数（供 apps/api/src/index.js 的 /brand.js 与 /api/brand* 路由直接 import ——
 *      见架构文档补丁 E），签名与路由调用一致：getBrand() / saveBrand(input, actor) /
 *      resetBrand(actor) / renderBrandScript(brand, enabled) / whiteLabelEnabled()。
 *   2. 工厂 createBrandingService({ db, config })（任务清单要求），返回同名方法，便于
 *      调用方注入自定义 db 句柄。
 *
 * 两条实现的底层 IO 完全一致（均走默认 db 句柄或注入的 db）。
 *
 * ⚠️ SQL 红线：本文件禁止在 SQL 中使用 JSONB `?` / `?|` / `?&` 算子（toPgSql 会盲替换
 * `?` 为占位符）。品牌配置只做整行读写，不做任何 JSON 运算。
 */

import { first, run } from '../db.js'
import { NODE_CAPABILITIES } from '../../../../packages/deployment-capabilities.js'

/**
 * 内置默认品牌（代码内置回落值，优先级最低：DB > env > 内置）。
 * 注：`Web Collection` 字面量仅在本文件与前端 useBrand.ts 默认值各出现一次。
 */
export const BRAND_DEFAULTS = Object.freeze({
  name: 'Web Collection',
  shortName: 'WC',
  logoUrl: '',
  faviconUrl: '',
  primaryColor: '#4f46e5',
  loginTitle: '',
  loginSubtitle: '前端遥测平台',
  loginFooter: '',
  consoleDomain: '',
  collectDomain: '',
  scopes: { global: {}, teams: {} },
  updatedBy: '',
  updatedAt: 0
})

// ---------------------------------------------------------------------------
// 纯函数层（无 IO，可单测）
// ---------------------------------------------------------------------------

/** 读 process.env 的 BRAND_* 出厂默认值（仅本批纳入 env 的 7 个键）。 */
export function envBrand(env = process.env) {
  const e = env || {}
  return {
    name: e.BRAND_NAME || '',
    shortName: e.BRAND_SHORT_NAME || '',
    logoUrl: e.BRAND_LOGO_URL || '',
    faviconUrl: e.BRAND_FAVICON_URL || '',
    primaryColor: e.BRAND_PRIMARY_COLOR || '',
    loginTitle: e.BRAND_LOGIN_TITLE || '',
    loginSubtitle: e.BRAND_LOGIN_SUBTITLE || ''
  }
}

/** 取第一个非空（去除首尾空白后长度 > 0）的值；全空返回 undefined。 */
function pickFirst(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim().length > 0) return String(v).trim()
  }
  return undefined
}

/**
 * 标准化十六进制颜色：支持 3 位 / 6 位，统一转小写 6 位；非法返回 null。
 * 用于输入校验与 env/DB 值回落（PRD §7.1 / 架构 §3.6）。
 */
export function normalizeColor(value) {
  if (typeof value !== 'string') return null
  let h = value.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(h)) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`
  if (/^#[0-9a-fA-F]{6}$/.test(h)) return h.toLowerCase()
  return null
}

/** 校验 URL 仅允许 http(s):// 或 / 开头（禁 javascript:/data:/vbscript:/协议相对 //）。 */
function safeUrl(value) {
  if (typeof value !== 'string') return ''
  const v = value.trim()
  return /^(https?:\/\/|\/)/.test(v) ? v : ''
}

/** 剥离协议与路径，仅保留 host[:port]（用于控制台/采集域名展示）。 */
function stripHost(value) {
  if (typeof value !== 'string') return ''
  const v = value.trim()
  if (!v) return ''
  try {
    if (/^https?:\/\//i.test(v)) {
      const u = new URL(v)
      return u.host
    }
  } catch { /* 非法 URL，回退下方直剥 */ }
  // 直剥协议前缀（如 //host 或 host:port）
  return v.replace(/^[a-z]+:\/\//i, '').split('/')[0]
}

/**
 * 归一化品牌对象（单一真相函数，双栈镜像）。
 * 优先级链（字段级）：DB `input` > env `BRAND_*` > 内置 `BRAND_DEFAULTS`。
 * 未知字段丢弃（逐字段白名单取值，不 spread 用户输入）；颜色/URL 校验；文案钳位。
 * @param {object} input   DB 中的 brand 块（或合并后的输入）
 * @param {object} env     process.env（可注入，便于测试/Worker 镜像）
 * @param {string} actor   变更操作者（仅用于 updatedBy 落库，不影响归一化结果）
 * @returns {object} 完整归一化品牌对象
 */
export function normalizeBrand(input = {}, env = process.env, actor = '') {
  const raw = input && typeof input === 'object' ? input : {}
  const e = envBrand(env)

  const name = String(pickFirst(raw.name, e.name, BRAND_DEFAULTS.name) || BRAND_DEFAULTS.name)
    .trim().slice(0, 80)

  const shortNameRaw = pickFirst(raw.shortName, e.shortName)
  const shortName = shortNameRaw
    ? String(shortNameRaw).trim().slice(0, 8)
    : (name ? name.slice(0, 2).toUpperCase() : BRAND_DEFAULTS.shortName)

  // 颜色：DB > env > 内置；任一不合法则向下回落
  const primaryColor =
    normalizeColor(raw.primaryColor) ||
    normalizeColor(e.primaryColor) ||
    BRAND_DEFAULTS.primaryColor

  const logoUrl = safeUrl(pickFirst(raw.logoUrl, e.logoUrl) ?? '')
  const faviconUrl = safeUrl(pickFirst(raw.faviconUrl, e.faviconUrl) ?? '')

  const loginSubtitle = String(
    pickFirst(raw.loginSubtitle, e.loginSubtitle, BRAND_DEFAULTS.loginSubtitle) || BRAND_DEFAULTS.loginSubtitle
  ).trim().slice(0, 120)

  // 登录标题：DB/ENV 优先，空缺回落到品牌名
  const loginTitleRaw = pickFirst(raw.loginTitle, e.loginTitle)
  const loginTitle = String(loginTitleRaw || name).trim().slice(0, 80)

  const loginFooter = String(raw.loginFooter || '').trim().slice(0, 160)

  const consoleDomain = stripHost(raw.consoleDomain).slice(0, 256)
  const collectDomain = stripHost(raw.collectDomain).slice(0, 256)

  // scopes 结构强制（P0 只消费 global；teams 预留给 P1-4，本批不消费）
  const scopes = {
    global: raw.scopes && typeof raw.scopes.global === 'object' ? raw.scopes.global : {},
    teams: raw.scopes && typeof raw.scopes.teams === 'object' ? raw.scopes.teams : {}
  }

  const updatedBy = String(raw.updatedBy || '').slice(0, 64)
  const updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0

  return {
    name,
    shortName,
    logoUrl,
    faviconUrl,
    primaryColor,
    loginTitle,
    loginSubtitle,
    loginFooter,
    consoleDomain,
    collectDomain,
    scopes,
    updatedBy,
    updatedAt
  }
}

// ---------------------------------------------------------------------------
// 颜色派生（服务端，前端不计算 —— PRD §7.1）
// 将主色（hex）按 HSL 亮度线性偏移派生出 Element Plus 全套主色变量。
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  }
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2
  const d = max - min
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4
    }
    h /= 6
  }
  return { h, s, l }
}

function hslToHex(h, s, l) {
  let r
  let g
  let b
  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }
  const to2 = (x) => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

/**
 * 由主色派生 Element Plus 全套主色变量值。
 * 偏移量对齐架构 §3.1：hover/light9/soft(dark2)= -0.08 / +0.18 / +0.28 / +0.38 / +0.45 / +0.50。
 */
export function derivePalette(hex) {
  const { r, g, b } = hexToRgb(hex)
  const { h, s, l } = rgbToHsl(r, g, b)
  const hover = hslToHex(h, s, clamp(l - 0.08, 0, 1))
  const soft = hslToHex(h, clamp(s - 0.05, 0, 1), clamp(l + 0.50, 0, 0.96))
  return {
    hover,
    soft,
    light3: hslToHex(h, s, clamp(l + 0.18, 0, 1)),
    light5: hslToHex(h, s, clamp(l + 0.28, 0, 1)),
    light7: hslToHex(h, s, clamp(l + 0.38, 0, 1)),
    light8: hslToHex(h, s, clamp(l + 0.45, 0, 1)),
    light9: soft,
    dark2: hover,
    ring: `rgba(${r}, ${g}, ${b}, .18)`
  }
}

/**
 * 展示子集：剔除 scopes / updatedBy / updatedAt（/brand.js 公开脚本专用，不含任何部署密钥）。
 */
export function publicBrand(brand) {
  const b = brand && typeof brand === 'object' ? brand : {}
  return {
    name: b.name || BRAND_DEFAULTS.name,
    shortName: b.shortName || BRAND_DEFAULTS.shortName,
    logoUrl: b.logoUrl || '',
    faviconUrl: b.faviconUrl || '',
    primaryColor: b.primaryColor || BRAND_DEFAULTS.primaryColor,
    loginTitle: b.loginTitle || b.name || BRAND_DEFAULTS.name,
    loginSubtitle: b.loginSubtitle || BRAND_DEFAULTS.loginSubtitle,
    loginFooter: b.loginFooter || '',
    consoleDomain: b.consoleDomain || '',
    collectDomain: b.collectDomain || ''
  }
}

/**
 * JSON 序列化并转义 `<` / `>` / 行分隔符，防止 `</script>` 截断与旧引擎字符串破坏
 * （XSS 红线，架构 §3.6）。值已通过色值/URL 正则，无注入面。
 */
export function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * 生成 /brand.js 引导脚本全文。
 * - enabled=false 或 brand=null → 输出 `window.__BRAND__ = null;`（不报错、不注入变量）。
 * - 否则：① 写 window.__BRAND__ ② 覆盖 11 个 CSS 变量 ③ 替换 favicon ④ 设置 document.title。
 */
export function renderBrandScript(brand, enabled) {
  if (!enabled || !brand) {
    return 'window.__BRAND__ = null;'
  }
  const b = publicBrand(brand)
  const p = derivePalette(b.primaryColor)
  const data = safeJsonForScript(b)

  const vars = [
    ['--c-primary', b.primaryColor],
    ['--c-primary-hover', p.hover],
    ['--c-primary-soft', p.soft],
    ['--el-color-primary', b.primaryColor],
    ['--el-color-primary-light-3', p.light3],
    ['--el-color-primary-light-5', p.light5],
    ['--el-color-primary-light-7', p.light7],
    ['--el-color-primary-light-8', p.light8],
    ['--el-color-primary-light-9', p.light9],
    ['--el-color-primary-dark-2', p.dark2],
    ['--sh-focus', p.ring]
  ]
  const setProps = vars
    .map(([k, v]) => `  document.documentElement.style.setProperty(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n')

  const favicon = b.faviconUrl
    ? `  (function(){var __icons=document.querySelectorAll('link[rel~="icon"]');for(var i=0;i<__icons.length;i++){try{__icons[i].setAttribute('href', ${safeJsonForScript(b.faviconUrl)});}catch(e){}}})();`
    : ''

  const title = `  document.title = ${safeJsonForScript(b.name)};`

  return [
    '(function(){\n  try {',
    `  window.__BRAND__ = ${data};`,
    setProps,
    favicon,
    title,
    '  } catch (e) { /* 品牌脚本容错：失败不阻断页面 */ }',
    '})();'
  ].filter(Boolean).join('\n')
}

/** Node 侧白标能力位：恒 true（Worker 侧由 env 门禁决定，见 cloudflare/worker.js）。 */
export function whiteLabelEnabled() {
  return Boolean(NODE_CAPABILITIES && NODE_CAPABILITIES.whiteLabel)
}

// ---------------------------------------------------------------------------
// 存储层（整块 config_json 读写，JS 端 merge，不碰 SQL JSON 算子）
// ---------------------------------------------------------------------------

/** 解析 config_json（PG jsonb 已返回对象，容错 JSON 字符串与 null）。 */
function parseConfig(c) {
  if (c && typeof c === 'object') return c
  try { return JSON.parse(String(c || '{}')) } catch { return {} }
}

/**
 * 构造一个 brand 服务实例（底层 IO 由 dao 提供）。
 * @param {{first?: Function, run?: Function}} dao 含 first/run 的数据库句柄
 */
function buildService(dao) {
  async function readConfig() {
    try {
      const row = await dao.first('select config_json from platform_settings where id = 1')
      return parseConfig(row?.config_json)
    } catch (error) {
      console.error('[branding] readConfig failed:', String(error?.message || error))
      return {}
    }
  }

  async function writeConfig(config) {
    await dao.run(
      `insert into platform_settings(id, config_json, updated_at) values(1, ?::jsonb, ?)
       on conflict(id) do update set config_json=excluded.config_json, updated_at=excluded.updated_at`,
      [JSON.stringify(config), Date.now()]
    )
  }

  /**
   * 读取归一化后的品牌对象。
   * @param {string} [teamId] 预留（P1-4 按团队品牌）；P0 忽略，返回全局品牌。
   */
  async function getBrand(teamId) {
    try {
      const config = await readConfig()
      const dbBrand = (config && typeof config.brand === 'object' && config.brand) || {}
      return normalizeBrand(dbBrand, process.env, '')
    } catch (error) {
      console.error('[branding] getBrand failed:', String(error?.message || error))
      return normalizeBrand({}, process.env, '')
    }
  }

  /**
   * 保存品牌配置（先读整行 → merge brand 块 → 整行回写，绝不整体覆盖 config_json）。
   * @param {string} [teamId] 预留（P1-4）；P0 落在全局 brand 块。
   * @param {object} input    客户端提交的部分品牌字段。
   * @param {string} [actor]  操作者标识（写入 updatedBy）。
   */
  async function saveBrand(teamId, input, options = {}) {
    const actor = typeof options === 'string' ? options : (options && options.actor) || ''
    const incoming = (input && typeof input === 'object') ? input : {}
    try {
      const config = await readConfig()
      const existingBrand = (config.brand && typeof config.brand === 'object') ? config.brand : {}
      const merged = normalizeBrand({ ...existingBrand, ...incoming }, process.env, actor)
      merged.updatedBy = String(actor || '').slice(0, 64)
      merged.updatedAt = Date.now()
      // 保留 scopes 既有结构（P1-4 teams 不被本次全局保存抹除）
      config.brand = merged
      await writeConfig(config)
      return normalizeBrand(config.brand, process.env, actor)
    } catch (error) {
      console.error('[branding] saveBrand failed:', String(error?.message || error))
      throw Object.assign(new Error('保存品牌配置失败'), { status: 500 })
    }
  }

  /**
   * 重置品牌配置（删除 brand 块，回落到 env/内置默认）。
   * @param {string} [teamId] 预留（P1-4）；P0 重置全局。
   * @param {object} [options] { actor }
   */
  async function resetBrand(teamId, options = {}) {
    const actor = typeof options === 'string' ? options : (options && options.actor) || ''
    try {
      const config = await readConfig()
      delete config.brand
      await writeConfig(config)
      return normalizeBrand({}, process.env, actor)
    } catch (error) {
      console.error('[branding] resetBrand failed:', String(error?.message || error))
      throw Object.assign(new Error('重置品牌配置失败'), { status: 500 })
    }
  }

  return {
    getBrand,
    saveBrand,
    resetBrand,
    renderBrandScript,
    whiteLabelEnabled,
    normalizeBrand,
    publicBrand
  }
}

// 默认 dao：直接使用 db.js 的 first / run（与 ai-settings-service.js 同范式）。
const defaultDao = { first, run }

/** 具名导出（供 index.js 路由直接 import，见架构补丁 E）。 */
export const getBrand = (teamId) => buildService(defaultDao).getBrand(teamId)
export const saveBrand = (input, actor, teamId) => buildService(defaultDao).saveBrand(teamId, input, { actor })
export const resetBrand = (actor, teamId) => buildService(defaultDao).resetBrand(teamId, { actor })

/**
 * 工厂：createBrandingService({ db, config })（任务清单要求）。
 * 返回的实例方法与具名导出等价；db 需含 first/run，未提供时回落默认句柄。
 * @param {{db?: {first?: Function, run?: Function}, config?: object}} [opts]
 */
export function createBrandingService(opts = {}) {
  const db = opts && typeof opts.db === 'object' ? opts.db : {}
  const dao = (typeof db.first === 'function' && typeof db.run === 'function') ? db : defaultDao
  return buildService(dao)
}

export default createBrandingService
