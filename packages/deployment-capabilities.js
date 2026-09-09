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
  'journeys',
  'accounts',
  'slo',
  // B3 · 合成监控（主动探针）：Node 随代码发布即支持；Worker 需 SYNTHETIC_ENABLED=1
  'synthetic',
  // D1 · 数据主体权利 DSR（PRD 13）：Node 随代码发布即支持；Worker 需 DSR_ENABLED=1
  'dsr',
  // A3 · 实验分析（PRD 14）：Node 随代码发布即支持；Worker 需 EXPERIMENTS_ENABLED=1 env 门禁
  'experiments',
  // D3 · 用量计量 & 套餐（PRD 15）：Node 随代码发布即支持；Worker 需 METERING_ENABLED=1 env 门禁
  'metering',
  // D4 · 白标 / 私有化（PRD 16）：Node 随代码发布即支持；Worker 需 WHITE_LABEL_ENABLED=1 env 门禁
  'whiteLabel'
]

/** 旧布尔字段 → 规范键 的向后兼容映射（前端仍可能读 productAnalyticsV2）。 */
export const LEGACY_KEY_MAP = { productAnalyticsV2: 'insights' }

/**
 * Node API 当前真实支持的能力。
 * PRD 集合落地后：journeys（01 用户链路）与 eventDefinitions（02 事件字典）均已实现。
 */
export const NODE_CAPABILITIES = {
  traffic: false,
  insights: true,
  funnels: true,
  dashboards: true,
  paths: true,
  live: true,
  releases: true,
  eventDefinitions: true,
  journeys: true,
  // D2 账号/团队/RBAC：后端能力已落地（M1）；运行时开关见 isAccountsEnabled()
  //（默认 false 不破坏存量自托管；开启需 ACCOUNTS_ENABLED=1 + ACCOUNTS_JWT_SECRET）
  accounts: true,
  // B2 · SLO / 错误预算：Node 先行（M1 完整闭环）；Worker 镜像验收后再翻 true（原则 #4 兜底）。
  slo: true,
  // B3 · 合成监控：Node 自托管升级即得（服务层 + 调度器随代码发布）；Worker 走 env 门禁（原则 #4 兜底）。
  synthetic: true,
  // D1 · DSR：Node 自托管升级即得（服务层随代码发布；依赖账号体系 RBAC，未开启 accounts 时路由 403）；
  // Worker 走 env 门禁（DSR_ENABLED=1，原则 #4 兜底）。
  dsr: true,
  // A3 · 实验分析：Node 自托管升级即得（experiment-service 随代码发布）；Worker 走 env 门禁
  //（EXPERIMENTS_ENABLED=1，原则 #4 兜底）。
  experiments: true,
  // D3 · 用量计量：Node 自托管升级即得（metering-service 随代码发布）；Worker 走 env 门禁
  //（METERING_ENABLED=1，原则 #4 兜底）。
  metering: true,
  // D4 · 白标：Node 自托管升级即得（branding-service 随代码发布）；Worker 走 env 门禁
  //（WHITE_LABEL_ENABLED=1，原则 #4 兜底）。
  whiteLabel: true
}

/**
 * Cloudflare Worker 当前真实支持的能力。
 * Worker 无事件分析端点（/api/analytics/insights），故 insights 为 false；
 * 其余分析能力 Worker 已实现；PRD 集合的 journeys/eventDefinitions 双端同步实现。
 */
export const WORKER_CAPABILITIES = {
  traffic: false,
  insights: false,
  funnels: true,
  dashboards: true,
  paths: true,
  live: true,
  releases: true,
  eventDefinitions: true,
  journeys: true,
  // D2：Worker 侧 auth/team 端点未实现（Node 先行，PRD D9）——必须报 false，
  // 前端据此隐藏登录态/团队入口，绝不上报未实现能力（原则 #4）
  accounts: false,
  // B2 · SLO：Worker 镜像实现与 Node 同套数学（packages/slo.js），但本批**保持 false**，
  // 待 QA 在 Worker 侧验证 SLO 路由 / 定时 tick / 燃尽投递后再由 lead 翻 true（原则 #4 兜底，绝不上报未实现）。
  slo: false,
  // B3 · 合成监控：Worker 侧路由 + 分钟 cron tick 已实现，但依赖 SYNTHETIC_ENABLED=1 env 门禁，
  // 未开启（含 QA 验收前）保持 false（原则 #4 兜底，绝不上报未验证能力）。
  synthetic: false,
  // D1 · DSR：Worker 侧路由已实现，但依赖 DSR_ENABLED=1 env 门禁；未开启保持 false（原则 #4 兜底）。
  dsr: false,
  // A3 · 实验分析：Worker 侧路由已实现，但依赖 EXPERIMENTS_ENABLED=1 env 门禁；
  // 未开启保持 false（原则 #4 兜底；最终值在 worker.js buildCapabilities override 按 env 注入）。
  experiments: false,
  // D3 · 用量计量：Worker 侧内联 meteringXxxW 已实现，但依赖 METERING_ENABLED=1 env 门禁；
  // 未开启保持 false（原则 #4 兜底）。
  metering: false,
  // D4 · 白标：Worker 侧 /brand.js 与 /api/brand 路由已实现，但依赖 WHITE_LABEL_ENABLED=1 env 门禁；
  // 未开启保持 false（原则 #4 兜底）。
  whiteLabel: false
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
