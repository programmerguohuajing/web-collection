/**
 * 初始化 Fetch 请求监控。
 * 通过劫持 `window.fetch` 方法，在不影响原有逻辑的前提下记录请求耗时和状态。
 * 过滤掉自身采集接口的请求，避免循环上报。
 *
 * @param {object} opts
 * @param {Function} opts.originalFetch - 原始 fetch 引用
 * @param {string} opts.endpoint - 采集接口地址，用于过滤
 * @param {Function} opts.metric - 性能指标上报方法
 * @param {Function} opts.error - 错误上报方法
 */
export function setupFetchMonitor({ originalFetch, endpoint, metric, error }) {
  if (!originalFetch) return

  window.fetch = async (input, init = {}) => {
    const url = String(input?.url || input)
    const start = performance.now()
    try {
      const res = await originalFetch(input, init)
      if (!url.includes(endpoint)) {
        metric('fetch', performance.now() - start, { url, method: init.method || 'GET', status: res.status, ok: res.ok })
      }
      return res
    } catch (err) {
      if (!url.includes(endpoint)) error(err, { name: 'FetchError', source: url })
      throw err
    }
  }
}
