/**
 * @file 事件口径单一真相源（Phase 0 · P0-3）
 * 定义 canonical（标准）事件名及其历史别名映射，供 SDK 发送、Node API 与
 * Cloudflare Worker 查询层共用。新 SDK 只发送标准名；查询层对旧名做兼容归一。
 *
 * 设计依据：tracking-platform-comparison-and-evolution-plan.md §6.1。
 * 该模块为纯函数 / 纯数据，无运行时依赖，可被前端、Node 与 Worker 同时 import。
 */

/**
 * 标准事件定义。
 * aliases：历史/客户端旧名，查询层遇到这些名时归一为 canonical。
 * group：用于指标/维度归类（page / session / interaction / form）。
 */
export const CANONICAL_EVENTS = {
  page_viewed: {
    canonical: 'page_viewed',
    aliases: ['pv', 'pageview', 'view'],
    group: 'page',
    description: '页面访问；路由切换是否产生 PV 必须由 SDK 去重'
  },
  page_left: {
    canonical: 'page_left',
    aliases: ['page_leave', 'pageview_end'],
    group: 'page',
    description: '页面退出与停留时长'
  },
  session_started: {
    canonical: 'session_started',
    aliases: ['app_start', 'session_start', 'visit_start'],
    group: 'session',
    description: '会话起点，不可直接用任意行为事件代替'
  },
  element_clicked: {
    canonical: 'element_clicked',
    aliases: ['click'],
    group: 'interaction',
    description: '点击事件'
  },
  element_exposed: {
    canonical: 'element_exposed',
    aliases: ['exposure', 'impression'],
    group: 'interaction',
    description: '曝光事件'
  },
  form_started: {
    canonical: 'form_started',
    aliases: ['form_start'],
    group: 'form',
    description: '表单开始'
  },
  form_submitted: {
    canonical: 'form_submitted',
    aliases: ['form_submit'],
    group: 'form',
    description: '表单提交'
  }
}

/** 旧名 → 标准名 的扁平映射，便于 O(1) 查表。 */
export const EVENT_ALIASES = Object.values(CANONICAL_EVENTS).reduce((map, def) => {
  for (const alias of def.aliases) map[alias] = def.canonical
  return map
}, {})

/**
 * 将任意事件名归一为标准名。
 * - 已是标准名：原样返回；
 * - 命中别名：返回标准名；
 * - 未知名：原样返回（不静默丢弃，交由后续治理/漏斗候选项）。
 * @param {string} name
 * @returns {string}
 */
export function resolveEventName(name) {
  if (!name) return name
  const key = String(name).trim().toLowerCase()
  return EVENT_ALIASES[key] || CANONICAL_EVENTS[key]?.canonical || name
}

/**
 * 判断给定事件名是否为（或兼容为）某个标准事件。
 * @param {string} name 原始事件名
 * @param {string} canonical 目标标准事件
 * @returns {boolean}
 */
export function isCanonical(name, canonical) {
  return resolveEventName(name) === canonical
}

/** 所有标准事件名列表。 */
export const CANONICAL_EVENT_NAMES = Object.keys(CANONICAL_EVENTS)
