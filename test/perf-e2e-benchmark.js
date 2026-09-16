/**
 * @file API 性能与延迟压力测试脚本 (Benchmark Tool)
 * 针对指定 baseUrl 进行高并发压力测试，评估 QPS, 成功率, Latency (P50, P90, P99)。
 */

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

const TARGET_URL = process.env.BENCHMARK_TARGET || 'https://web-collection.jingguohua.cc.cd'

function httpRequest(targetUrl, options = {}, body = null) {
  return new Promise((resolve) => {
    const start = performance.now()
    const url = new URL(targetUrl)
    const client = url.protocol === 'https:' ? https : http

    const req = client.request(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      timeout: 10000
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        const duration = performance.now() - start
        resolve({ status: res.statusCode, duration, ok: res.statusCode >= 200 && res.statusCode < 400 })
      })
    })

    req.on('error', (err) => {
      const duration = performance.now() - start
      resolve({ status: 0, error: err.message, duration, ok: false })
    })

    req.on('timeout', () => {
      req.destroy()
      const duration = performance.now() - start
      resolve({ status: 408, error: 'TIMEOUT', duration, ok: false })
    })

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body))
    }
    req.end()
  })
}

function calculateStats(latencies) {
  if (latencies.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p99: 0 }
  const sorted = [...latencies].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const avg = sum / sorted.length
  const percentile = (p) => sorted[Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1)]

  return {
    min: Number(sorted[0].toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    avg: Number(avg.toFixed(2)),
    p50: Number(percentile(50).toFixed(2)),
    p90: Number(percentile(90).toFixed(2)),
    p99: Number(percentile(99).toFixed(2))
  }
}

async function runBenchmark(name, targetEndpoint, concurrency = 20, totalRequests = 100, method = 'GET', body = null) {
  console.log(`\n🚀 开始压测 [${name}] - Target: ${targetEndpoint}`)
  console.log(`   并发数: ${concurrency}, 总请求数: ${totalRequests}, 方法: ${method}`)

  const latencies = []
  let successCount = 0
  let failCount = 0
  const statusCounts = {}

  const startTime = performance.now()
  let issued = 0

  async function worker() {
    while (issued < totalRequests) {
      issued++
      const res = await httpRequest(targetEndpoint, { method }, body)
      latencies.push(res.duration)
      statusCounts[res.status] = (statusCounts[res.status] || 0) + 1
      if (res.ok) {
        successCount++
      } else {
        failCount++
      }
    }
  }

  const workers = []
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker())
  }
  await Promise.all(workers)

  const totalTimeSec = (performance.now() - startTime) / 1000
  const qps = Number((totalRequests / totalTimeSec).toFixed(2))
  const stats = calculateStats(latencies)

  console.log(`📊 [${name}] 结果汇总:`)
  console.log(`   - 成功率: ${((successCount / totalRequests) * 100).toFixed(1)}% (${successCount}/${totalRequests})`)
  console.log(`   - 总耗时: ${totalTimeSec.toFixed(2)}s | QPS: ${qps}`)
  console.log(`   - 延迟分布: Avg=${stats.avg}ms | Min=${stats.min}ms | Max=${stats.max}ms | P50=${stats.p50}ms | P90=${stats.p90}ms | P99=${stats.p99}ms`)
  console.log(`   - 状态码分布:`, JSON.stringify(statusCounts))

  return { name, totalRequests, successCount, failCount, qps, stats, statusCounts }
}

async function main() {
  console.log(`=======================================================`)
  console.log(` 谷歌资深 QA 工程师 - 全接口性能与延迟 Benchmark 评估 `)
  console.log(` 目标域名: ${TARGET_URL}`)
  console.log(`=======================================================`)

  const results = []

  // 1. 公开健康检查与 Capabilities
  results.push(await runBenchmark('Health Check', `${TARGET_URL}/health`, 20, 100))
  results.push(await runBenchmark('Capabilities', `${TARGET_URL}/api/capabilities`, 20, 100))
  results.push(await runBenchmark('Brand Public', `${TARGET_URL}/api/brand`, 20, 100))

  // 2. 高频埋点上报 /api/collect (POST 性能吞吐)
  const sampleEvent = {
    appId: 'demo-perf-app',
    type: 'behavior',
    name: 'pv',
    ts: Date.now(),
    props: { path: '/home', browser: 'Chrome', duration: 150 }
  }
  results.push(await runBenchmark('Collect Ingest (POST)', `${TARGET_URL}/api/collect`, 30, 150, 'POST', sampleEvent))

  // 3. 核心查询端点 /api/summary
  results.push(await runBenchmark('Summary Query', `${TARGET_URL}/api/summary?appId=demo-perf-app`, 20, 100))

  console.log(`\n=======================================================`)
  console.log(` 所有压测项目执行完毕！ `)
  console.log(`=======================================================`)
}

main().catch(err => {
  console.error('Benchmark error:', err)
  process.exit(1)
})
