/**
 * 表格 overflow tooltip 全局配置。
 *
 * 经 App.vue 的 <el-config-provider :table="tableConfig"> 应用到所有 el-table。
 *
 * 关键点：Element Plus 2.14 的 show-overflow-tooltip 内部 createTablePopper 把
 * 浮层 appendTo 设为表格容器（tableWrapper）。浮层挂在表格内部会被表格/卡片的
 * overflow 裁剪，并因坐标参照系问题出现"飘到表格外部 / 有省略号但 tooltip 不显示"。
 * 这里通过 tooltipOptions.appendTo='body' + teleported:true 覆盖（getTableOverflowTooltipProps
 * 会把 tooltipOptions 透传，且排在 createTablePopper 内 appendTo:parentNode 之后，可覆盖），
 * 让浮层 teleport 到 body，由 popper.js 以单元格为 reference 紧贴当前行上方定位。
 *
 * placement:'top' → 浮层在当前行上方；上方空间不足时 flip 到当前行下方（fallbackPlacements）。
 * fixed strategy 避免滚动容器改变坐标系；computeStyles 关闭 adaptive/GPU transform，
 * 防止 body 高度参与自适应定位后把浮层换算到表格顶部或视口外。
 * preventOverflow(rootBoundary=viewport, altAxis) 保证不飘出视口（含水平方向）。
 * .table-cell-tooltip（见 style.css）限制最大宽度/高度并换行滚动，承载长文本。
 */
export const tableConfig = {
  tableLayout: 'fixed',
  tooltipOptions: {
    appendTo: 'body',
    teleported: true,
    popperClass: 'table-cell-tooltip',
    showArrow: false,
    placement: 'top',
    fallbackPlacements: ['bottom'],
    offset: 8,
    popperOptions: {
      strategy: 'fixed',
      modifiers: [
        {
          name: 'computeStyles',
          options: { adaptive: false, gpuAcceleration: false }
        },
        {
          name: 'flip',
          options: { fallbackPlacements: ['bottom'], rootBoundary: 'viewport' }
        },
        {
          name: 'preventOverflow',
          options: { rootBoundary: 'viewport', altAxis: true }
        }
      ]
    }
  }
}
