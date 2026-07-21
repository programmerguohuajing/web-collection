<script setup>
import { nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ReplayPanel from '../../../components/ReplayPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import { getReplay, replayPager, replays, setPage, setPageSize, tableLoading } from '../../../dashboard.js'
const route = useRoute()
const panel = ref(null)
watch(replays, async rows => {
  const row = route.query.replayId && rows.find(item => item.replayId === route.query.replayId)
  if (row) { await nextTick(); panel.value?.play(row) }
}, { immediate: true })
</script>

<template>
  <SearchPanel :fields="['range', 'appId', 'release', 'path', 'userId', 'userName', 'userPhone']" />
  <ReplayPanel ref="panel" :replays="replays" :load-replay="getReplay" :loading="tableLoading.replays" :total="replayPager.total" :page="replayPager.page" :page-size="replayPager.pageSize" @page-change="setPage('replays', $event)" @size-change="setPageSize('replays', $event)" />
</template>
