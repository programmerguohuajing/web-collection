/**
 * @file 部署能力开关单一真相源（Phase 0 · P0-4）
 * Node API 与 Cloudflare Worker 都从本模块生成 `/api/capabilities` 响应，
 * 避免两处硬编码不一致（历史上 Worker 永久返回 productAnalyticsV2:false，
 * 导致前端静默隐藏“事件分析”Tab，违反“不能静默隐藏”原则）。
 *
 * 原则：能力开关必须反映部署真实支持的功能，不允许永久硬编码为全 false。
 * 某能力短期未实现时，前端应显示“当前部署不支持”，而非静默隐藏入口。
 */

/**
 * 能力开关的标准键集合。新增能力必须登记于此，Node 与 Worker 才会同构输出。
 * - traffic：标准流量（Phase 1）
 * - insights：事件分析（productAnalyticsV2 的规范名）
 * - funnels / dashboards / paths / live / releases：现有分析能力
 * - eventDefinitions / journeys：数据质量与用户旅程（Phase 2，当前均未实现）
 */
export const CAPABILITY_KEYS = [
  'traffic',
  'insights',
  'funnels',
  'dashboards',
  'paths',
  'live',
  'releases',
  'eventDefinitions',
  'journeys'
]

/** 旧布尔字段 → 规范键 的向后兼容映射（前端仍可能读 productAnalyticsV2）。 */
export const LEGACY_KEY_MAP = { productAnalyticsV2: 'insights' }

/**
 * Node API 当前真实支持的能力。
 * Node 已实现事件分析（analytics_insights），但标准流量/事件定义/用户旅程尚未开发。
 */
export const NODE_CAPABILITIES = {
  traffic: false,
  insights: true,
  funnels: true,
  dashboards: true,
  paths: true,
  live: true,
  releases: true,
  eventDefinitions: false,
  journeys: false
}

/**
 * Cloudflare Worker 当前真实支持的能力。
 * Worker 无事件分析端点（/api/analytics/insights），故 insights 为 false；
 * 其余分析能力（paths/live/releases/funnels/dashboards）Worker 已实现，保持 true。
 * 注意：仅 insights 一项差异，不是“整体未实现”。
 */
export const WORKER_CAPABILITIES = {
  traffic: false,
  insights: false,
  funnels: true,
  dashboards: true,
  paths: true,
  live: true,
  releases: true,
  eventDefinitions: false,
  journeys: false
}

/**
 * 基于基线能力构建最终响应对象：补齐所有标准键（缺省 false），
 * 应用覆盖项，并写入向后兼容别名 productAnalyticsV2。
 * @param {Record<string, boolean>} base
 * @param {Record<string, boolean>} [overrides]
 * @returns {Record<string, boolean>}
 */
export function buildCapabilities(base, overrides = {}) {
  const caps = { ...base }
  for (const key of CAPABILITY_KEYS) {
    if (!(key in caps)) caps[key] = false
  }
  Object.assign(caps, overrides)
  // 向后兼容：旧前端读 productAnalyticsV2，等价于 insights。
  caps.productAnalyticsV2 = Boolean(caps.insights)
  return caps
}
