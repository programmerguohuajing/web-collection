import test from 'node:test'
import assert from 'node:assert/strict'

import { getReplayPlaybackBlocker } from '../apps/web/src/utils/replay-events.js'

test('getReplayPlaybackBlocker：缺少全量快照时阻止播放', () => {
  const reason = getReplayPlaybackBlocker([{ type: 4, timestamp: 1, data: { width: 1024, height: 768 } }])
  assert.match(reason, /缺少页面全量快照/)
})

test('getReplayPlaybackBlocker：Cloudflare 错误页快照阻止进入 rrweb 播放器', () => {
  const reason = getReplayPlaybackBlocker([{
    type: 2,
    timestamp: 1,
    data: {
      node: {
        id: 1,
        type: 0,
        childNodes: [{
          id: 2,
          type: 3,
          textContent: '<html><head><title>Worker exceeded resource limits</title></head><body>Cloudflare Ray ID: abc</body></html>'
        }]
      }
    }
  }])
  assert.match(reason, /Cloudflare 错误页/)
})

test('getReplayPlaybackBlocker：增量新增 Cloudflare 错误页时阻止播放', () => {
  const reason = getReplayPlaybackBlocker([
    {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          id: 1,
          type: 0,
          childNodes: [{ id: 2, type: 2, tagName: 'body', childNodes: [] }]
        }
      }
    },
    {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        adds: [{
          node: {
            id: 3,
            type: 2,
            tagName: 'main',
            childNodes: [
              { id: 4, type: 3, textContent: 'Error code: 1102' },
              { id: 5, type: 3, textContent: 'Worker exceeded resource limits' }
            ]
          }
        }]
      }
    }
  ])
  assert.match(reason, /Cloudflare 错误页/)
})

test('getReplayPlaybackBlocker：增量文本变成 HTML 源码时阻止播放', () => {
  const reason = getReplayPlaybackBlocker([
    {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          id: 1,
          type: 0,
          childNodes: [{ id: 2, type: 2, tagName: 'body', childNodes: [] }]
        }
      }
    },
    {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        texts: [{
          id: 9,
          value: '<html><head><title>502 Bad Gateway</title></head><body>upstream temporarily unavailable</body></html>'
        }]
      }
    }
  ])
  assert.match(reason, /HTML 源码/)
})

test('getReplayPlaybackBlocker：正常快照允许播放', () => {
  const reason = getReplayPlaybackBlocker([{
    type: 2,
    timestamp: 1,
    data: {
      node: {
        id: 1,
        type: 0,
        childNodes: [{
          id: 2,
          type: 2,
          tagName: 'html',
          childNodes: [{ id: 3, type: 2, tagName: 'body', childNodes: [] }]
        }]
      }
    }
  }])
  assert.equal(reason, '')
})
