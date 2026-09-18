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

import { recordPointerEvent, recordSnapshotEvent } from './replay.js'

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

/**
 * 方案二（默认提供）：触控与手势轨迹监听容器 Component
 * 包裹在根 App / View 外层，自动收集向下传递的 Touch 事件坐标与触摸状态。
 */
export function EysPointerTouchListener({ children, style, ...restProps }) {
  const client = useContext(EysContext)

  const handleTouch = useCallback((kind, event) => {
    try {
      if (!client || client.options?.replay?.enablePointerReplay === false) return
      const touches = event?.nativeEvent?.touches || event?.nativeEvent?.changedTouches
      const touch = Array.isArray(touches) && touches.length ? touches[0] : event?.nativeEvent
      if (!touch) return
      const x = touch.pageX ?? touch.locationX ?? 0
      const y = touch.pageY ?? touch.locationY ?? 0
      const pointerId = touch.identifier ?? 1
      recordPointerEvent(client, { kind, x, y, pointerId })
    } catch {
      /* 静默降级 */
    }
  }, [client])

  return createElement('View', {
    style: style || { flex: 1 },
    onTouchStart: (e) => handleTouch('down', e),
    onTouchMove: (e) => handleTouch('move', e),
    onTouchEnd: (e) => handleTouch('up', e),
    onTouchCancel: (e) => handleTouch('up', e),
    ...restProps
  }, children)
}

/**
 * 方案一（用户可选）：画面快照录制容器 Component
 * 定时通过 captureRef 拦截画面图片分片，上传为 canvas_snapshot 事件。
 */
export function EysSnapshotBoundary({ children, style, captureRef, snapshotIntervalMs, ...restProps }) {
  const client = useContext(EysContext)

  useEffect(() => {
    if (!client || client.options?.replay?.enableSnapshotReplay !== true) return
    const interval = snapshotIntervalMs || client.options?.replay?.snapshotIntervalMs || 2000

    const timer = setInterval(async () => {
      try {
        let imageData = ''
        let width = 375
        let height = 667
        if (typeof captureRef === 'function') {
          const res = await captureRef()
          if (res) {
            imageData = typeof res === 'string' ? res : res.imageData || ''
            width = res.width || width
            height = res.height || height
          }
        }
        if (imageData) {
          recordSnapshotEvent(client, { imageData, width, height })
        }
      } catch {
        /* 静默降级 */
      }
    }, interval)

    return () => clearInterval(timer)
  }, [client, captureRef, snapshotIntervalMs])

  return createElement('View', { style: style || { flex: 1 }, ...restProps }, children)
}

export { recordPointerEvent, recordSnapshotEvent }
export default EysProvider

