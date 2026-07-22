<script setup>
import { formatDuration } from '../utils/format.js'

/**
 * @file 性能指标面板组件
 * 展示 Web Vitals 各指标的 P75 值（LCP、INP、FID、CLS、FCP、TTFB、LongTask）。
 */
defineProps({ perf: { type: Object, default: () => ({}) } })
/** 展示的性能指标列表 */
const metrics = ['lcp', 'inp', 'cls', 'fcp', 'ttfb', 'white_screen', 'blank_screen_rate', 'first_screen', 'route_render', 'data_ready', 'dom_ready', 'page_load', 'js_boot', 'tbt', 'resource_failure_rate', 'slow_api_rate', 'dns', 'tcp', 'tls', 'request', 'download', 'cache_hit_rate', 'redirect', 'redirect_count', 'longtask']

const metricLabels = {
  lcp: '最大内容渲染',
  inp: '交互延迟',
  fid: '首次输入延迟',
  cls: '累积布局偏移',
  fcp: '首次内容渲染',
  ttfb: '首字节时间',
  longtask: '长任务', white_screen: '首页白屏时间', blank_screen_rate: '白屏率', first_screen: '首屏完成时间', route_render: '路由切换渲染', data_ready: '页面数据就绪', dom_ready: 'DOM Ready', page_load: '页面完全加载', js_boot: 'JavaScript 初始化', tbt: '总阻塞时间', resource_failure_rate: '资源加载失败率', slow_api_rate: '慢接口率', dns: 'DNS 查询', tcp: 'TCP 连接', tls: 'TLS 握手', request: '服务端响应', download: 'HTML 下载', cache_hit_rate: '缓存命中率', redirect: '重定向耗时', redirect_count: '重定向次数'
}

function metricValue(name, value) {
  if (value == null) return '-'
  if (name.endsWith('_rate')) return `${Number(value).toFixed(2).replace(/\.00$/, '')}%`
  if (name === 'cls') return Number(value).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  if (name === 'redirect_count') return `${Math.round(value)} 次`
  return formatDuration(value)
}

</script>

<template>
  <el-card shadow="never" class="panel">
    <template #header><div class="panel-head"><h2>性能 P75</h2><small>Web Vitals</small></div></template>
    <div class="perf-list">
      <div v-for="name in metrics" :key="name"><span>{{ metricLabels[name] || name }}</span><strong>{{ metricValue(name, perf[name]) }}</strong></div>
    </div>
  </el-card>
</template>
