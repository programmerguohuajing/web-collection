import assert from 'node:assert/strict'
import { setupClickMonitor } from '../src/behavior/click.js'

let listener
globalThis.addEventListener = (_, callback) => { listener = callback }

const events = []
setupClickMonitor({ push: event => events.push(event) })

const div = {
  nodeType: 1,
  tagName: 'DIV',
  id: '',
  className: 'custom-button',
  attributes: [],
  innerText: '提交订单',
  textContent: '提交订单',
  closest: () => null,
  getAttribute: () => ''
}
listener({ target: div })

assert.equal(events[0].name, 'click')
assert.equal(events[0].props.elementLabel, '提交订单')
assert.equal(events[0].props.elementType, 'DIV')

const image = {
  ...div,
  tagName: 'IMG',
  className: '',
  innerText: '',
  textContent: '',
  getAttribute: name => name === 'alt' ? '商品主图' : ''
}
listener({ target: image })
assert.equal(events[1].props.elementLabel, '商品主图')

listener({ target: { ...image, getAttribute: () => '' } })
assert.equal(events[2].props.elementLabel, '')

listener({ target: { ...image, tagName: 'UNI-BUTTON', getAttribute: () => '' } })
assert.equal(events[3].props.elementLabel, '')
