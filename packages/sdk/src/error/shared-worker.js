/**
 * SharedWorker 错误监控模块（MDN: SharedWorker）。
 *
 * 对标 Web Worker 监控：代理 SharedWorker 构造函数，并为实例附加 onerror
 * 监听（捕获 SharedWorker 脚本加载/语法等致命错误）。SharedWorker 内部运行时
 * 错误发生在共享 worker 作用域、不会冒泡到页面，故仅能覆盖构造/加载期错误。
 *
 * @param {object} opts
 * @param {Function} opts.error - SDK 主实例的 error 方法
 * @returns {Function} 恢复原始 SharedWorker 构造函数的清理函数
 */
export function setupSharedWorkerMonitor({ error }) {
  const NativeSharedWorker = globalThis.SharedWorker
  if (typeof NativeSharedWorker === 'undefined') return () => {}

  function wrapSharedWorker(source, options) {
    const url = typeof source === 'string' ? source : source?.name || 'blob'
    try {
      const worker = options ? new NativeSharedWorker(source, options) : new NativeSharedWorker(source)
      worker.onerror = function (event) {
        error(event?.message || 'SharedWorkerError', {
          name: 'SharedWorkerError',
          source: String(url),
          type: 'runtime',
          filename: event?.filename,
          lineno: event?.lineno
        })
      }
      return worker
    } catch (err) {
      error(err, { name: 'SharedWorkerError', source: String(url), type: 'creation' })
      return new NativeSharedWorker(source, options)
    }
  }

  globalThis.SharedWorker = wrapSharedWorker
  Object.assign(globalThis.SharedWorker, NativeSharedWorker)

  return () => { globalThis.SharedWorker = NativeSharedWorker }
}
