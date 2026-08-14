/**
 * 存储配额用量监控模块（MDN: Storage API / StorageManager.estimate）。
 *
 * 采集应用 IndexedDB/localStorage 的已用空间与配额，辅助诊断 SDK 自身队列
 * 与业务存储压力。`estimate()` 为异步且部分浏览器受限，故独立为可选 monitor。
 *
 * @param {object} opts
 * @param {object} opts.context - SDK 全局上下文对象
 * @param {boolean} [opts.enabled=false] - 是否启用（默认关闭，隐私/成本考量）
 * @param {number} [opts.interval=0] - 周期复采间隔（ms），0 表示仅初始化时采一次
 */
export function setupStorageMonitor({ context, enabled = false, interval = 0 }) {
  if (!enabled || !context || typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.estimate !== 'function') {
    return () => {}
  }

  const sample = () => {
    navigator.storage.estimate().then(est => {
      if (!context.environment) context.environment = {}
      context.environment.storage = {
        usage: est.usage || 0,
        quota: est.quota || 0,
        usageRatio: est.quota ? Number(((est.usage || 0) / est.quota).toFixed(4)) : 0
      }
    }).catch(() => {})
  }

  sample()
  let timer = 0
  if (interval > 0) timer = setInterval(sample, interval)

  return () => { if (timer) clearInterval(timer) }
}
