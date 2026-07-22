<script setup>
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { error, loading, refresh, setFiltersFromRoute } from '../dashboard.js'

const route = useRoute()
const nav = [
  ['总', '总览', '/overview'],
  ['错', '错误监控', '/errors'],
  ['性', '性能监控', '/performance'],
  ['行', '行为埋点', '/behavior'],
  ['回', '会话回放', '/replays'],
  ['志', '日志平台', '/logs'],
  ['链', '链路追踪', '/traces'],
  ['析', '产品分析', '/analytics'],
  ['源', 'SourceMap', '/sourcemaps']
]
const title = computed(() => route.meta.title || '总览')

onMounted(async () => {
  setFiltersFromRoute(route.query)
  await refresh()
})

watch(() => route.query, query => setFiltersFromRoute(query))
watch(() => route.path, async () => {
  setFiltersFromRoute(route.query)
  await refresh()
})
</script>

<template>
  <div class="ops-shell">
    <aside class="ops-side">
      <div class="brand">
        <b>Web Collection</b>
        <span>前端监控平台</span>
      </div>
      <nav>
        <router-link v-for="[mark, label, to] in nav" :key="to" :to="to">
          <i>{{ mark }}</i>
          <span>{{ label }}</span>
        </router-link>
      </nav>
    </aside>

    <main class="ops-main">
      <header class="ops-top">
        <div>
          <small>Web Collection</small>
          <h1>{{ title }}</h1>
        </div>
        <el-button type="primary" :loading="loading" @click="refresh">刷新</el-button>
      </header>

      <el-alert v-if="error" class="section" type="error" :title="error" show-icon />
      <router-view />
    </main>
  </div>
</template>
