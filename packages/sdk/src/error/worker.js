/**
 * Web Worker 错误监控模块。
 *
 * 遍历已有 Worker 实例，并代理 Worker 构造函数，
 * 确保后续创建的 Worker 也被监控。
 *
 * @param {object} opts
 * @param {Function} opts.error - SDK 主实例的 error 方法
 */
export function setupWorkerMonitor({ error }) {
  const NativeWorker = globalThis.Worker

  function wrapWorker(source, options) {
    const url = typeof source === 'string' ? source : source?.name || 'blob'
    try {
      const worker = options ? new NativeWorker(source, options) : new NativeWorker(source)
      worker.addEventListener('error', event => {
        error(event.error || event.message || 'WorkerError', {
          name: 'WorkerError',
          source: String(url),
          type: 'runtime',
          filename: event.filename,
          lineno: event.lineno
        })
      })
      worker.addEventListener('messageerror', event => {
        error(event.error || 'WorkerMessageError', {
          name: 'WorkerError',
          source: String(url),
          type: 'message'
        })
      })
      return worker
    } catch (err) {
      error(err, { name: 'WorkerError', source: String(url), type: 'creation' })
      return new NativeWorker(source, options)
    }
  }

  // 代理已有 Worker 实例
  const workers = []
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    const val = globalThis[key]
    if (val && val.constructor && val.constructor === NativeWorker) {
      workers.push(val)
    }
  }
  for (const w of workers) {
    try { wrapExistingWorker(w, error) } catch {}
  }

  // 替换全局构造函数
  globalThis.Worker = wrapWorker
  globalThis.Worker.prototype = NativeWorker.prototype
  ; Object.assign(globalThis.Worker, NativeWorker)

  return () => {
    globalThis.Worker = NativeWorker
  }
}

function wrapExistingWorker(worker, error) {
  const origOnError = worker.onerror
  worker.onerror = function (event) {
    error(event?.message || 'WorkerError', {
      name: 'WorkerError',
      source: 'existing-worker',
      type: 'runtime'
    })
    if (origOnError) return origOnError.call(this, event)
  }
}
