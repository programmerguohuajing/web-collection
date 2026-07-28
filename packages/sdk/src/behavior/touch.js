import { elementInfo } from '../utils/dom.js'

/**
 * 初始化 Touch 手势监控。
 *
 * 采集移动端核心 touch 手势（tap、swipe）。
 * 默认不开启，通过 touchTracking: true 启用。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 */
export function setupTouchMonitor({ push }) {
  let touchStart = null

  const onTouchStart = event => {
    if (!event.touches?.length) return
    const t = event.touches[0]
    touchStart = { x: t.clientX, y: t.clientY, time: Date.now(), target: event.target }
  }

  const onTouchEnd = event => {
    if (!touchStart) return
    const changed = event.changedTouches?.[0]
    if (!changed) { touchStart = null; return }

    const dx = changed.clientX - touchStart.x
    const dy = changed.clientY - touchStart.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    const duration = Date.now() - touchStart.time

    if (dist < 10 && duration < 300) {
      // tap
      push({
        type: 'behavior',
        name: 'touch_tap',
        props: { ...elementInfo(touchStart.target), duration }
      })
    } else if (dist > 100 && duration < 1000) {
      // swipe
      const absDx = Math.abs(dx)
      const absDy = Math.abs(dy)
      let direction
      if (absDx > absDy) {
        direction = dx > 0 ? 'right' : 'left'
      } else {
        direction = dy > 0 ? 'down' : 'up'
      }
      push({
        type: 'behavior',
        name: 'touch_swipe',
        props: {
          ...elementInfo(touchStart.target),
          direction,
          distance: Math.round(dist),
          duration
        }
      })
    }

    touchStart = null
  }

  addEventListener('touchstart', onTouchStart, { passive: true })
  addEventListener('touchend', onTouchEnd, { passive: true })
  return () => {
    removeEventListener('touchstart', onTouchStart)
    removeEventListener('touchend', onTouchEnd)
  }
}
