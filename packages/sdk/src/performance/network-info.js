/**
 * 网络质量变化监控模块（MDN: Network Information API）。
 *
 * 环境指纹已采集连接快照；本模块补充 `change` 事件，实时上报网络类型/下行速率/
 * RTT/saveData 的变化（在线/离线已由 network_change 覆盖，这里关注质量变化）。
 *
 * 上报为 `network_quality` 指标。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 性能/指标上报方法
 */
export function setupNetworkInfoMonitor({ metric }) {
  if (typeof navigator === 'undefined') return () => {}
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  if (!conn || typeof conn.addEventListener !== 'function') return () => {}

  const emit = () => {
    metric('network_quality', 0, {
      connectionType: conn.type || '',
      effectiveType: conn.effectiveType || '',
      downlink: conn.downlink,
      rtt: conn.rtt,
      saveData: !!conn.saveData
    })
  }

  conn.addEventListener('change', emit)
  return () => { try { conn.removeEventListener('change', emit) } catch {} }
}
