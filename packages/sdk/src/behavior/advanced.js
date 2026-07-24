import { elementInfo } from '../utils/dom.js'

export function setupAdvancedBehaviorMonitor({ push, formTracking = false, rageClick = false, deadClick = false, interactionTracking = false }) {
  const disposers = []
  const clickHistory = new WeakMap()
  if (!formTracking && !rageClick && !deadClick && !interactionTracking) return () => {}
  if (formTracking) {
    const onSubmit = event => {
      const form = event.target
      push({ type: 'behavior', name: 'form_submit', props: formInfo(form) })
    }
    addEventListener('submit', onSubmit, true)
    disposers.push(() => removeEventListener('submit', onSubmit, true))
  }
  if (rageClick || deadClick) {
    const onClick = event => {
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
      if (!target) return
      if (rageClick) {
        const now = Date.now()
        const previous = clickHistory.get(target)
        const item = previous && now - previous.startedAt < 1000 ? { startedAt: previous.startedAt, count: previous.count + 1 } : { startedAt: now, count: 1 }
        clickHistory.set(target, item)
        if (item.count === 3) push({ type: 'behavior', name: 'rage_click', props: elementInfo(target) })
      }
      if (deadClick && target.matches?.('[data-track-dead-click]')) push({ type: 'behavior', name: 'dead_click', props: elementInfo(target) })
    }
    addEventListener('click', onClick, true)
    disposers.push(() => removeEventListener('click', onClick, true))
  }
  if (interactionTracking) {
    const onCopy = event => push({ type: 'behavior', name: 'copy', props: elementInfo(event.target) })
    const onPaste = event => push({ type: 'behavior', name: 'paste', props: elementInfo(event.target) })
    const onDownload = event => {
      const target = event.target?.closest?.('a[download]')
      if (target) push({ type: 'behavior', name: 'download', props: { ...elementInfo(target), download: target.getAttribute('download') || '' } })
    }
    addEventListener('copy', onCopy, true)
    addEventListener('paste', onPaste, true)
    addEventListener('click', onDownload, true)
    disposers.push(() => removeEventListener('copy', onCopy, true))
    disposers.push(() => removeEventListener('paste', onPaste, true))
    disposers.push(() => removeEventListener('click', onDownload, true))
  }
  return () => disposers.forEach(dispose => dispose())
}

function formInfo(form) {
  return {
    id: form?.id || '',
    name: form?.name || '',
    action: form?.action || '',
    method: form?.method || 'get'
  }
}
