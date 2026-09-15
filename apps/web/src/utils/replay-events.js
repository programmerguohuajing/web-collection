function visitReplayNode(node, cb) {
  if (!node || typeof node !== 'object') return
  cb(node)
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) visitReplayNode(child, cb)
  }
}

function snapshotText(event, limit = 5000) {
  let text = ''
  visitReplayNode(event?.data?.node, node => {
    if (text.length >= limit) return
    if (typeof node.textContent === 'string') text += ` ${node.textContent.slice(0, limit - text.length)}`
  })
  return text.trim()
}

function isHtmlSourceText(text) {
  return text.length > 200 && /<html[\s>][\s\S]*<head[\s>][\s\S]*<body[\s>]/i.test(text)
}

function isCloudflareEdgeErrorText(text) {
  return /worker exceeded resource limits|error code:\s*1\d{3}|cloudflare ray id/i.test(text)
}

export function getReplayPlaybackBlocker(events) {
  const list = Array.isArray(events) ? events : []
  const fullSnapshot = list.find(event => event?.type === 2)
  if (!fullSnapshot) {
    return '该会话缺少页面全量快照（仅有交互事件），无法重建播放画面'
  }
  const text = snapshotText(fullSnapshot)
  if (isCloudflareEdgeErrorText(text)) {
    return '该会话录到的是 Cloudflare 错误页（Worker 资源超限），不是业务页面快照，已阻止 rrweb 播放'
  }
  if (isHtmlSourceText(text)) {
    return '该会话快照内容疑似 HTML 源码文本，不是可还原的页面 DOM，已阻止 rrweb 播放'
  }
  return ''
}
