/**
 * 事件类别关键字段（PRD 02 FR-2）
 * - Node 与 Worker 双端共用，避免算法漂移
 * - 字典页"字段完整率"仅按此清单计算，避免把"没有的可选字段"误算成缺失
 *   造成全员 🟠；未配置关键字段的事件不参与 🟠 判定
 */
export const EVENT_KEY_FIELDS = Object.freeze({
  pv: ['url', 'referrer'],
  click: ['elementLabel', 'target'],
  page_leave: ['stayTime']
})

/** 取关键字段清单（未知事件名返回空数组） */
export function keyFieldsOf(eventName) {
  return EVENT_KEY_FIELDS[eventName] || []
}
