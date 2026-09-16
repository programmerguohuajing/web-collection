function visitReplayNode(node, cb) {
  if (!node || typeof node !== 'object') return
  const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : ''
  if (tag === 'script' || tag === 'style') return

  cb(node)
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) visitReplayNode(child, cb)
  }
}

function appendLimited(parts, value, limit) {
  if (typeof value !== 'string' || !value) return 0
  const used = parts.reduce((sum, item) => sum + item.length, 0)
  const available = limit - used
  if (available <= 0) return 0
  parts.push(value.slice(0, available))
  return Math.min(value.length, available)
}

function collectNodeText(node, parts, limit) {
  visitReplayNode(node, item => {
    const textVal = item.textContent || item.text || item.value || item.nodeValue || item.data
    appendLimited(parts, textVal, limit)
    const attrs = item.attributes
    if (attrs && typeof attrs === 'object') {
      for (const val of Object.values(attrs)) {
        if (typeof val === 'string') appendLimited(parts, val, limit)
      }
    }
  })
}

function eventText(event, limit = 16000) {
  const parts = []
  if (event?.type === 2) {
    collectNodeText(event.data?.node, parts, limit)
  }
  if (event?.type === 3) {
    if (Array.isArray(event.data?.adds)) {
      for (const item of event.data.adds) collectNodeText(item?.node, parts, limit)
    }
    if (Array.isArray(event.data?.texts)) {
      for (const item of event.data.texts) appendLimited(parts, item?.value || item?.text || item?.textContent, limit)
    }
    if (Array.isArray(event.data?.attributes)) {
      for (const item of event.data.attributes) {
        const attrs = item?.attributes
        if (!attrs || typeof attrs !== 'object') continue
        for (const value of Object.values(attrs)) appendLimited(parts, value, limit)
      }
    }
  }
  appendLimited(parts, event?.data?.text, limit)
  return parts.join(' ').trim()
}

function isHtmlSourceText(text) {
  return /<!doctype html|<html[\s>][\s\S]*<head[\s>][\s\S]*<body[\s>]/i.test(text)
}

function isCloudflareEdgeErrorText(text) {
  return /worker exceeded resource limits|error code:\s*1\d{3}|error\s+1\d{3}|cloudflare ray id|ray id:\s*[a-f0-9]+|cf-error|cf-wrapper/i.test(text)
}

export function getReplayPlaybackBlocker(events) {
  if (typeof events === 'string') {
    if (isCloudflareEdgeErrorText(events) || isHtmlSourceText(events)) {
      return '该会话录到的是 Cloudflare 错误页（Worker 资源超限），不是业务页面快照，已阻止 rrweb 播放'
    }
  }
  const list = Array.isArray(events) ? events : []
  if (!list.some(event => event?.type === 2)) {
    return '该会话缺少页面全量快照（仅有交互事件），无法重建播放画面'
  }
  for (const event of list) {
    const text = eventText(event)
    if (isCloudflareEdgeErrorText(text)) {
      return '该会话录到的是 Cloudflare 错误页（Worker 资源超限），不是业务页面快照，已阻止 rrweb 播放'
    }
    if (isHtmlSourceText(text)) {
      return '该会话快照内容疑似 HTML 源码文本，不是可还原的页面 DOM，已阻止 rrweb 播放'
    }
  }
  return ''
}
