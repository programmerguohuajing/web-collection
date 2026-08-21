import { defineStore } from 'pinia'

/**
 * 全局「AI 诊断」上下文（ADR-006）。
 * 让任何页面右下角的 FAB / 全局 drawer 感知"当前查看的 trace / issue"，
 * 从而自动带上下文诊断。详情页选中时写入（侵入极小，各追加一行）。
 */
export const useDiagnosisStore = defineStore('diagnosis', {
  state: () => ({
    // 当前查看的 trace（来自详情页选中 / ?traceId= 深链）
    currentTraceId: null,
    // 当前查看的 issue 指纹
    currentIssueFingerprint: null,
    // 手动粘贴的错误文本（备用，三态入口之一）
    currentErrorText: null
  }),
  actions: {
    setTrace(id) {
      if (id) this.currentTraceId = id
    },
    setIssue(fp) {
      if (fp) this.currentIssueFingerprint = fp
    },
    clear() {
      this.currentTraceId = null
      this.currentIssueFingerprint = null
      this.currentErrorText = null
    }
  }
})
