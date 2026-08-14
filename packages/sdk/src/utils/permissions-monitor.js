/**
 * 权限状态监控模块（MDN: Permissions API）。
 *
 * 采集关键浏览器权限的授予状态快照（通知/定位/相机/麦克风等），
 * 用于理解能力可用性与用户授权分布。权限状态非 PII，但属敏感上下文，
 * 故默认关闭，需显式开启。
 *
 * @param {object} opts
 * @param {object} opts.context - SDK 全局上下文对象
 * @param {boolean} [opts.enabled=false] - 是否启用（默认关闭）
 * @param {string[]} [opts.names] - 需查询的权限名清单，缺省使用内置常用清单
 */
export function setupPermissionsMonitor({ context, enabled = false, names }) {
  if (!enabled || !context || typeof navigator === 'undefined' || !navigator.permissions || typeof navigator.permissions.query !== 'function') {
    return () => {}
  }

  const defaultNames = [
    'geolocation',
    'notifications',
    'camera',
    'microphone',
    'clipboard-read',
    'clipboard-write',
    'persistent-storage',
    'midi',
    'push'
  ]
  const list = Array.isArray(names) && names.length ? names : defaultNames

  const sample = () => {
    Promise.all(list.map(name => {
      try {
        return navigator.permissions.query({ name }).then(s => ({ [name]: s.state })).catch(() => ({ [name]: 'unsupported' }))
      } catch {
        return Promise.resolve({ [name]: 'unsupported' })
      }
    })).then(results => {
      const permissions = Object.assign({}, ...results)
      if (!context.environment) context.environment = {}
      context.environment.permissions = permissions
    }).catch(() => {})
  }

  sample()
  return () => {}
}
