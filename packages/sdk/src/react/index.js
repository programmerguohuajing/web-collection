/**
 * @file React 集成层
 * 提供符合 React 习惯的接入方式，对标 Vue 的 install 插件：
 * - WebCollectionProvider：在根组件初始化 SDK 一次（useEffect 仅客户端执行，SSR 安全），并通过 Context 下发实例。
 * - ErrorBoundary：捕获 React 组件渲染错误并自动上报（React 没有 Vue 那种 app.config.errorHandler 全局钩子，
 *   组件渲染错误必须用 Error Boundary 才能捕获）。
 * - useWebCollection()：在组件中获取 SDK 实例（对标 Vue 的 this.$eys）。
 *
 * 路由采集说明：SDK 已通过劫持 history.pushState / replaceState + popstate / hashchange 自动采集 SPA 路由，
 * React Router 的页面切换无需额外接入即可上报（page view / 路由变更事件自动产生）。
 *
 * 为避免与核心 SDK 重复打包，本层在构建时将 `@web-collection/sdk`（核心）作为 external 处理，
 * 运行时由消费方的打包器解析到同一份核心实例，保证全局只有一份 SDK。
 */

import {
  Component,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react'
import { createEys } from '@web-collection/sdk'

/** SDK 实例 Context，由 WebCollectionProvider 注入。 */
export const EysContext = createContext(null)

/**
 * React 根组件 Provider：在应用根挂载一次，初始化 SDK 并通过 Context 下发实例。
 * 初始化在 useEffect 中执行（仅客户端），因此 SSR（Next.js 等）天然安全，不会在服务端创建实例。
 *
 * @param {object} props
 * @param {import('@web-collection/sdk').EysOptions} [props.options] - 与 createEys 一致的配置项
 * @param {import('react').ReactNode} [props.children] - 子组件
 * @returns {import('react').ReactElement}
 */
export function WebCollectionProvider({ options = {}, children }) {
  const [eys, setEys] = useState(null)
  // 用 ref 锁定 options，保证整个组件生命周期只初始化一次（React StrictMode 双调用也不会重复 init）。
  const optionsRef = useRef(options)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const instance = createEys(optionsRef.current)
    setEys(instance)
    return () => {
      instance.destroy?.()
      setEys(null)
    }
  }, [])

  return createElement(EysContext.Provider, { value: eys }, children)
}

/**
 * React 错误边界：捕获子树渲染错误并自动上报至 Web Collection。
 * React 没有全局错误钩子（Vue 的 app.config.errorHandler），组件渲染期抛错必须用 Error Boundary 才能捕获。
 *
 * 可置于 WebCollectionProvider 内部（自动从 Context 取实例），也可通过 `eys` 属性显式传入实例。
 *
 * @example
 * <ErrorBoundary fallback={<p>页面出错了</p>}>
 *   <Routes />
 * </ErrorBoundary>
 */
export class ErrorBoundary extends Component {
  /**
   * @param {object} props
   * @param {import('react').ReactNode} [props.children]
   * @param {import('react').ReactNode} [props.fallback] - 渲染出错时展示的兜底 UI
   * @param {import('@web-collection/sdk').EysClient} [props.eys] - 显式传入实例（不传则取 Context）
   * @param {(error: Error, info: { componentStack?: string }) => void} [props.onError]
   */
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  /**
   * 渲染错误发生时上报。
   * @param {Error} error
   * @param {{ componentStack?: string }} info
   */
  componentDidCatch(error, info) {
    const instance = this.props.eys ?? this.context
    instance?.error?.(error, {
      source: 'react',
      componentStack: info?.componentStack
    })
    this.props.onError?.(error, info)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null
    }
    return this.props.children
  }
}
ErrorBoundary.contextType = EysContext

/**
 * 获取 SDK 实例（需在 WebCollectionProvider 内使用）。
 * 初始化完成前（首屏 useEffect 执行前）返回 null，建议在事件回调 / effect 中使用，而非初次渲染期依赖它。
 * @returns {import('@web-collection/sdk').EysClient | null}
 */
export function useWebCollection() {
  return useContext(EysContext)
}

/**
 * 便捷埋点 Hook：返回稳定的 track 函数（自动绑定当前 SDK 实例）。
 * @returns {(name: string, props?: Record<string, unknown>) => void}
 */
export function useTrack() {
  const eys = useContext(EysContext)
  return useCallback((name, props) => eys?.track?.(name, props), [eys])
}

/** 重新导出核心 API，便于从 react 子路径直接引用 createEys。 */
export { createEys } from '@web-collection/sdk'
