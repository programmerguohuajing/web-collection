/**
 * 计算压力监控模块（MDN: Compute Pressure API）。
 *
 * 通过 PressureObserver 采集 CPU/散热压力信号（新标准，渐进增强）。
 * 上报为 `compute_pressure` 指标：source / state / cpu{...}。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 性能/指标上报方法
 */
export function setupComputePressureMonitor({ metric }) {
  if (typeof PressureObserver === 'undefined') return () => {}

  let observer
  try {
    observer = new PressureObserver((changes) => {
      for (const change of changes) {
        const rec = { source: change.source || '', state: change.state || '' }
        if (change.cpu) rec.cpu = { ...change.cpu }
        if (change.thermal) rec.thermal = { ...change.thermal }
        metric('compute_pressure', 0, rec)
      }
    })

    const tryObserve = (src) => { try { observer.observe(src); return true } catch { return false } }
    const supported = PressureObserver.supportedSources || []
    let observed = false
    for (const s of supported) { if (tryObserve(s)) observed = true }
    if (!observed) observed = tryObserve('cpu')
    if (!observed) { try { observer.disconnect() } catch {} return () => {} }
  } catch {
    return () => {}
  }

  return () => { try { observer.disconnect() } catch {} }
}
