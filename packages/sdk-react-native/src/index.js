/**
 * @file 公开入口（T02 · createReactNativeEys / createEysRN）
 *
 * 模块级 MODULE_INIT_TS 作为冷启动参考点（= SDK 模块被求值的时刻）。
 * 内核平台模块经静态 import 注入 factory（peerDependency，宿主必备）；
 * 若运行时内核缺失（极端情况），factory 内部判定后返回 noop 客户端 + core_missing 诊断。
 */
import { createPlatformEys, createReactNativeAdapter } from '@web-collection/sdk/platform'
import { createReactNativeEysWithCore } from './factory.js'

/** 内核平台模块句柄（注入 factory 的 core 参数）。 */
const moduleCore = { createPlatformEys, createReactNativeAdapter }

/** 模块求值时刻（冷启动起点）。 */
const MODULE_INIT_TS = Date.now()

/**
 * 创建 React Native 客户端。
 * @param {object} [options={}] 用户选项
 * @param {object} [runtime={}] 宿主能力注入对象
 * @returns {import('./index.js').ReactNativeEysClient}
 */
export function createReactNativeEys(options, runtime) {
  const core = typeof createPlatformEys === 'function' ? moduleCore : null
  return createReactNativeEysWithCore(options, runtime, core, MODULE_INIT_TS)
}

/** 别名（与 Web 端 createEys 命名风格一致）。 */
export const createEysRN = createReactNativeEys

/** 暴露可注入内核的装配函数（测试友好）。 */
export { createReactNativeEysWithCore }

export default createReactNativeEys
