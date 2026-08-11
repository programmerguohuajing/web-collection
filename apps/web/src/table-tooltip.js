const VIEWPORT_GUTTER = 24

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

export function applyTableTooltipWidth({ state }) {
  const maxWidth = getTableTooltipMaxWidth(state?.elements?.reference)
  const popperStyle = state?.elements?.popper?.style
  if (!popperStyle || maxWidth <= 0) return
  popperStyle.maxWidth = `${maxWidth}px`
  popperStyle.width = 'max-content'
}

export const tableConfig = {
  tableLayout: 'fixed',
  tooltipOptions: {
    popperClass: 'table-cell-tooltip',
    popperOptions: {
      modifiers: [
        {
          name: 'tableTooltipWidth',
          enabled: true,
          phase: 'beforeRead',
          fn: applyTableTooltipWidth
        }
      ]
    }
  }
}

function currentViewportWidth() {
  return globalThis.document?.documentElement?.clientWidth || globalThis.innerWidth || 0
}
