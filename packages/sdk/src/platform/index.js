/**
 * @file 平台层入口
 * 重新导出核心工厂和适配器，并提供各平台便捷构造方法。
 */
import { createPlatformEys } from './core.js'
import { createMiniProgramAdapter, createReactNativeAdapter, createTaroAdapter, createUniAppAdapter } from './adapters.js'

export { createPlatformEys, createMiniProgramAdapter, createReactNativeAdapter, createTaroAdapter, createUniAppAdapter }

/** 创建微信小程序 SDK 实例（自动注入小程序适配器） */
export function createMiniProgramEys(options = {}, api) {
  return createPlatformEys(options, createMiniProgramAdapter(api))
}

/** 创建 UniApp SDK 实例 */
export function createUniAppEys(options = {}, api) {
  return createPlatformEys(options, createUniAppAdapter(api))
}

/** 创建 Taro SDK 实例 */
export function createTaroEys(options = {}, api) {
  return createPlatformEys(options, createTaroAdapter(api))
}

/** 创建 React Native SDK 实例 */
export function createReactNativeEys(options = {}, runtime) {
  return createPlatformEys(options, createReactNativeAdapter(runtime))
}
