/**
 * 图形上下文丢失监控模块（MDN: WebGL / WebGPU）。
 *
 * 捕获 WebGL 上下文丢失/恢复/创建失败，以及 WebGPU 设备丢失。
 * 用于定位渲染黑屏、图形崩溃等问题（图形密集型站点高频）。
 *
 * 上报为 `GraphicsError`（kind ∈ webgl / webgpu），恢复事件作为 `graphics_event` 指标。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 性能/指标上报方法
 * @param {Function} opts.error - SDK 错误上报方法
 */
export function setupGraphicsMonitor({ metric, error }) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}

  const tagNameOf = (el) => (el && el.tagName ? String(el.tagName).toLowerCase() : 'unknown')

  // ---- WebGL：通过 document 捕获阶段监听（webglcontextlost 不冒泡，但捕获阶段可截获） ----
  const onContextLost = (e) => {
    error(new Error('WebGLContextLost'), { name: 'GraphicsError', kind: 'webgl', source: tagNameOf(e.target) })
  }
  const onContextRestored = (e) => {
    metric('graphics_event', 0, { kind: 'webgl', event: 'restored', source: tagNameOf(e.target) })
  }
  const onContextCreationError = (e) => {
    error(new Error('WebGLContextCreationError'), {
      name: 'GraphicsError',
      kind: 'webgl',
      source: tagNameOf(e.target),
      message: e.statusMessage || ''
    })
  }
  document.addEventListener('webglcontextlost', onContextLost, true)
  document.addEventListener('webglcontextrestored', onContextRestored, true)
  document.addEventListener('webglcontextcreationerror', onContextCreationError, true)

  // ---- WebGPU：包裹 requestDevice，挂载 device.lost（最佳努力） ----
  let restoreRequestDevice = () => {}
  try {
    const gpu = navigator.gpu
    if (gpu && typeof gpu.requestAdapter === 'function' && !gpu.__wcPatched) {
      const origRequestAdapter = gpu.requestAdapter.bind(gpu)
      gpu.requestAdapter = function (...args) {
        return origRequestAdapter(...args).then(adapter => {
          if (adapter && typeof adapter.requestDevice === 'function') {
            const origRequestDevice = adapter.requestDevice.bind(adapter)
            adapter.requestDevice = function (...dargs) {
              return origRequestDevice(...dargs).then(device => {
                if (device && typeof device.lost?.then === 'function') {
                  device.lost.then(info => {
                    error(new Error('WebGPUDeviceLost'), {
                      name: 'GraphicsError',
                      kind: 'webgpu',
                      reason: info?.reason || '',
                      message: info?.message || ''
                    })
                  }).catch(() => {})
                }
                return device
              })
            }
          }
          return adapter
        })
      }
      gpu.__wcPatched = true
      restoreRequestDevice = () => { gpu.__wcPatched = false; gpu.requestAdapter = origRequestAdapter }
    }
  } catch {}

  return () => {
    document.removeEventListener('webglcontextlost', onContextLost, true)
    document.removeEventListener('webglcontextrestored', onContextRestored, true)
    document.removeEventListener('webglcontextcreationerror', onContextCreationError, true)
    restoreRequestDevice()
  }
}
