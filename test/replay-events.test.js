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

test('getReplayPlaybackBlocker：真实 Cloudflare 1102 DOM 快照（含 style/script/title/attributes）阻止播放', () => {
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
          attributes: { class: 'no-js', lang: 'en-US' },
          childNodes: [
            {
              id: 3,
              type: 2,
              tagName: 'head',
              childNodes: [
                {
                  id: 4,
                  type: 2,
                  tagName: 'title',
                  childNodes: [{ id: 5, type: 3, textContent: 'Worker exceeded resource limits | web-collection.jingguohua.cc.cd | Cloudflare' }]
                },
                {
                  id: 6,
                  type: 2,
                  tagName: 'style',
                  childNodes: [{ id: 7, type: 3, textContent: 'body { margin: 0; padding: 0; } '.repeat(300) }]
                },
                {
                  id: 8,
                  type: 2,
                  tagName: 'script',
                  childNodes: [{ id: 9, type: 3, textContent: 'console.log("some script") '.repeat(200) }]
                }
              ]
            },
            {
              id: 10,
              type: 2,
              tagName: 'body',
              childNodes: [
                {
                  id: 11,
                  type: 2,
                  tagName: 'div',
                  attributes: { id: 'cf-wrapper', class: 'cf-outer-wrapper' },
                  childNodes: [
                    {
                      id: 12,
                      type: 2,
                      tagName: 'h1',
                      childNodes: [
                        { id: 13, type: 2, tagName: 'span', attributes: { class: 'cf-error-type' }, childNodes: [{ id: 14, type: 3, textContent: 'Error' }] },
                        { id: 15, type: 2, tagName: 'span', attributes: { class: 'cf-error-code' }, childNodes: [{ id: 16, type: 3, textContent: '1102' }] }
                      ]
                    },
                    {
                      id: 17,
                      type: 2,
                      tagName: 'h2',
                      attributes: { class: 'cf-subheadline' },
                      childNodes: [{ id: 18, type: 3, textContent: 'Worker exceeded resource limits' }]
                    }
                  ]
                }
              ]
            }
          ]
        }]
      }
    }
  }])
  assert.match(reason, /Cloudflare 错误页/)
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
