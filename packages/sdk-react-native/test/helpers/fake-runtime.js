/**
 * @file Fake 宿主运行时（测试用，可控）
 *
 * 提供手动驱动的 AppState、Map 实现的 AsyncStorage、记录请求的 fetch、
 * 可链式测试的 ErrorUtils、frameSource（手动驱动帧）、NetInfo、deviceInfo。
 */
export function createFakeRuntime(overrides = {}) {
  const subscribers = []
  const appState = {
    addEventListener: (type, cb) => {
      const sub = {
        remove: () => {
          const i = subscribers.indexOf(cb)
          if (i >= 0) subscribers.splice(i, 1)
        }
      }
      subscribers.push(cb)
      return sub
    },
    _emit: (state) => subscribers.slice().forEach((cb) => cb(state))
  }

  const store = new Map()
  const storage = {
    getItem: (k) => Promise.resolve(store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, v)
      return Promise.resolve()
    },
    removeItem: (k) => {
      store.delete(k)
      return Promise.resolve()
    }
  }

  const fetches = []
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init })
    return { status: 200, statusCode: 200, ok: true }
  }

  const errorUtils = {
    _handler: null,
    setGlobalHandler: (h) => {
      errorUtils._handler = h
    },
    getGlobalHandler: () => errorUtils._handler
  }

  const rafCbs = []
  const frameSource = (cb) => {
    rafCbs.push(cb)
    return () => {
      const i = rafCbs.indexOf(cb)
      if (i >= 0) rafCbs.splice(i, 1)
    }
  }

  const netInfo = {
    addEventListener: () => ({ remove() {} }),
    fetch: () => Promise.resolve({ type: 'wifi' })
  }

  return {
    appState,
    storage,
    fetch: fetchImpl,
    errorUtils,
    frameSource,
    hermes: { enablePromiseRejectionTracker: () => {} },
    netInfo,
    deviceInfo: { brand: 'Fake', model: 'X', systemName: 'FakeOS', systemVersion: '1.0' },
    rafCbs,
    fetches,
    store,
    emitAppState: (state) => appState._emit(state)
  }
}
