/**
 * 设备与环境指纹采集模块。
 *
 * 在 SDK 初始化时采集一次设备环境信息，存储到 globalContext 中，
 * 使所有后续事件自动携带环境上下文。
 *
 * @param {object} opts
 * @param {object} opts.context - SDK 全局上下文对象（由 createEys 传入 globalContext）
 * @param {boolean} [opts.enabled=true] - 是否启用
 */
export function setupEnvironmentMonitor({ context, enabled = true }) {
  if (!enabled || !context) return () => {}

  const env = collectEnvironment()
  if (Object.keys(env).length) {
    context.environment = env
  }

  // 视口尺寸变化时更新（200ms 防抖）
  let resizeTimer = 0
  const onResize = () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      if (context.environment) {
        context.environment.viewportWidth = window.innerWidth
        context.environment.viewportHeight = window.innerHeight
      }
    }, 200)
  }

  if (enabled) {
    addEventListener('resize', onResize, { passive: true })
  }

  return () => {
    clearTimeout(resizeTimer)
    removeEventListener('resize', onResize)
  }
}

/**
 * 采集设备与环境指纹信息
 * 涵盖屏幕、视口、语言、网络、电池、平台能力与设备画像等多个维度。
 *
 * 新增（能力缺口清单 P0/P1）：
 * - UA Client Hints（结构化 UA，替代脆弱的 UA 字符串解析）
 * - CPU 逻辑核数（hardwareConcurrency）
 * - 设备内存（deviceMemory）
 * - 安全上下文（isSecureContext）与最大触摸点数（maxTouchPoints）
 * - 屏幕方向快照（screen.orientation）
 * - 扩展特性支持位（含 GPU/WebRTC/SharedWorker/剪贴板/Web Share/计算压力/元素计时等）
 *
 * @returns {object} 环境信息对象
 */
function collectEnvironment() {
  if (typeof window === 'undefined') return {}
  const env = {}

  // ---- 屏幕信息 ----
  env.screenWidth = screen.width
  env.screenHeight = screen.height
  env.devicePixelRatio = window.devicePixelRatio || 1
  env.colorDepth = screen.colorDepth

  // ---- 视口信息（实时动态更新） ----
  env.viewportWidth = window.innerWidth
  env.viewportHeight = window.innerHeight

  // ---- 语言与区域 ----
  env.language = navigator.language || ''
  env.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  env.timezoneOffset = new Date().getTimezoneOffset()

  // ---- 平台信息 ----
  env.platform = navigator.platform || ''
  env.vendor = navigator.vendor || ''
  env.cookieEnabled = navigator.cookieEnabled
  env.doNotTrack = navigator.doNotTrack || ''

  // ---- UA Client Hints（结构化 UA，MDN: User-Agent Client Hints）----
  try {
    const ua = navigator.userAgentData
    if (ua) {
      env.uaClientHints = {
        mobile: !!ua.mobile,
        model: ua.model || '',
        architecture: ua.architecture || '',
        bitness: ua.bitness || '',
        formFactors: Array.isArray(ua.formFactors) ? ua.formFactors : [],
        brands: Array.isArray(ua.brands) ? ua.brands.map(b => `${b.brand} ${b.version}`) : []
      }
    }
  } catch {}

  // ---- 设备画像：CPU 核数 / 内存 ----
  try { if (typeof navigator.hardwareConcurrency === 'number') env.hardwareConcurrency = navigator.hardwareConcurrency } catch {}
  try { if (typeof navigator.deviceMemory === 'number') env.deviceMemory = navigator.deviceMemory } catch {}

  // ---- 安全上下文 & 触摸能力 ----
  try {
    env.secureContext = typeof window.isSecureContext === 'boolean'
      ? window.isSecureContext
      : (typeof location !== 'undefined' && location.protocol === 'https:')
  } catch {}
  try { if (typeof navigator.maxTouchPoints === 'number') env.maxTouchPoints = navigator.maxTouchPoints } catch {}

  // ---- 屏幕方向快照 ----
  try {
    if (typeof screen !== 'undefined' && screen.orientation) {
      env.screenOrientation = { type: screen.orientation.type || '', angle: screen.orientation.angle || 0 }
    }
  } catch {}

  // ---- 网络信息（Network Information API） ----
  try {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
    if (conn) {
      env.connectionType = conn.type || ''
      env.effectiveType = conn.effectiveType || ''
      env.downlink = conn.downlink
      env.rtt = conn.rtt
      env.saveData = !!conn.saveData
    }
  } catch {}

  // ---- 电池信息（Battery Status API，异步采集） ----
  try {
    if (navigator.getBattery) {
      navigator.getBattery().then(batt => {
        env.batteryLevel = Math.round(batt.level * 100)
        env.batteryCharging = batt.charging
      }).catch(() => {})
    }
  } catch {}

  // ---- 浏览器特性支持检测 ----
  env.features = collectFeatures()

  return env
}

/**
 * 采集浏览器平台能力支持位（基于特征检测，不含 PII）。
 * 用于丰富 environment.features，并支撑消费方按能力灰度。
 * @returns {object}
 */
function collectFeatures() {
  let webgl = false
  try {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas')
      webgl = !!(c.getContext('webgl') || c.getContext('experimental-webgl'))
    }
  } catch {}

  let elementTiming = false
  try {
    elementTiming = typeof PerformanceObserver !== 'undefined' &&
      Array.isArray(PerformanceObserver.supportedEntryTypes) &&
      PerformanceObserver.supportedEntryTypes.includes('element')
  } catch {}

  return {
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    webWorker: typeof Worker !== 'undefined',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    webAssembly: typeof WebAssembly !== 'undefined',
    intersectionObserver: typeof window !== 'undefined' && 'IntersectionObserver' in window,
    performanceObserver: typeof window !== 'undefined' && 'PerformanceObserver' in window,
    // 新增能力位
    uaClientHints: typeof navigator !== 'undefined' && !!navigator.userAgentData,
    hardwareConcurrency: typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number',
    deviceMemory: typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number',
    secureContext: typeof window !== 'undefined' && window.isSecureContext === true,
    maxTouchPoints: typeof navigator !== 'undefined' && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0,
    screenOrientation: typeof screen !== 'undefined' && !!screen.orientation,
    storageManager: typeof navigator !== 'undefined' && !!(navigator.storage && navigator.storage.estimate),
    permissions: typeof navigator !== 'undefined' && !!(navigator.permissions && navigator.permissions.query),
    reportingObserver: typeof ReportingObserver !== 'undefined',
    pageLifecycle: typeof document !== 'undefined' && 'onfreeze' in document,
    gpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    webrtc: typeof RTCPeerConnection !== 'undefined',
    sharedWorker: typeof SharedWorker !== 'undefined',
    fullscreen: typeof document !== 'undefined' && document.fullscreenEnabled === true,
    clipboard: typeof navigator !== 'undefined' && !!(navigator.clipboard && navigator.clipboard.readText),
    webShare: typeof navigator !== 'undefined' && typeof navigator.share === 'function',
    computePressure: typeof PressureObserver !== 'undefined',
    elementTiming,
    webgl
  }
}
