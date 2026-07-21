import { createPlatformEys } from './core.js'
import { createMiniProgramAdapter, createReactNativeAdapter, createTaroAdapter, createUniAppAdapter } from './adapters.js'

export { createPlatformEys, createMiniProgramAdapter, createReactNativeAdapter, createTaroAdapter, createUniAppAdapter }

export function createMiniProgramEys(options = {}, api) {
  return createPlatformEys(options, createMiniProgramAdapter(api))
}

export function createUniAppEys(options = {}, api) {
  return createPlatformEys(options, createUniAppAdapter(api))
}

export function createTaroEys(options = {}, api) {
  return createPlatformEys(options, createTaroAdapter(api))
}

export function createReactNativeEys(options = {}, runtime) {
  return createPlatformEys(options, createReactNativeAdapter(runtime))
}
