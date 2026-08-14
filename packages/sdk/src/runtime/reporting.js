/**
 * Reporting API 监控模块（MDN: Reporting API / ReportingObserver）。
 *
 * 捕获浏览器主动下发的报告：弃用警告(deprecation)、干预(intervention)、
 * CSP 违规(csp-violation)、跨源策略(coep/corp)、崩溃(crash)等。
 * 这些是 SDK 当前完全落入盲区的「免费」可观测性来源，且天然不含业务 PII。
 *
 * 上报为 `browser_report` 指标；csp-violation / crash 视为错误级，附 `error()`。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 性能/指标上报方法
 * @param {Function} [opts.error] - SDK 错误上报方法
 */
export function setupReportingMonitor({ metric, error }) {
  if (typeof ReportingObserver === 'undefined') return () => {}

  const observer = new ReportingObserver((reports) => {
    for (const report of reports) {
      const type = report.type || 'unknown'
      const body = report.body || {}
      try {
        // 安全/崩溃类归为错误级，其余归为指标级
        if (type === 'csp-violation' || type === 'crash') {
          error(new Error(`BrowserReport:${type}`), {
            name: 'BrowserReport',
            reportType: type,
            sourceFile: body.sourceFile || '',
            lineNumber: body.lineNumber || 0,
            columnNumber: body.columnNumber || 0,
            policyId: body.policyId || '',
            disposition: body.disposition || '',
            message: body.message || ''
          })
        } else {
          metric('browser_report', 0, {
            reportType: type,
            id: body.id || '',
            message: body.message || '',
            sourceFile: body.sourceFile || '',
            lineNumber: body.lineNumber || 0,
            columnNumber: body.columnNumber || 0,
            // 跨源策略类附加字段
            disposition: body.disposition || ''
          })
        }
      } catch {}
    }
  }, {
    types: ['deprecation', 'intervention', 'csp-violation', 'coep', 'corp', 'crash', 'generic']
  })

  observer.observe()
  return () => { try { observer.disconnect() } catch {} }
}
