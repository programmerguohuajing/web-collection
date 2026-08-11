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
  const currentLeft = Number.parseFloat(popper?.style?.left)
  if (!tableRect || !popperRect || !Number.isFinite(currentLeft)) return

  const minLeft = Math.max(tableRect.left, VIEWPORT_GUTTER / 2)
  const maxRight = Math.min(tableRect.right, Number(viewportWidth) - VIEWPORT_GUTTER / 2)
  let shift = 0
  if (popperRect.left < minLeft) shift = minLeft - popperRect.left
  else if (popperRect.right > maxRight) shift = maxRight - popperRect.right
  if (shift) popper.style.left = `${currentLeft + shift}px`
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
        {
          name: 'computeStyles',
          options: {
            adaptive: false,
            gpuAcceleration: false
          }
        },
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
