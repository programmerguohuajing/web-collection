/**
 * Worker 上下文环境探针（MDN: WorkerGlobalScope / WorkerNavigator / WorkerLocation）。
 *
 * 回应「SDK 是否采集 Worker 作用域内属性」的问题：SDK 主线程无法直接读取
 * WorkerNavigator / WorkerLocation，因此本探针在启用时生成一个极轻量内联 Worker，
 * 由其读取自身 `self.navigator` 与 `self.location` 并回传，主线程写入
 * context.environment.workerContext。最佳努力：CSP 拦截 blob worker 时静默跳过。
 *
 * @param {object} opts
 * @param {object} opts.context - SDK 全局上下文对象
 * @param {boolean} [opts.enabled=false] - 是否启用（默认关闭）
 */
export function setupWorkerContextProbe({ context, enabled = false }) {
  if (!enabled || !context || typeof Worker === 'undefined') return () => {}

  let worker = null
  let settled = false

  const cleanup = () => { try { if (worker) worker.terminate() } catch {} }

  const src = `
    (function () {
      var n = self.navigator || {};
      var l = self.location || {};
      var scope = 'worker';
      try {
        if (typeof DedicatedWorkerGlobalScope !== 'undefined' && self instanceof DedicatedWorkerGlobalScope) scope = 'dedicated';
        else if (typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope) scope = 'shared';
      } catch (e) {}
      self.postMessage({
        globalScope: scope,
        navigator: {
          userAgent: n.userAgent || '',
          language: n.language || '',
          platform: n.platform || '',
          hardwareConcurrency: typeof n.hardwareConcurrency === 'number' ? n.hardwareConcurrency : null,
          deviceMemory: typeof n.deviceMemory === 'number' ? n.deviceMemory : null,
          onLine: typeof n.onLine === 'boolean' ? n.onLine : null
        },
        location: {
          href: l.href || '',
          origin: l.origin || '',
          protocol: l.protocol || '',
          host: l.host || ''
        }
      });
    })();
  `

  try {
    const blob = new Blob([src], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    worker = new Worker(url)
    const timer = setTimeout(() => { if (!settled) cleanup() }, 3000)
    worker.onmessage = (e) => {
      settled = true
      clearTimeout(timer)
      if (!context.environment) context.environment = {}
      context.environment.workerContext = e.data
      URL.revokeObjectURL(url)
      cleanup()
    }
    worker.onerror = () => { settled = true; clearTimeout(timer); try { URL.revokeObjectURL(url) } catch {} cleanup() }
  } catch {
    cleanup()
  }

  return cleanup
}
