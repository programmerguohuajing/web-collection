import assert from 'node:assert/strict'
import test from 'node:test'
import { formatFinding, deliverFinding } from '../packages/ai/notify.js'

const finding = {
  scope: 'error-cluster', object: 'TypeError', appId: 'a',
  summary: '错误簇「TypeError」近 24h 出现 120 次', confidence: 0.8,
  evidence: ['error:TypeError', 'count:120']
}

test('formatFinding：标题与正文含范围/对象/证据', () => {
  const { title, text } = formatFinding(finding)
  assert.ok(title.includes('错误簇'))
  assert.ok(text.includes('TypeError'))
  assert.ok(text.includes('count:120'))
})

test('deliverFinding：webhook 通道收到结构化 payload', async () => {
  const calls = []
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200 } }
  const channels = [{ id: 1, type: 'webhook', config: { endpoint: 'https://hook.example/x' } }]
  const res = await deliverFinding(finding, { channels, fetchImpl })
  assert.equal(res.length, 1)
  assert.equal(res[0].ok, true)
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.scope, 'error-cluster')
  assert.ok(body.title, 'webhook 推送应含 title 字段')
})

test('deliverFinding：feishu 通道收到互动卡片', async () => {
  const calls = []
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200 } }
  const channels = [{ id: 2, type: 'feishu', config: { endpoint: 'https://open.feishu.cn/card' } }]
  await deliverFinding(finding, { channels, fetchImpl })
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.msg_type, 'interactive')
  assert.ok(body.card.header.title.content.includes('错误簇'))
})

test('deliverFinding：dingtalk 通道收到 markdown', async () => {
  const calls = []
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200 } }
  const channels = [{ id: 3, type: 'dingtalk', config: { endpoint: 'https://oapi.dingtalk.com/robot' } }]
  await deliverFinding(finding, { channels, fetchImpl })
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.msgtype, 'markdown')
  assert.ok(body.markdown.text.includes('TypeError'))
})

test('deliverFinding：endpoint 缺失则记录错误，不抛异常', async () => {
  const fetchImpl = async () => { throw new Error('no net') }
  const channels = [{ id: 4, type: 'webhook', config: {} }]
  const res = await deliverFinding(finding, { channels, fetchImpl })
  assert.equal(res.length, 1)
  assert.equal(res[0].ok, false)
  assert.ok(res[0].error)
})
