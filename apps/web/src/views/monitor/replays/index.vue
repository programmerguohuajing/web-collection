<script setup>
import { nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ReplayPanel from '../../../components/ReplayPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import { getReplay, replayPager, replays, refreshAll, setPage, setPageSize, tableLoading } from '../../../dashboard.js'
const route = useRoute()
const router = useRouter()
const panel = ref(null)
const filterOpen = ref(false)

async function searchReplays() {
  await refreshAll()
  filterOpen.value = false
}

// 深链 replayId 指向的会话已无回放数据时，清掉 URL 参数避免刷新后再次命中死链接。
function onReplayNotFound() {
  if (route.query.replayId == null) return
  const query = { ...route.query }
  delete query.replayId
  router.replace({ path: route.path, query })
}

watch(() => route.query.replayId, async value => {
  const replayId = String(value || '')
  if (!replayId) return
  await nextTick()
  await panel.value?.play({ replayId })
}, { immediate: true })
</script>

<template>
  <ReplayPanel
    ref="panel"
    :replays="replays"
    :load-replay="getReplay"
    :loading="tableLoading.replays"
    :total="replayPager.total"
    :page="replayPager.page"
    :page-size="replayPager.pageSize"
    @filter="filterOpen = true"
    @refresh="refreshAll"
    @replay-not-found="onReplayNotFound"
    @page-change="setPage('replays', $event)"
    @size-change="setPageSize('replays', $event)"
  />

  <el-drawer v-model="filterOpen" title="筛选回放会话" size="min(440px, 92vw)" class="replay-filter-drawer">
    <p class="replay-filter-tip">按页面路径或用户信息缩小会话范围，查询结果会同步到当前回放工作区。</p>
    <SearchPanel :fields="['path', 'userId', 'userName', 'userPhone']" @search="searchReplays" />
  </el-drawer>
</template>

<style scoped>
.replay-filter-tip { margin: 0 0 16px; color: var(--c-text-muted); font-size: 13px; line-height: 1.65; }
:deep(.replay-filter-drawer .query-card) { box-shadow: none; }
:deep(.replay-filter-drawer .ruoyi-query) { grid-template-columns: 1fr; }
:deep(.replay-filter-drawer .query-actions) { grid-column: auto; }
</style>
