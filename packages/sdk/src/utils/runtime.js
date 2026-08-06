/**
 * 运行时版本信息采集模块。
 *
 * 支持两种注入方式：
 * 1. 自动读取：检测 window.__WEB_COLLECTION_VERSION__、window.__BUILD_TIME__ 等约定字段
 * 2. 手动配置：通过 config.runtimeInfo 传入
 *
 * @param {object} opts
 * @param {object} opts.context - SDK 全局上下文对象
 * @param {object} [opts.config] - runtimeInfo 配置
 */
export function setupRuntimeMonitor({ context, config }) {
  if (!context) return () => {}

  const runtime = collectRuntime(config)
  if (Object.keys(runtime).length) {
    context.runtime = runtime
  }

  return () => {}
}

/**
 * 采集运行时版本信息
 * 支持两种来源（优先级从高到低）：
 *   1. 手动配置：通过 config 对象传入 buildId/buildTime/commit/branch
 *   2. 自动读取：从 window.__WEB_COLLECTION_*__ 全局变量读取（CI 构建注入）
 *
 * @param {boolean|object} config - runtimeInfo 配置（false/对象）
 * @returns {object} { buildId?, buildTime?, commit?, branch? }
 */
function collectRuntime(config) {
  if (typeof window === 'undefined') return {}
  const info = {}

  // 手动配置模式（优先级最高）
  if (config && typeof config === 'object') {
    if (config.buildId) info.buildId = String(config.buildId)
    if (config.buildTime) info.buildTime = String(config.buildTime)
    if (config.commit) info.commit = String(config.commit)
    if (config.branch) info.branch = String(config.branch)
    return info
  }

  // 自动读取模式：从 window 上的约定字段读取（由 CI/构建脚本注入）
  const win = typeof window !== 'undefined' ? window : {}
  const fields = {
    buildId: '__WEB_COLLECTION_BUILD_ID__',
    buildTime: '__WEB_COLLECTION_BUILD_TIME__',
    commit: '__WEB_COLLECTION_COMMIT__',
    branch: '__WEB_COLLECTION_BRANCH__'
  }

  for (const [key, prop] of Object.entries(fields)) {
    if (win[prop]) info[key] = String(win[prop])
  }

  return info
}
