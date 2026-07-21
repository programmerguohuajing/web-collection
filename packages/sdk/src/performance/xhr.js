/**
 * 初始化 XMLHttpRequest 请求监控。
 * 通过劫持 `open` 和 `send` 方法，在请求发送时记录起始时间，
 * 在 `loadend` 事件中计算总耗时并上报。
 * 过滤掉自身采集接口的请求，避免循环上报。
 *
 * @param {object} opts
 * @param {string} opts.endpoint - 采集接口地址，用于过滤
 * @param {Function} opts.metric - 性能指标上报方法
 */
export function setupXhrMonitor({ endpoint, metric }) {
  const xhrOpen = XMLHttpRequest.prototype.open
  const xhrSend = XMLHttpRequest.prototype.send

  // 劫持 open：记录请求方法和 URL
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__eys = { method, url: String(url), start: 0 }
    return xhrOpen.call(this, method, url, ...rest)
  }

  // 劫持 send：记录起始时间，在 loadend 时计算耗时
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__eys) {
      this.__eys.start = performance.now()
      this.addEventListener('loadend', () => {
        if (!this.__eys.url.includes(endpoint)) {
          metric('xhr', performance.now() - this.__eys.start, { url: this.__eys.url, method: this.__eys.method, status: this.status })
        }
      }, { once: true })
    }
    return xhrSend.apply(this, args)
  }
}
