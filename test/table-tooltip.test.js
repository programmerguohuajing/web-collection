import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTableTooltipWidth, getTableTooltipMaxWidth, tableConfig } from '../apps/web/src/table-tooltip.js'

function reference(tableWidth) {
  return {
    closest(selector) {
      assert.equal(selector, '.el-table')
      return { getBoundingClientRect: () => ({ width: tableWidth }) }
    }
  }
}

test('表格 tooltip 最大宽度不超过所属表格宽度', () => {
  assert.equal(getTableTooltipMaxWidth(reference(860), 1440), 860)
  assert.equal(getTableTooltipMaxWidth(reference(1800), 1280), 1256)
  assert.equal(getTableTooltipMaxWidth(reference(320), 375), 320)
})

test('Popper 修饰器在布局测量前写入 tooltip 最大宽度', () => {
  const popper = { style: {} }
  applyTableTooltipWidth({ state: { elements: { reference: reference(640), popper } } })
  assert.equal(popper.style.maxWidth, '640px')
  assert.equal(popper.style.width, 'max-content')
  const modifier = tableConfig.tooltipOptions.popperOptions.modifiers[0]
  assert.equal(modifier.phase, 'beforeRead')
  assert.equal(tableConfig.tooltipOptions.popperClass, 'table-cell-tooltip')
})
