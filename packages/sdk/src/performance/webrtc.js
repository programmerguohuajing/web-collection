/**
 * WebRTC 连接质量监控模块（MDN: WebRTC / RTCPeerConnection.getStats）。
 *
 * 代理 RTCPeerConnection 构造函数，对已建立的连接周期性调用 getStats，
 * 聚合入站/出站的关键质量指标（RTT、抖动、丢包、码率），用于音视频/RTC 产品的
 * 核心可观测性。最佳努力：连接非活跃时跳过采集。
 *
 * 上报为 `webrtc_stats` 指标。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 性能/指标上报方法
 * @param {number} [opts.interval=5000] - 采集间隔（ms）
 */
export function setupWebRtcMonitor({ metric, interval = 5000 }) {
  const Native = globalThis.RTCPeerConnection
  if (typeof Native === 'undefined') return () => {}

  function wrap(...args) {
    let pc
    try { pc = new Native(...args) } catch (err) { return new Native(...args) }

    const timer = setInterval(() => {
      const state = pc.connectionState
      if (state !== 'connected' && state !== 'connecting') return
      if (typeof pc.getStats !== 'function') return
      pc.getStats().then(report => {
        if (!report || typeof report.forEach !== 'function') return
        let rtt = null
        let jitter = null
        let packetsLost = 0
        let bytesReceived = 0
        let bytesSent = 0
        let inboundKbps = 0
        let outboundKbps = 0
        report.forEach(s => {
          if (s.type === 'candidate-pair' && (s.nominated || s.selected)) {
            if (typeof s.currentRoundTripTime === 'number') rtt = Math.round(s.currentRoundTripTime * 1000)
            if (typeof s.jitter === 'number') jitter = Math.round(s.jitter * 1000)
          }
          if (s.type === 'inbound-rtp') {
            if (typeof s.packetsLost === 'number') packetsLost += s.packetsLost
            if (typeof s.bytesReceived === 'number') bytesReceived += s.bytesReceived
            if (typeof s.jitter === 'number') jitter = jitter == null ? Math.round(s.jitter * 1000) : jitter
          }
          if (s.type === 'outbound-rtp') {
            if (typeof s.bytesSent === 'number') bytesSent += s.bytesSent
          }
        })
        metric('webrtc_stats', 0, {
          connectionState: state,
          rtt,
          jitter,
          packetsLost,
          bytesReceived,
          bytesSent,
          inboundKbps: Math.round((bytesReceived * 8) / 1000 / (interval / 1000)),
          outboundKbps: Math.round((bytesSent * 8) / 1000 / (interval / 1000))
        })
      }).catch(() => {})
    }, interval)

    const origClose = pc.close ? pc.close.bind(pc) : null
    if (origClose) {
      pc.close = function () { clearInterval(timer); return origClose() }
    } else {
      pc.addEventListener?.('connectionstatechange', () => {
        if (pc.connectionState === 'closed' || pc.connectionState === 'failed') clearInterval(timer)
      })
    }
    return pc
  }

  globalThis.RTCPeerConnection = wrap
  Object.assign(wrap, Native)

  return () => { globalThis.RTCPeerConnection = Native }
}
