/**
 * @file React 适配 Hook（T05 · 唯一允许 import 'react' 的文件）
 *
 * 范式对齐 packages/sdk/src/react/index.js：Context 下发实例、useEffect 内初始化、
 * useCallback 稳定引用。本文件经 vite.react.config.js 构建为独立的
 * dist/sdk-react-native.react.js(.cjs)，且 react 被 external 化（不进产物）。
 *
 * 红线：本文件之外，src/** 严禁 import 'react-native' / 'react'（no-web-globals 测试强制）。
 */
import { createContext, useContext, useEffect, useRef, useState, useCallback, createElement } from 'react'
import { createReactNativeEys } from './index.js'

const EysContext = createContext(null)
EysContext.displayName = 'WebCollectionEysContext'

/**
 * Provider：在子树内提供 React Native 客户端实例。
 * 若传入 client 则复用（受控），否则在挂载时创建并 start()。
 * @param {{ options?: object, runtime?: object, client?: object|null, children?: any }} props
 */
export function EysProvider({ options, runtime, client: provided, children }) {
  const [client, setClient] = useState(provided || null)
  const ref = useRef(provided || null)

  useEffect(() => {
    if (provided) {
      ref.current = provided
      try { provided.start && provided.start() } catch { /* 启动失败不影响渲染 */ }
      return () => { try { provided.destroy && provided.destroy() } catch { /* 静默 */ } }
    }
    let cancelled = false
    let instance = null
    try {
      instance = createReactNativeEys(options, runtime)
    } catch {
      instance = null
    }
    if (instance && !cancelled) {
      ref.current = instance
      setClient(instance)
      try { instance.start && instance.start() } catch { /* 静默 */ }
    }
    return () => {
      cancelled = true
      if (instance) {
        try { instance.destroy && instance.destroy() } catch { /* 静默 */ }
      }
      ref.current = null
    }
    // 仅挂载时初始化一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createElement(EysContext.Provider, { value: client }, children)
}

/** 取当前客户端实例（未初始化时为 null）。 */
export function useWebCollection() {
  return useContext(EysContext)
}

/**
 * 稳定的 track 包装（useCallback），避免每次渲染产生新引用。
 * @returns {(name: string, props?: object) => void}
 */
export function useTrack() {
  const client = useContext(EysContext)
  return useCallback((name, props) => {
    try { client && client.track && client.track(name, props) } catch { /* 静默 */ }
  }, [client])
}

export default EysProvider
