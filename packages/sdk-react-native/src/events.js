/**
 * @file 移动端事件映射表 —— 单一真相源（实现与测试共用）
 *
 * 硬约束（PRD §6.1 / 架构 §4）：
 * - **不新增事件 type**：type 只能取自 EVENT_TYPES 八项封闭白名单
 *   （apps/api/src/index.js:839、cloudflare/worker.js:2478 两处 sanitize 均校验）。
 *   移动端语义 100% 由 `name` / `metric` / `props` 承载。
 * - **不新增 canonical**：`app_start` / `pv` / `page_leave` 由 packages/events-schema.js
 *   现有 aliases 归一（session_started / page_viewed / page_left），SDK 侧保持发别名即可。
 * - metric ≤ 32 字符、name ≤ 160 字符（服务端 clip）。
 *
 * 本文件为纯函数 + 纯数据，无运行时依赖、无宿主 API 依赖，可在 Node 层直接断言。
 */
import {
  CLIP_LIMITS,
  COLD_START_MARK_SOURCE,
  EVENT_NAME,
  EVENT_TYPES,
  METRIC,
  NATIVE_CRASH_KIND
} from './constants.js'

export { EVENT_TYPES }

/**
 * 判断事件 type 是否在双栈封闭白名单内。
 * @param {{ type?: string }} event
 * @returns {boolean}
 */
export function assertWhitelisted(event) {
  return EVENT_TYPES.includes(event?.type)
}

/**
 * 计算事件采样分类（镜像 packages/sdk/src/core/event.js:54 eventCategory）。
 * 本包用它做「移动端指标归类」自查；真实采样仍由内核执行，两者口径必须一致。
 * @param {{ type?: string, name?: string, metric?: string }} event
 * @returns {string | undefined}
 */
export function categoryOf(event = {}) {
  if (event.type === 'error') return 'error'
  if (event.type === 'replay') return 'replay'
  if (event.type === 'behavior') return event.name === 'exposure' ? 'exposure' : 'behavior'
  if (event.type === 'perf' || event.type === 'performance') {
    return ['fetch', 'xhr', 'websocket', 'sse', 'fetch_body', 'xhr_body'].includes(event.metric) ? 'requests' : 'performance'
  }
  return undefined
}

/** 数值规整：非有限数回退 0 并取整（服务端指标一律毫秒整数）。 */
function round(value) {
  const num = Number(value)
  return Number.isFinite(num) ? Math.round(num) : 0
}

/** 字符串裁剪：超长即截断，避免服务端 clip 后语义失真。 */
function clip(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : value
}

/**
 * 标准化错误对象（兼容 Error 实例、类 Error 对象、原始值）。
 * 与内核 core.js normalizeError 同语义，保证 JS 崩溃与原生崩溃字段一致。
 * @param {unknown} reason
 * @returns {{ name: string, message: string, stack: string }}
 */
export function normalizeError(reason) {
  if (reason instanceof Error) {
    return { name: reason.name || 'Error', message: reason.message || '', stack: reason.stack || '' }
  }
  if (reason && typeof reason === 'object') {
    return {
      name: reason.name || 'Error',
      message: reason.message || reason.errMsg || safeStringify(reason),
      stack: reason.stack || ''
    }
  }
  return { name: 'Error', message: String(reason), stack: '' }
}

/** 安全 JSON 序列化（循环引用 / 抛错时降级为 String(reason)）。 */
function safeStringify(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

// ================================================================
//  映射表 builder（表驱动；MAPPING_TABLE 供测试逐行断言）
// ================================================================

/**
 * M1 · 冷启动：metric `app_cold_start`，value = 首屏可交互耗时（ms）。
 * @param {number} appReadyMs 冷启动耗时（ms）
 * @param {'cold' | 'warm'} [phase='cold'] 进程全新创建 / 进程复用仅重建
 * @param {string} [markSource='first-frame'] 终点来源：app-ready | first-frame | timeout
 * @returns {{ type: string, metric: string, value: number, name: string, props: object }}
 */
export function coldStart(appReadyMs, phase = 'cold', markSource = COLD_START_MARK_SOURCE.FIRST_FRAME) {
  const value = round(appReadyMs)
  return {
    type: 'perf',
    metric: clip(METRIC.COLD_START, CLIP_LIMITS.metric),
    value,
    name: '',
    props: { phase: phase === 'warm' ? 'warm' : 'cold', appReadyMs: value, markSource }
  }
}

/**
 * M2 · 帧率 / 卡顿：metric `frame_stats`，value = 实际 FPS。
 * @param {{ fps: number, droppedFrames?: number, longTaskMs?: number, sampleWindowMs?: number, fpsTarget?: number }} stats
 * @returns {{ type: string, metric: string, value: number, name: string, props: object }}
 */
export function frameStats(stats = {}) {
  const fps = round(stats.fps)
  return {
    type: 'perf',
    metric: clip(METRIC.FRAME_STATS, CLIP_LIMITS.metric),
    value: fps,
    name: '',
    props: {
      fps,
      droppedFrames: Math.max(0, round(stats.droppedFrames)),
      longTaskMs: Math.max(0, round(stats.longTaskMs)),
      sampleWindowMs: Math.max(0, round(stats.sampleWindowMs)),
      fpsTarget: Math.max(1, round(stats.fpsTarget))
    }
  }
}

/**
 * M3 · 网络请求：metric `fetch`（复用内核 wrapFetch，口径与 Web 端完全一致）。
 * 本 builder 仅用于契约测试与文档示例，运行时由内核 core.js:472 直接产出。
 * @param {{ url?: string, method?: string, status?: number, statusClass?: string, responseSize?: number, errorType?: string, durationMs?: number }} info
 * @returns {{ type: string, metric: string, value: number, name: string, props: object }}
 */
export function networkRequest(info = {}) {
  const status = Number(info.status)
  return {
    type: 'perf',
    metric: clip(METRIC.FETCH, CLIP_LIMITS.metric),
    value: round(info.durationMs),
    name: '',
    props: {
      url: clip(String(info.url || ''), CLIP_LIMITS.path),
      method: info.method || 'GET',
      status: Number.isFinite(status) ? status : undefined,
      statusClass: info.statusClass || (Number.isFinite(status) ? `${Math.floor(status / 100)}xx` : 'network_error'),
      responseSize: Number.isFinite(Number(info.responseSize)) ? Number(info.responseSize) : undefined,
      errorType: info.errorType
    }
  }
}

/**
 * M4 · JS 崩溃 / 未处理异常：type `error`，name = err.name。
 * @param {unknown} err 原始错误
 * @param {boolean} [isFatal=true] 宿主 ErrorUtils 传入的是否致命
 * @param {'global' | 'unhandledrejection'} [source='global']
 * @returns {{ type: string, name: string, message: string, stack: string, props: object }}
 */
export function jsCrash(err, isFatal = true, source = 'global') {
  const normalized = normalizeError(err)
  return {
    type: 'error',
    name: clip(normalized.name, CLIP_LIMITS.name),
    message: clip(normalized.message, CLIP_LIMITS.message),
    stack: clip(normalized.stack, CLIP_LIMITS.stack),
    props: { fatal: true, isFatal: Boolean(isFatal), source: source === 'unhandledrejection' ? 'unhandledrejection' : 'global' }
  }
}

/**
 * M5 · 原生崩溃（占位通道）：type `error`，name = `NativeCrash`。
 * 本批不采集，宿主桥接就绪后调用 reportNativeCrash() 上报；P1-4 支持 props.fingerprint 分组。
 * @param {{ name?: string, message?: string, stack?: string, fingerprint?: string, props?: object }} [payload={}]
 * @returns {{ type: string, name: string, message: string, stack: string, props: object }}
 */
export function nativeCrash(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {}
  return {
    type: 'error',
    name: clip(source.name || EVENT_NAME.NATIVE_CRASH, CLIP_LIMITS.name),
    message: clip(source.message || 'Native crash', CLIP_LIMITS.message),
    stack: clip(source.stack || source.nativeStack || '', CLIP_LIMITS.stack),
    props: {
      kind: NATIVE_CRASH_KIND,
      fatal: true,
      nativeStack: clip(source.nativeStack || source.stack || '', CLIP_LIMITS.stack),
      fingerprint: source.fingerprint || undefined,
      ...(source.props && typeof source.props === 'object' ? source.props : {})
    }
  }
}

/**
 * M6 · 切前台。
 * @param {number} [elapsedMs=0] 后台停留时长（ms）
 * @param {boolean} [newSession=false] 是否触发了新会话
 */
export function foreground(elapsedMs = 0, newSession = false) {
  return {
    type: 'behavior',
    name: EVENT_NAME.APP_FOREGROUND,
    props: { elapsedMs: Math.max(0, round(elapsedMs)), newSession: Boolean(newSession) }
  }
}

/**
 * M7 · 切后台（调用方随后执行 flush(true)）。
 * @param {number} [elapsedMs=0] 前台停留时长（ms）
 */
export function background(elapsedMs = 0) {
  return {
    type: 'behavior',
    name: EVENT_NAME.APP_BACKGROUND,
    props: { elapsedMs: Math.max(0, round(elapsedMs)) }
  }
}

/**
 * M8 · 会话起点（归一为 session_started）。
 * @param {boolean} [cold=true] 是否冷启动产生的首个会话
 */
export function appStart(cold = true) {
  return { type: 'behavior', name: EVENT_NAME.APP_START, props: { cold: Boolean(cold) } }
}

/**
 * M9 · 页面 / 路由进入（归一为 page_viewed）。
 * @param {string} route 路由名
 * @param {object} [props={}]
 */
export function screenView(route = '', props = {}) {
  return {
    type: 'behavior',
    name: EVENT_NAME.PV,
    props: { path: clip(String(route), CLIP_LIMITS.path), ...props }
  }
}

/**
 * M9 · 页面 / 路由离开（归一为 page_left）。
 * @param {string} route 路由名
 * @param {number} [stayMs=0] 停留时长（ms）
 * @param {object} [props={}]
 */
export function screenLeave(route = '', stayMs = 0, props = {}) {
  return {
    type: 'behavior',
    name: EVENT_NAME.PAGE_LEAVE,
    props: { path: clip(String(route), CLIP_LIMITS.path), stayTime: Math.max(0, round(stayMs)), ...props }
  }
}

/**
 * M10 · 网络类型变化（依赖宿主 NetInfo，缺失则不采集）。
 * @param {string} network 'wifi' | 'cellular' | 'none'
 */
export function networkChange(network = 'unknown') {
  return { type: 'behavior', name: EVENT_NAME.NETWORK_CHANGE, props: { network: String(network || 'unknown') } }
}

/**
 * M11 · 业务埋点（底座不感知业务语义，一律走通用原语）。
 * @param {string} name 业务事件名
 * @param {object} [props={}]
 */
export function businessTrack(name = '', props = {}) {
  return { type: 'track', name: clip(String(name), CLIP_LIMITS.name), props }
}

/**
 * 事件映射表（架构 §4 十一行逐行对应）。
 * 实现与测试共用同一份定义：测试遍历本表断言 type 白名单 / clip 长度 / category / 归一结果。
 */
export const MAPPING_TABLE = [
  { id: 'M1', semantic: '冷启动', category: 'performance', build: () => coldStart(1820, 'cold', COLD_START_MARK_SOURCE.APP_READY) },
  { id: 'M2', semantic: '帧率 / 卡顿', category: 'performance', build: () => frameStats({ fps: 57, droppedFrames: 3, longTaskMs: 120, sampleWindowMs: 1000, fpsTarget: 60 }) },
  { id: 'M3', semantic: '网络请求', category: 'requests', build: () => networkRequest({ url: 'https://api.test/orders', method: 'GET', status: 200, durationMs: 128 }) },
  { id: 'M4', semantic: 'JS 崩溃 / 未处理异常', category: 'error', build: () => jsCrash(new TypeError('undefined is not an object'), true, 'global') },
  { id: 'M5', semantic: '原生崩溃（占位）', category: 'error', build: () => nativeCrash({ message: 'SIGSEGV at 0x1', nativeStack: 'native stack trace', fingerprint: 'com.example.mall|SIGSEGV|0x1' }) },
  { id: 'M6', semantic: '切前台', category: 'behavior', build: () => foreground(45210, true) },
  { id: 'M7', semantic: '切后台', category: 'behavior', build: () => background(12345) },
  { id: 'M8', semantic: '会话起点', category: 'behavior', build: () => appStart(true) },
  { id: 'M9', semantic: '页面 / 路由进出', category: 'behavior', build: () => screenView('Home', { query: { id: '1' } }) },
  { id: 'M10', semantic: '网络类型变化', category: 'behavior', build: () => networkChange('wifi') },
  { id: 'M11', semantic: '业务埋点', category: undefined, build: () => businessTrack('add_to_cart', { sku: 'A1' }) }
]
