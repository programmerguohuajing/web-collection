/**
 * 请求/响应 Body 采样模块。
 *
 * 对 fetch 和 XHR 请求，在非 2xx 时自动采集 body 摘要，
 * 对 2xx 请求按配置的采样率决定是否采集。
 * 仅采集文本类响应，截断到 2KB。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 主实例的 metric 方法
 * @param {number} [opts.sampleRate=0] - 成功请求的 body 采样率（0~1）
 * @param {number} [opts.maxBodySize=2048] - body 最大采集字节数
 */
export function setupBodySampler({ metric, sampleRate = 0, maxBodySize = 2048, sanitizer }) {
  if (sampleRate <= 0) return () => {}

  const TEXT_TYPES = ['json', 'text', 'xml', 'form', 'javascript', 'plain']
  let fetchSampler = null
  let xhrSampler = null

  // fetch body 采样
  fetchSampler = sampleFetchBody({ metric, sampleRate, maxBodySize, TEXT_TYPES, sanitizer })

  // XHR body 采样
  xhrSampler = sampleXhrBody({ metric, sampleRate, maxBodySize, TEXT_TYPES, sanitizer })

  return () => {
    fetchSampler?.restore?.()
    xhrSampler?.restore?.()
  }
}

/**
 * 劫持 window.fetch，在请求完成后按采样率采集请求/响应 body
 * - 状态码 ≥ 400 时始终采集（错误诊断）
 * - 2xx 时按 sampleRate 概率抽样采集
 * - 仅采集 text/json/xml/form/javascript 类响应，忽略二进制流
 * @param {object} opts
 * @param {Function} opts.metric      - 性能指标上报方法
 * @param {number} opts.sampleRate    - 成功请求的 body 采样率（0~1）
 * @param {number} opts.maxBodySize   - body 最大截断长度
 * @param {string[]} opts.TEXT_TYPES  - 文本类 Content-Type 关键词列表
 * @returns {{ restore: Function } | null}
 */
function sampleFetchBody({ metric, sampleRate, maxBodySize, TEXT_TYPES, sanitizer }) {
  const originalFetch = window.fetch?.bind(window)
  if (!originalFetch) return null

  window.fetch = async function (input, init = {}) {
    const url = String(input?.url || input)
    const shouldSample = () => Math.random() < sampleRate

    const res = await originalFetch(input, init)
    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase()
    const isText = TEXT_TYPES.some(t => contentType.includes(t))

    // 仅对文本类响应采集 body
    if (isText && (res.status >= 400 || shouldSample())) {
      try {
        const clone = res.clone()  // clone 一份响应用于读取 body，不消费原始响应
        const text = await clone.text()
        if (text) {
          const pair = sanitizer
            ? sanitizer.sanitizePair({
                url,
                requestBody: truncate(String(init?.body || ''), maxBodySize),
                responseBody: truncate(text, maxBodySize)
              })
            : { url, requestBody: truncate(String(init?.body || ''), maxBodySize), responseBody: truncate(text, maxBodySize) }
          metric('fetch_body', 1, {
            url: pair.url ?? url,
            status: res.status,
            requestBody: pair.requestBody,
            responseBody: pair.responseBody,
            bodySampled: res.status < 400  // 标记是否为采样（非错误强制采集）
          })
        }
      } catch {}
    }

    return res
  }

  return { restore: () => { window.fetch = originalFetch } }
}

/**
 * 劫持 XMLHttpRequest.prototype.open/send，在请求完成后按采样率采集请求/响应 body
 * 原理：open 时记录 URL/method/采样标记，send 时注册 load 事件处理器在完成后读取 body
 * @returns {{ restore: Function }}
 */
function sampleXhrBody({ metric, sampleRate, maxBodySize, TEXT_TYPES, sanitizer }) {
  const xhrOpen = XMLHttpRequest.prototype.open
  const xhrSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (...args) {
    // 在 XHR 实例上存储采样元信息：method, url, 是否命中采样
    this.__eysBody = { method: args[0], url: String(args[1]), sample: Math.random() < sampleRate }
    return xhrOpen.apply(this, args)
  }

  XMLHttpRequest.prototype.send = function (...args) {
    const info = this.__eysBody
    if (info) {
      // load 事件在请求完全完成后触发，此时 responseText 已可用
      this.addEventListener('load', function () {
        const contentType = String(this.getResponseHeader?.('content-type') || '').toLowerCase()
        const isText = TEXT_TYPES.some(t => contentType.includes(t))
        if (!isText) return

        // 错误响应始终采集，成功响应按采样率
        const shouldSample = this.status >= 400 || info.sample
        if (shouldSample && this.responseText) {
          const pair = sanitizer
            ? sanitizer.sanitizePair({
                url: info.url,
                requestBody: truncate(String(args[0] || ''), maxBodySize),
                responseBody: truncate(this.responseText, maxBodySize)
              })
            : { url: info.url, requestBody: truncate(String(args[0] || ''), maxBodySize), responseBody: truncate(this.responseText, maxBodySize) }
          metric('xhr_body', 1, {
            url: pair.url ?? info.url,
            method: info.method,
            status: this.status,
            requestBody: pair.requestBody,
            responseBody: pair.responseBody,
            bodySampled: this.status < 400
          })
        }
      }, { once: true })
    }
    return xhrSend.apply(this, args)
  }

  return { restore: () => { XMLHttpRequest.prototype.open = xhrOpen; XMLHttpRequest.prototype.send = xhrSend } }
}

/**
 * 字符串截断工具：超过 max 长度时截断并追加 [TRUNCATED] 标记
 * @param {string} str - 原始字符串
 * @param {number} max - 最大长度
 * @returns {string} 截断后的字符串
 */
function truncate(str, max) {
  if (!str) return ''
  return str.length > max ? str.slice(0, max) + '[TRUNCATED]' : str
}
