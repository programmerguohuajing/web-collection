const VIEWPORT_GUTTER = 24
const MAX_WIDTH_PROPERTY = '--table-tooltip-max-width'

export function getTableTooltipMaxWidth(reference, viewportWidth = currentViewportWidth()) {
  const element = reference?.contextElement || reference
  const table = element?.closest?.('.el-table')
  const tableWidth = Number(table?.getBoundingClientRect?.().width)
  if (!Number.isFinite(tableWidth) || tableWidth <= 0) return 0
  const viewportLimit = Number(viewportWidth) > VIEWPORT_GUTTER
    ? Number(viewportWidth) - VIEWPORT_GUTTER
    : tableWidth
  return Math.max(0, Math.floor(Math.min(tableWidth, viewportLimit)))
}

export function updateTableTooltipWidth(target, viewportWidth = currentViewportWidth()) {
  const table = target?.closest?.('.el-table')
  const maxWidth = getTableTooltipMaxWidth(target, viewportWidth)
  if (!table?.style?.setProperty || maxWidth <= 0) return 0
  table.style.setProperty(MAX_WIDTH_PROPERTY, `${maxWidth}px`)
  return maxWidth
}

export function installTableTooltipWidthTracking(root = globalThis.document) {
  if (!root?.addEventListener) return () => {}
  const update = (event) => updateTableTooltipWidth(event.target)
  root.addEventListener('mouseover', update, true)
  return () => root.removeEventListener?.('mouseover', update, true)
}

export function keepTableTooltipWithinTable({ state }, viewportWidth = currentViewportWidth()) {
  const reference = state?.elements?.reference
  const table = (reference?.contextElement || reference)?.closest?.('.el-table')
  const popper = state?.elements?.popper
  const tableRect = table?.getBoundingClientRect?.()
  const popperRect = popper?.getBoundingClientRect?.()
  if (!tableRect || !popperRect) return

  const minLeft = Math.max(tableRect.left, VIEWPORT_GUTTER / 2)
  const maxRight = Math.min(tableRect.right, Number(viewportWidth) - VIEWPORT_GUTTER / 2)
  let shift = 0
  if (popperRect.left < minLeft) shift = minLeft - popperRect.left
  else if (popperRect.right > maxRight) shift = maxRight - popperRect.right
  if (!shift) return

  // transform 定位（Element Plus 默认 gpuAcceleration）：在 translate 基础上叠加水平位移
  const transform = popper.style.transform
  const m = /translate3d\(\s*([-\d.]+)px,\s*([-\d.]+)px/.exec(transform) ||
    /translate\(\s*([-\d.]+)px,\s*([-\d.]+)px/.exec(transform)
  if (m) {
    const x = parseFloat(m[1]) + shift
    const y = parseFloat(m[2])
    popper.style.transform = transform.replace(m[0], `translate3d(${x}px, ${y}px, 0)`)
    return
  }

  // 兜底：left/top 定位（gpuAcceleration:false 时）
  const currentLeft = Number.parseFloat(popper.style.left)
  if (Number.isFinite(currentLeft)) popper.style.left = `${currentLeft + shift}px`
}

export const tableConfig = {
  tableLayout: 'fixed',
  tooltipOptions: {
    popperClass: 'table-cell-tooltip',
    showArrow: false,
    placement: 'top',
    fallbackPlacements: ['bottom'],
    offset: 8,
    popperOptions: {
      modifiers: [
        // 禁用 popper.js 内置 flip：默认 flip 会在 cell 上方空间不足时把 placement 从 'top'
        // 翻转到 'bottom'（fallbackPlacements=[bottom]），导致 tooltip 总出现在 cell 下方。
        // 项目里 el-card(overflow:hidden) + el-table__inner-wrapper(overflow-x:auto) 把
        // clippingParents 边界收紧到第 1 行 cell 上方仅 ~25px，而 tooltip 多行 wrap 通常 50-60px，
        // 几乎每行 hover 都会触发 flip，最终表现就是「tooltip 飘在表格外/位置错」。
        // 禁用 flip 后强制 placement='top'，tooltip 紧贴 cell.top 上方（必要时浮出卡片，仍受
        // 下方 preventOverflow viewport 边界保护，不会飘出视口）。
        { name: 'flip', enabled: false },
        // 让 preventOverflow 用 viewport 作为边界：默认是 'clippingParents'，会被 el-card
        // overflow:hidden 截断成"必须完全在卡片内"，从而反过来更早触发 flip；改成 window
        // 后 tooltip 可以正常浮出卡片顶部上方（紧贴 cell 边缘），但仍受 viewport 保护不会
        // 飘出视口。altAxis:true 同步保护水平方向（与 keepTableTooltipWithinTable 协作）。
        {
          name: 'preventOverflow',
          options: { boundariesElement: 'window', altAxis: true }
        },
        // 自定义：水平方向保持 tooltip 在 el-table 宽度内（避免超宽 tooltip 飘出右侧视口）。
        {
          name: 'keepTableTooltipWithinTable',
          enabled: true,
          phase: 'afterWrite',
          fn: keepTableTooltipWithinTable
        }
      ]
    }
  }
}

function currentViewportWidth() {
  return globalThis.document?.documentElement?.clientWidth || globalThis.innerWidth || 0
}
