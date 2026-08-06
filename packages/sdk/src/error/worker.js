/**
 * Web Worker 错误监控模块。
 *
 * 遍历已有 Worker 实例，并代理 Worker 构造函数，
 * 确保后续创建的 Worker 也被监控。
 *
 * @param {object} opts
 * @param {Function} opts.error - SDK 主实例的 error 方法
 */
/**
 * 设置 Web Worker 错误监控
 * 遍历全局已存在的 Worker 实例并附加错误监听，同时替换全局 Worker 构造函数，
 * 确保后续创建的所有 Worker（包括 blob URL 和 string URL）都被监控。
 *
 * @param {object} opts
 * @param {Function} opts.error - SDK 主实例的 error 方法，用于上报 Worker 错误
 * @returns {Function} 恢复原始 Worker 构造函数的清理函数
 */
export function setupWorkerMonitor({ error }) {
  // 保存原生 Worker 构造函数引用，用于恢复和内部创建真实实例
  const NativeWorker = globalThis.Worker

  /**
   * 代理 Worker 构造函数
   * 创建真正的 Worker 实例后，附加 error（运行时错误）和 messageerror（反序列化失败）监听
   * @param {string|URL} source  - Worker 脚本地址
   * @param {object} [options]   - Worker 构造选项
   * @returns {Worker} 附加了错误监听的 Worker 实例
   */
  function wrapWorker(source, options) {
    const url = typeof source === 'string' ? source : source?.name || 'blob'
    try {
      // 创建真实 Worker 实例
      const worker = options ? new NativeWorker(source, options) : new NativeWorker(source)
      // 监听 Worker 运行时错误（脚本内 throw / 未捕获异常）
      worker.addEventListener('error', event => {
        error(event.error || event.message || 'WorkerError', {
          name: 'WorkerError',
          source: String(url),
          type: 'runtime',
          filename: event.filename,
          lineno: event.lineno
        })
      })
      // 监听消息反序列化错误（postMessage 传递不可序列化对象）
      worker.addEventListener('messageerror', event => {
        error(event.error || 'WorkerMessageError', {
          name: 'WorkerError',
          source: String(url),
          type: 'message'
        })
      })
      return worker
    } catch (err) {
      // Worker 构造失败（如脚本 404、CSP 拦截等）
      error(err, { name: 'WorkerError', source: String(url), type: 'creation' })
      return new NativeWorker(source, options)
    }
  }

  // 遍历全局作用域中所有属性，找到已被原始 NativeWorker 构造出的实例并附加监听
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

  // 替换全局 Worker 构造函数，拦截后续所有 new Worker() 调用
  globalThis.Worker = wrapWorker
  globalThis.Worker.prototype = NativeWorker.prototype
  // 复制静态常量（CONNECTING/OPEN/CLOSING/CLOSE 等），保持原型链和常量完整
  ; Object.assign(globalThis.Worker, NativeWorker)

  return () => {
    globalThis.Worker = NativeWorker
  }
}

/**
 * 给已有的 Worker 实例附加 onerror 事件处理
 * 通过重写 onerror 属性（而非 addEventListener），兼容通过属性方式设置错误处理的代码
 * @param {Worker} worker  - 已有的 Worker 实例
 * @param {Function} error - SDK 错误上报方法
 */
function wrapExistingWorker(worker, error) {
  const origOnError = worker.onerror
  worker.onerror = function (event) {
    error(event?.message || 'WorkerError', {
      name: 'WorkerError',
      source: 'existing-worker',
      type: 'runtime'
    })
    // 保留原有的 onerror 处理逻辑
    if (origOnError) return origOnError.call(this, event)
  }
}
