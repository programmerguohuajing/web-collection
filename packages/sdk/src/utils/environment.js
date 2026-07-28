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

function collectEnvironment() {
  if (typeof window === 'undefined') return {}
  const env = {}

  // 屏幕
  env.screenWidth = screen.width
  env.screenHeight = screen.height
  env.devicePixelRatio = window.devicePixelRatio || 1
  env.colorDepth = screen.colorDepth

  // 视口
  env.viewportWidth = window.innerWidth
  env.viewportHeight = window.innerHeight

  // 语言与区域
  env.language = navigator.language || ''
  env.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  env.timezoneOffset = new Date().getTimezoneOffset()

  // 平台
  env.platform = navigator.platform || ''
  env.vendor = navigator.vendor || ''
  env.cookieEnabled = navigator.cookieEnabled
  env.doNotTrack = navigator.doNotTrack || ''

  // 网络
  try {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
    if (conn) {
      env.connectionType = conn.type || ''
      env.effectiveType = conn.effectiveType || ''
      env.downlink = conn.downlink
      env.rtt = conn.rtt
    }
  } catch {}

  // 电池
  try {
    if (navigator.getBattery) {
      navigator.getBattery().then(batt => {
        env.batteryLevel = Math.round(batt.level * 100)
        env.batteryCharging = batt.charging
      }).catch(() => {})
    }
  } catch {}

  // 特性支持
  env.features = {
    serviceWorker: 'serviceWorker' in navigator,
    webWorker: typeof Worker !== 'undefined',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    webAssembly: typeof WebAssembly !== 'undefined',
    intersectionObserver: 'IntersectionObserver' in window,
    performanceObserver: 'PerformanceObserver' in window
  }

  return env
}
