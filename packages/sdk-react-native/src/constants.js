/**
 * @file RN 包常量与默认值（单一真相源）
 *
 * 硬约束备忘（本包不可突破）：
 * 1. 事件 type 只能取自 EVENT_TYPES 八项封闭白名单（apps/api/src/index.js:839、
 *    cloudflare/worker.js:2478 两处 sanitize 均校验，新增 type 会被双栈同时拒收）。
 * 2. metric / name 受服务端 clip 约束（metric ≤ 32、name ≤ 160）。
 * 3. 存储 key 与内核 core.js:17-18 完全一致，保证 deviceId 跨启动稳定。
 */

/**
 * RN 包版本号：构建时由 vite `define` 注入真实版本（取自 package.json），
 * 确保运行时写入 context.sdk.version 的值与发包版本一致，杜绝手写常量漏改。
 * 测试 / 直引 src（无 define 注入）时回退占位值，不影响逻辑。
 */
export const RN_SDK_VERSION =
  typeof __RN_SDK_VERSION__ !== 'undefined' ? __RN_SDK_VERSION__ : '0.0.0-dev'

/** 平台标记：与 applications.platform 取值一致（cloudflare/migrations/0001_init.sql:9）。 */
export const PLATFORM_NAME = 'react-native'

/**
 * 事件 type 封闭白名单（双栈 sanitize 一致）。
 * 注：`performance` 会被服务端归一为 `perf`；本包一律直接发 `perf`。
 */
export const EVENT_TYPES = ['track', 'perf', 'performance', 'behavior', 'error', 'replay', 'log', 'trace']

/**
 * 服务端字段 clip 上限（cloudflare/worker.js:2478 及 cleanObject 约束），超出会被截断。
 * 移动端指标命名必须落在该范围内。
 */
export const CLIP_LIMITS = {
  metric: 32,
  name: 160,
  message: 500,
  stack: 4000,
  userAgent: 512,
  path: 512,
  url: 2048,
  contextKeys: 50,
  contextValue: 1000,
  propsKeys: 80,
  propsValue: 1000
}

/** metric 名（≤32 字符，进 performance / requests 分类） */
export const METRIC = {
  /** 冷启动耗时（ms） */
  COLD_START: 'app_cold_start',
  /** 帧率 / 卡顿采样窗口汇总 */
  FRAME_STATS: 'frame_stats',
  /** 网络请求（复用内核 wrapFetch，自动归入 requests 分类） */
  FETCH: 'fetch'
}

/**
 * behavior / error 事件名。
 * 生命周期名直接命中 packages/events-schema.js 既有 canonical 或别名，
 * 由服务端 resolveEventName() 归一（app_start→session_started、pv→page_viewed、page_leave→page_left）。
 */
export const EVENT_NAME = {
  APP_START: 'app_start',
  APP_FOREGROUND: 'app_foreground',
  APP_BACKGROUND: 'app_background',
  PV: 'pv',
  PAGE_LEAVE: 'page_leave',
  NETWORK_CHANGE: 'network_change',
  NATIVE_CRASH: 'NativeCrash'
}

/** 原生崩溃事件固定标记（占位通道；本批不采集，仅预留字段与通道） */
export const NATIVE_CRASH_KIND = 'native_crash'

/** 诊断事件名（经 options.onDiagnostic 出口，不含业务敏感数据） */
export const DIAGNOSTIC = {
  /** 存储未注入 / 读写失败，已降级为内存队列 */
  STORAGE_DEGRADED: 'storage_degraded',
  /** 内核不可用或网络层全无，返回 noop 客户端 */
  CORE_MISSING: 'core_missing',
  /** 宿主能力缺失（appState / jsCrash / frameStats …），该模块静默关闭 */
  CAPABILITY_MISSING: 'capability_missing',
  /** SDK 内部异常（已被 safe/guard 吞掉，未向上抛） */
  SDK_INTERNAL_ERROR: 'sdk_internal_error',
  /** 模块连续异常达到熔断阈值，永久关闭 */
  MODULE_DISABLED: 'module_disabled'
}

/** 存储 key（与内核 core.js:17-18 完全一致） */
export const STORAGE_KEYS = {
  QUEUE: '__web_collection_platform_queue__',
  DEVICE: '__web_collection_device_id__'
}

/** 冷启动终点来源（决定 props.markSource） */
export const COLD_START_MARK_SOURCE = {
  /** 业务显式调用 markAppReady() */
  APP_READY: 'app-ready',
  /** 首帧回调到达 */
  FIRST_FRAME: 'first-frame',
  /** 超时兜底 */
  TIMEOUT: 'timeout'
}

/**
 * 移动端默认配置（在内核 core.js:31-59 默认值之上覆盖）。
 * 口径说明：
 * - maxQueue 500：移动端离线时长更长、单条事件更小（PRD P0-8 / Q4）。
 * - batchSize 20、flushInterval 20000：移动端缩短上报间隔（内核默认 10 / 60000）。
 * - sessionTimeoutMs 30000：后台超 30s 回前台算新会话。**Q-A：若与现有 Web sessions 口径冲突，以 Web 口径为准。**
 * - autoWrapGlobalFetch false：默认不静默改写宿主全局（Q-D）。
 * - crash.native false：原生崩溃占位通道默认关闭，宿主桥接就绪后显式开启（Q-G）。
 */
export const DEFAULTS = {
  endpoint: '/api/collect',
  appId: 'default',
  release: 'dev',
  collectKey: '',
  environment: 'production',
  userId: '',
  userName: '',
  userPhone: '',
  sampleRate: 1,
  batchSize: 20,
  flushInterval: 20000,
  minFlushInterval: 2000,
  maxQueue: 500,
  maxRetries: 3,
  enabled: true,
  consent: 'granted',
  privacy: {},
  beforeSend: null,
  onDiagnostic: null,
  categorySampleRates: {},
  // ---- RN 专属默认值 ----
  sessionTimeoutMs: 30000,
  coldStartTimeoutMs: 3000,
  coldStart: { enabled: true },
  frameStats: {
    enabled: true,
    sampleWindowMs: 1000,
    reportIntervalMs: 10000,
    fpsTarget: 60,
    longTaskThresholdMs: 100
  },
  network: { enabled: true, autoWrapGlobalFetch: false },
  crash: { js: true, rejection: true, native: false },
  deviceInfo: null
}

/** 模块熔断阈值：同一模块连续 3 次异常即永久关闭（失效安全 L3） */
export const CIRCUIT_BREAKER_THRESHOLD = 3

/** 数值钳位区间（非致命校验用，越界时回退默认并记诊断） */
export const CLAMP = {
  maxQueue: { min: 50, max: 2000 },
  batchSize: { min: 1, max: 100 },
  flushInterval: { min: 1000, max: 600000 },
  minFlushInterval: { min: 0, max: 600000 },
  maxRetries: { min: 0, max: 10 },
  sampleRate: { min: 0, max: 1 },
  sessionTimeoutMs: { min: 0, max: 3600000 },
  coldStartTimeoutMs: { min: 100, max: 60000 },
  reportIntervalMs: { min: 1000, max: 600000 },
  sampleWindowMs: { min: 100, max: 60000 },
  fpsTarget: { min: 1, max: 240 },
  longTaskThresholdMs: { min: 1, max: 10000 }
}
