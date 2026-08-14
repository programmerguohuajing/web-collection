/**
 * 媒体元素错误监控模块（MDN: HTMLMediaElement）。
 *
 * 捕获 <video> / <audio> 的播放/解码/网络错误（媒体类站点高频问题）。
 * media 的 `error` 事件不冒泡，故使用 document 捕获阶段监听截获。
 *
 * 上报为 `MediaError`，携带错误码、媒体类型与来源。
 *
 * @param {object} opts
 * @param {Function} opts.error - SDK 错误上报方法
 */
export function setupMediaMonitor({ error }) {
  if (typeof document === 'undefined') return () => {}

  const MEDIA_TAGS = ['VIDEO', 'AUDIO']

  const onMediaError = (e) => {
    const el = e.target
    if (!el || !el.tagName || !MEDIA_TAGS.includes(String(el.tagName).toUpperCase())) return
    const mediaError = el.error
    if (!mediaError) return
    error(new Error('MediaElementError'), {
      name: 'MediaError',
      mediaType: String(el.tagName).toLowerCase(),
      code: mediaError.code || 0, // 1=MEDIA_ERR_ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
      message: mediaError.message || '',
      src: (typeof el.currentSrc === 'string' && el.currentSrc) ? el.currentSrc.slice(0, 200) : ''
    })
  }

  // 捕获阶段可截获不冒泡的媒体 error 事件
  document.addEventListener('error', onMediaError, true)

  return () => {
    document.removeEventListener('error', onMediaError, true)
  }
}
