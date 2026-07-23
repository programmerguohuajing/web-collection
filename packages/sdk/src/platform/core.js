const QUEUE_KEY = '__web_collection_platform_queue__'
const DEVICE_KEY = '__web_collection_device_id__'

export function createPlatformEys(options = {}, adapter) {
  if (!adapter?.request) throw new Error('Web Collection: platform request adapter is required')
  const startedAt = Date.now()

  const cfg = {
    endpoint: '/api/collect',
    appId: 'default',
    release: 'dev',
    userId: '',
    userName: '',
    userPhone: '',
    batchSize: 10,
    flushInterval: 5000,
    maxQueue: 200,
    maxRetries: 3,
    sampleRate: 1,
    collectKey: '',
    ...options
  }
  if (Math.random() > cfg.sampleRate) return noopClient()

  const sessionId = id()
  const queue = []
  const breadcrumbs = []
  const pageStarts = new WeakMap()
  const disposers = []
  let deviceId = id()
  let flushing = false
  let flushAllRequested = false
  let destroyed = false
  let persistence = Promise.resolve()
  let lastError = { fingerprint: '', ts: 0 }

  const ready = hydrate()
  const timer = setInterval(flush, cfg.flushInterval)
  registerGlobalErrors()

  return {
    track,
    error,
    metric,
    behavior,
    pageView,
    pageLeave,
    markPageReady: () => metric('data_ready', Date.now() - startedAt),
    setUser,
    flush,
    destroy,
    wrapRequest,
    wrapFetch,
    instrumentApp,
    instrumentPage
  }

  function track(name, props = {}) {
    push({ type: 'track', name, props })
  }

  function behavior(name, props = {}) {
    push({ type: 'behavior', name, props })
  }

  function metric(name, value, props = {}) {
    push({ type: 'perf', metric: name, value: Number(value), props })
  }

  function error(reason, extra = {}) {
    const err = normalizeError(reason)
    const fingerprint = `${err.name}|${err.message}|${err.stack}`
    const now = Date.now()
    if (lastError.fingerprint === fingerprint && now - lastError.ts < 1000) return
    lastError = { fingerprint, ts: now }
    push({ type: 'error', name: err.name, message: err.message, stack: err.stack, props: extra }, true)
  }

  function pageView(path, props = {}) {
    behavior('pv', { path, ...props })
  }

  function pageLeave(path, stayTime, props = {}) {
    behavior('page_leave', { path, stayTime: Math.max(0, Number(stayTime) || 0), ...props })
  }

  function setUser(user = {}) {
    cfg.userId = user.id || user.userId || cfg.userId
    cfg.userName = user.name || user.userName || cfg.userName
    cfg.userPhone = user.phone || user.userPhone || cfg.userPhone
    queue.forEach(item => {
      item.userId ||= cfg.userId
      item.userName ||= cfg.userName
      item.userPhone ||= cfg.userPhone
    })
    persist()
  }

  function push(event, urgent = false) {
    if (destroyed) return
    const context = adapter.getContext?.() || {}
    const item = {
      appId: cfg.appId,
      release: cfg.release,
      userId: cfg.userId,
      userName: cfg.userName,
      userPhone: cfg.userPhone,
      sessionId,
      deviceId,
      url: context.url || context.path || '',
      path: context.path || '',
      title: context.title || '',
      referrer: context.referrer || '',
      userAgent: context.userAgent || adapter.name || 'unknown',
      ts: Date.now(),
      retry: 0,
      breadcrumbs: event.type === 'error' ? breadcrumbs.slice(-20) : undefined,
      ...event
    }
    if (['track', 'behavior', 'perf'].includes(item.type)) {
      breadcrumbs.push({ type: item.type, name: item.name || item.metric, ts: item.ts, url: item.url })
      if (breadcrumbs.length > 20) breadcrumbs.shift()
    }
    queue.push(item)
    if (queue.length > cfg.maxQueue) queue.splice(0, queue.length - cfg.maxQueue)
    persist()
    if (urgent || queue.length >= cfg.batchSize) void flush()
  }

  async function flush(force = false) {
    await ready
    if (flushing) {
      flushAllRequested ||= force
      return
    }
    if (!queue.length) return
    flushing = true
    try {
      do {
        const batch = queue.slice(0, Math.min(cfg.batchSize, 100))
        try {
          const response = await adapter.request({
            url: cfg.endpoint,
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(cfg.collectKey ? { 'x-app-key': cfg.collectKey } : {}) },
            data: { events: batch }
          })
          const status = response?.statusCode ?? response?.status ?? 200
          if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`)
          queue.splice(0, batch.length)
        } catch {
          batch.forEach(item => item.retry++)
          queue.splice(0, batch.length, ...batch.filter(item => item.retry <= cfg.maxRetries))
          break
        }
        await persist()
      } while ((force || flushAllRequested) && queue.length)
    } finally {
      flushing = false
      flushAllRequested = false
      await persist()
    }
  }

  function wrapRequest(request = adapter.rawRequest, kind = 'request') {
    if (typeof request !== 'function') throw new Error('Web Collection: request function is required')
    return function monitoredRequest(options = {}) {
      if (String(options.url || '').startsWith(cfg.endpoint)) return request(options)
      const startedAt = Date.now()
      let recorded = false
      const record = (response, failed) => {
        if (recorded) return
        recorded = true
        const status = response?.statusCode ?? response?.status
        metric(kind, Date.now() - startedAt, { url: options.url || '', method: options.method || 'GET', status, failed })
        if (failed) error(response, { source: kind, url: options.url || '', method: options.method || 'GET', status })
      }
      const wrapped = {
        ...options,
        success(response) { record(response, false); options.success?.(response) },
        fail(reason) { record(reason, true); options.fail?.(reason) }
      }
      try {
        const result = request(wrapped)
        return result?.then
          ? result.then(response => { record(response, false); return response }, reason => { record(reason, true); throw reason })
          : result
      } catch (reason) {
        record(reason, true)
        throw reason
      }
    }
  }

  function wrapFetch(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') throw new Error('Web Collection: fetch function is required')
    return async function monitoredFetch(input, init = {}) {
      const url = typeof input === 'string' ? input : input?.url || ''
      if (url.startsWith(cfg.endpoint)) return fetchImpl(input, init)
      const startedAt = Date.now()
      try {
        const response = await fetchImpl(input, init)
        metric('fetch', Date.now() - startedAt, { url, method: init.method || 'GET', status: response.status })
        if (!response.ok) error(new Error(`HTTP ${response.status}`), { source: 'fetch', url, status: response.status })
        return response
      } catch (reason) {
        error(reason, { source: 'fetch', url, method: init.method || 'GET' })
        throw reason
      }
    }
  }

  function instrumentApp(config = {}) {
    return {
      ...config,
      onError(message) { error(message, { source: 'app' }); return config.onError?.call(this, message) },
      onUnhandledRejection(event) { error(event?.reason || event, { source: 'unhandledrejection' }); return config.onUnhandledRejection?.call(this, event) },
      onHide(...args) { void flush(true); return config.onHide?.apply(this, args) }
    }
  }

  function instrumentPage(config = {}) {
    const enter = function (query) {
      pageStarts.set(this, Date.now())
      pageView(pagePath(this), { query })
    }
    const leave = function (reason) {
      const startedAt = pageStarts.get(this)
      if (!startedAt) return
      pageStarts.delete(this)
      pageLeave(pagePath(this), Date.now() - startedAt, { reason })
    }
    return {
      ...config,
      onLoad(query) { enter.call(this, query); return config.onLoad?.call(this, query) },
      onShow(...args) { if (!pageStarts.has(this)) enter.call(this); return config.onShow?.apply(this, args) },
      onHide(...args) { leave.call(this, 'hide'); return config.onHide?.apply(this, args) },
      onUnload(...args) { leave.call(this, 'unload'); return config.onUnload?.apply(this, args) }
    }
  }

  function pagePath(page) {
    return page?.route || page?.$page?.fullPath || adapter.getContext?.().path || ''
  }

  function registerGlobalErrors() {
    if (adapter.onError) disposers.push(adapter.onError(reason => error(reason, { source: 'global' })))
    if (adapter.onUnhandledRejection) disposers.push(adapter.onUnhandledRejection(event => error(event?.reason || event, { source: 'unhandledrejection' })))
  }

  async function hydrate() {
    try {
      const [storedQueue, storedDeviceId] = await Promise.all([adapter.getStorage?.(QUEUE_KEY), adapter.getStorage?.(DEVICE_KEY)])
      if (Array.isArray(storedQueue)) queue.unshift(...storedQueue.slice(-cfg.maxQueue))
      queue.forEach(item => {
        item.userId ||= cfg.userId
        item.userName ||= cfg.userName
        item.userPhone ||= cfg.userPhone
      })
      if (storedDeviceId) {
        deviceId = storedDeviceId
        queue.forEach(item => { item.deviceId = storedDeviceId })
      }
      else await adapter.setStorage?.(DEVICE_KEY, deviceId)
    } catch {}
  }

  async function persist() {
    await ready
    const snapshot = queue.slice(-cfg.maxQueue)
    persistence = persistence.then(() => adapter.setStorage?.(QUEUE_KEY, snapshot)).catch(() => {})
    await persistence
  }

  function destroy() {
    clearInterval(timer)
    disposers.forEach(dispose => dispose?.())
    void flush(true)
    destroyed = true
  }
}

function normalizeError(reason) {
  if (reason instanceof Error) return { name: reason.name || 'Error', message: reason.message, stack: reason.stack || '' }
  if (reason && typeof reason === 'object') {
    return { name: reason.name || 'Error', message: reason.message || reason.errMsg || JSON.stringify(reason), stack: reason.stack || '' }
  }
  return { name: 'Error', message: String(reason), stack: '' }
}

function id() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function noopClient() {
  const noop = () => {}
  return { track: noop, error: noop, metric: noop, behavior: noop, pageView: noop, pageLeave: noop, markPageReady: noop, setUser: noop, flush: noop, destroy: noop, wrapRequest: request => request, wrapFetch: fetch => fetch, instrumentApp: value => value, instrumentPage: value => value }
}
