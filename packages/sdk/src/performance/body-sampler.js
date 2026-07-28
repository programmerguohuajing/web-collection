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
export function setupBodySampler({ metric, sampleRate = 0, maxBodySize = 2048 }) {
  if (sampleRate <= 0) return () => {}

  const TEXT_TYPES = ['json', 'text', 'xml', 'form', 'javascript', 'plain']
  let fetchSampler = null
  let xhrSampler = null

  // fetch body 采样
  fetchSampler = sampleFetchBody({ metric, sampleRate, maxBodySize, TEXT_TYPES })

  // XHR body 采样
  xhrSampler = sampleXhrBody({ metric, sampleRate, maxBodySize, TEXT_TYPES })

  return () => {
    fetchSampler?.restore?.()
    xhrSampler?.restore?.()
  }
}

function sampleFetchBody({ metric, sampleRate, maxBodySize, TEXT_TYPES }) {
  const originalFetch = window.fetch?.bind(window)
  if (!originalFetch) return null

  window.fetch = async function (input, init = {}) {
    const url = String(input?.url || input)
    const shouldSample = () => Math.random() < sampleRate

    const res = await originalFetch(input, init)
    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase()
    const isText = TEXT_TYPES.some(t => contentType.includes(t))

    if (isText && (res.status >= 400 || shouldSample())) {
      try {
        const clone = res.clone()
        const text = await clone.text()
        if (text) {
          metric('fetch_body', 1, {
            url,
            status: res.status,
            requestBody: truncate(String(init?.body || ''), maxBodySize),
            responseBody: truncate(text, maxBodySize),
            bodySampled: res.status < 400
          })
        }
      } catch {}
    }

    return res
  }

  return { restore: () => { window.fetch = originalFetch } }
}

function sampleXhrBody({ metric, sampleRate, maxBodySize, TEXT_TYPES }) {
  const xhrOpen = XMLHttpRequest.prototype.open
  const xhrSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (...args) {
    this.__eysBody = { method: args[0], url: String(args[1]), sample: Math.random() < sampleRate }
    return xhrOpen.apply(this, args)
  }

  XMLHttpRequest.prototype.send = function (...args) {
    const info = this.__eysBody
    if (info) {
      this.addEventListener('load', function () {
        const contentType = String(this.getResponseHeader?.('content-type') || '').toLowerCase()
        const isText = TEXT_TYPES.some(t => contentType.includes(t))
        if (!isText) return

        const shouldSample = this.status >= 400 || info.sample
        if (shouldSample && this.responseText) {
          metric('xhr_body', 1, {
            url: info.url,
            method: info.method,
            status: this.status,
            requestBody: truncate(String(args[0] || ''), maxBodySize),
            responseBody: truncate(this.responseText, maxBodySize),
            bodySampled: this.status < 400
          })
        }
      }, { once: true })
    }
    return xhrSend.apply(this, args)
  }

  return { restore: () => { XMLHttpRequest.prototype.open = xhrOpen; XMLHttpRequest.prototype.send = xhrSend } }
}

function truncate(str, max) {
  if (!str) return ''
  return str.length > max ? str.slice(0, max) + '[TRUNCATED]' : str
}
