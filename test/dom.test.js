import assert from 'node:assert/strict'
import { elementInfo } from '../packages/sdk/src/utils/dom.js'

const attributes = [{ name: 'placeholder', value: '请输入手机号' }]
const input = {
  tagName: 'INPUT', id: '', className: '', value: '13800138000', attributes,
  innerText: '', textContent: '', closest: () => null,
  getAttribute: name => attributes.find(item => item.name === name)?.value || ''
}
const info = elementInfo(input)

assert.equal(info.label, '请输入手机号')
assert.equal('value' in info, false)
assert.equal(info.text, '')

console.log('dom tests passed')
