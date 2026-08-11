import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  getTableTooltipMaxWidth,
  installTableTooltipWidthTracking,
  keepTableTooltipWithinTable,
  tableConfig,
  updateTableTooltipWidth
} from '../apps/web/src/table-tooltip.js'

function reference(tableWidth) {
  const properties = new Map()
  const table = {
    getBoundingClientRect: () => ({ width: tableWidth }),
    style: { setProperty: (name, value) => properties.set(name, value) }
  }
  return {
    target: {
      closest(selector) {
        assert.equal(selector, '.el-table')
        return table
      }
    },
    properties
  }
}

test('表格 tooltip 最大宽度不超过所属表格宽度', () => {
  assert.equal(getTableTooltipMaxWidth(reference(860).target, 1440), 860)
  assert.equal(getTableTooltipMaxWidth(reference(1800).target, 1280), 1256)
  assert.equal(getTableTooltipMaxWidth(reference(320).target, 375), 320)
})

test('鼠标进入表格时先在表格容器上写入 tooltip 最大宽度', () => {
  const fixture = reference(640)
  assert.equal(updateTableTooltipWidth(fixture.target, 1440), 640)
  assert.equal(fixture.properties.get('--table-tooltip-max-width'), '640px')
})

test('表格 tooltip 锚定悬浮单元格并只在当前行上下翻转', () => {
  assert.equal(tableConfig.tooltipOptions.placement, 'top')
  assert.deepEqual(tableConfig.tooltipOptions.fallbackPlacements, ['bottom'])
  assert.equal(tableConfig.tooltipOptions.offset, 8)
  assert.equal(tableConfig.tooltipOptions.popperClass, 'table-cell-tooltip')
  assert.equal(tableConfig.tooltipOptions.showArrow, false)
  const computeStyles = tableConfig.tooltipOptions.popperOptions.modifiers[0]
  assert.equal(computeStyles.name, 'computeStyles')
  assert.equal(computeStyles.options.adaptive, false)
  assert.equal(computeStyles.options.gpuAcceleration, false)
  const keepWithinTable = tableConfig.tooltipOptions.popperOptions.modifiers[1]
  assert.equal(keepWithinTable.phase, 'afterWrite')
  assert.equal(keepWithinTable.fn, keepTableTooltipWithinTable)
})

test('全局宽度监听使用捕获阶段并可正确销毁', () => {
  const calls = []
  const root = {
    addEventListener: (...args) => calls.push(['add', ...args]),
    removeEventListener: (...args) => calls.push(['remove', ...args])
  }
  const stop = installTableTooltipWidthTracking(root)
  const [, type, handler, capture] = calls[0]
  assert.equal(type, 'mouseover')
  assert.equal(capture, true)
  stop()
  assert.deepEqual(calls[1], ['remove', type, handler, true])
})

test('超宽 tooltip 水平方向保持在表格可视边界内', () => {
  const table = { getBoundingClientRect: () => ({ left: 200, right: 1000 }) }
  const referenceElement = { closest: () => table }
  const popper = {
    style: { left: '50px' },
    getBoundingClientRect: () => ({ left: 50, right: 850 })
  }
  keepTableTooltipWithinTable({ state: { elements: { reference: referenceElement, popper } } }, 1400)
  assert.equal(popper.style.left, '200px')
})

test('表格 tooltip 隐藏系统滚动条的上下按钮', async () => {
  const css = await readFile(new URL('../apps/web/src/style.css', import.meta.url), 'utf8')
  assert.match(css, /\.table-cell-tooltip::\-webkit-scrollbar-button\s*\{[^}]*display:none;[^}]*width:0;[^}]*height:0/s)
})
