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
        // 首选 placement='top'：tooltip 紧贴当前行上方（满足"悬浮当前行上"）。
        // 当表格顶部行 / 贴近视口的行上方空间不足时，flip 自动翻到当前行下方
        // （fallbackPlacements=[bottom]），仍紧贴所在行——避免 tooltip 被顶到视口上方、
        // 视觉上"展示在表格上方"。
        // 注：Element Plus tooltip 浮层 teleport 到 body，不受 el-card overflow:hidden 裁剪，
        // 因此无需靠 { name:'flip', enabled:false } 强制 top（那正是导致顶部行 tooltip
        // 飘到表格上方的原因）。
        {
          name: 'flip',
          options: { fallbackPlacements: ['bottom'], rootBoundary: 'viewport' }
        },
        // 用 viewport(rootBoundary) 作为 preventOverflow 边界，保证 tooltip 不飘出视口；
        // altAxis:true 同步保护水平方向（与 keepTableTooltipWithinTable 协作）。
        {
          name: 'preventOverflow',
          options: { rootBoundary: 'viewport', altAxis: true }
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
