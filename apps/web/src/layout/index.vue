<script setup>
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { error, key, loading, refresh, setFiltersFromRoute } from '../dashboard.js'

const route = useRoute()
const menus = [
  { title: '总览', path: '/overview' },
  { title: '错误监控', path: '/errors' },
  { title: '性能监控', path: '/performance' },
  { title: '行为埋点', path: '/behavior' },
  { title: '会话回放', path: '/replays' },
  { title: '事件流', path: '/events' },
  { title: 'SourceMap', path: '/sourcemaps' },
  { title: '采集治理', path: '/governance' }
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
  <div class="app-wrapper">
    <aside class="sidebar-container">
      <div class="sidebar-logo-container">
        <div class="sidebar-logo-text">Web Collection</div>
        <span>前端采集平台</span>
      </div>
      <el-scrollbar>
        <el-menu :default-active="route.path" router background-color="#304156" text-color="#bfcbd9" active-text-color="#409eff">
          <el-menu-item v-for="menu in menus" :key="menu.path" :index="menu.path">
            <span>{{ menu.title }}</span>
          </el-menu-item>
        </el-menu>
      </el-scrollbar>
    </aside>

    <section class="main-container">
      <header class="navbar">
        <div class="breadcrumb-title">{{ title }}</div>
        <el-form class="admin-key" @submit.prevent="refresh">
          <el-input v-model="key" placeholder="Admin API Key" type="password" show-password />
          <el-button type="primary" native-type="submit" :loading="loading">刷新</el-button>
        </el-form>
      </header>

      <main class="app-main">
        <el-alert v-if="error" class="section" type="error" :title="error" show-icon />
        <router-view />
      </main>
    </section>
  </div>
</template>
