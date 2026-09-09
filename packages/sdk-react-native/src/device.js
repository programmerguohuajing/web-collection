/**
 * @file 设备 / 系统 / App 版本维度合成（零 schema 改动）
 *
 * 维度落地方式（架构 §5.7）：
 * - `release` ← options.release（App 版本，维度下钻主键）
 * - `userAgent` ← 合成串 `ReactNative/<rnVersion> <osName>/<osVersion> <model>`（≤512）
 * - `context` ← 经内核 setContext() 写入，随每个事件上报：
 *   `{ platform, sdk:{name,version}, app:{version,bundleId}, os:{name,version}, device:{brand,model}, network:{type} }`
 *   受服务端 cleanObject 约束（≤50 键·每值 ≤1000 字符），本包恒定 6 个顶层键。
 *
 * 版本口径（Q-B）：`sdkVersion` 仍报内核版本（由内核写入），RN 包版本写入 `context.sdk.version`。
 */
import { CLIP_LIMITS, PLATFORM_NAME, RN_SDK_VERSION } from './constants.js'

/** 取字符串字段（空值回退）。 */
function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/**
 * 合成设备维度对象（宿主 deviceInfo 优先，其次 options.deviceInfo，缺失字段留空串）。
 * @param {{ deviceInfo?: object | null, version?: string }} [caps={}] 探测结果（runtime.detect 输出）
 * @param {{ release?: string, deviceInfo?: object | null }} [options={}]
 * @returns {{ rnVersion: string, brand: string, model: string, systemName: string, systemVersion: string, appVersion: string, bundleId: string, networkType: string }}
 */
export function buildDeviceContext(caps = {}, options = {}) {
  const fromRuntime = caps.deviceInfo && typeof caps.deviceInfo === 'object' ? caps.deviceInfo : null
  const fromOptions = options.deviceInfo && typeof options.deviceInfo === 'object' ? options.deviceInfo : null
  const info = { ...(fromOptions || {}), ...(fromRuntime || {}) }
  return {
    rnVersion: text(caps.version, 'unknown'),
    brand: text(info.brand),
    model: text(info.model || info.deviceModel),
    systemName: text(info.systemName || info.osName || info.os),
    systemVersion: text(info.systemVersion || info.osVersion),
    appVersion: text(info.appVersion || options.release, 'dev'),
    bundleId: text(info.bundleId || info.appId),
    networkType: text(info.networkType)
  }
}

/**
 * 合成 User-Agent：`ReactNative/<rnVersion> <osName>/<osVersion> <model>`，裁剪到 512。
 * @param {ReturnType<typeof buildDeviceContext>} device
 * @returns {string}
 */
export function buildUserAgent(device = {}) {
  const parts = [`ReactNative/${text(device.rnVersion, 'unknown')}`]
  if (device.systemName) parts.push(`${device.systemName}/${text(device.systemVersion, 'unknown')}`)
  else if (device.systemVersion) parts.push(`OS/${device.systemVersion}`)
  if (device.model) parts.push(device.model)
  return parts.join(' ').trim().slice(0, CLIP_LIMITS.userAgent)
}

/**
 * 构建写入 context 的维度载荷（顶层键恒定 6 个，满足 ≤50 键约束）。
 * @param {ReturnType<typeof buildDeviceContext>} device
 * @returns {object}
 */
export function buildContextPayload(device = {}) {
  const network = {}
  if (device.networkType) network.type = device.networkType
  return {
    platform: PLATFORM_NAME,
    // Q-B：RN 包版本写入 context.sdk.version；内核版本仍由内核写入 sdkVersion 字段。
    sdk: { name: PLATFORM_NAME, version: RN_SDK_VERSION },
    app: { version: text(device.appVersion, 'dev'), bundleId: device.bundleId || undefined },
    os: { name: device.systemName || undefined, version: device.systemVersion || undefined },
    device: { brand: device.brand || undefined, model: device.model || undefined },
    network
  }
}

/**
 * 将维度写入内核上下文（内核 setContext 会做 redactObject，url 置空、path 由 getContext 提供）。
 * 失败静默：维度缺失不影响采集主链路。
 * @param {{ setContext?: Function } | null} client 内核客户端
 * @param {ReturnType<typeof buildDeviceContext>} device
 * @returns {object} 实际写入的 context 载荷
 */
export function applyDeviceContext(client, device = {}) {
  const payload = buildContextPayload(device)
  try {
    client?.setContext?.(payload)
  } catch {
    // 静默：context 写入失败不阻断采集。
  }
  return payload
}
