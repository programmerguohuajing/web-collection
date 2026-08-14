/**
 * Web Share 意图监控模块（MDN: Web Share API）。
 *
 * 包裹 navigator.share，记录分享触发与成败（仅元数据，不含分享内容）。
 * AbortError 视为用户主动取消，不记为失败。
 *
 * 上报为 `web_share` 行为事件：phase ∈ attempt / success / cancel / failure。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 事件推送方法
 */
export function setupWebShareMonitor({ push }) {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return () => {}

  const native = navigator.share.bind(navigator)
  navigator.share = function (data) {
    const d = data || {}
    push({
      type: 'behavior',
      name: 'web_share',
      props: {
        phase: 'attempt',
        hasUrl: !!d.url,
        hasText: !!d.text,
        hasTitle: !!d.title,
        hasFiles: !!(d.files && d.files.length)
      }
    })
    return native(d).then(res => {
      push({ type: 'behavior', name: 'web_share', props: { phase: 'success' } })
      return res
    }).catch(err => {
      if (err && err.name === 'AbortError') {
        push({ type: 'behavior', name: 'web_share', props: { phase: 'cancel' } })
      } else {
        push({ type: 'behavior', name: 'web_share', props: { phase: 'failure', reason: (err && err.name) || 'error' } })
      }
      throw err
    })
  }

  return () => { navigator.share = native }
}
