<script setup>
import ReplayPanel from '../components/ReplayPanel.vue'
import SearchPanel from '../components/SearchPanel.vue'
import { getReplay, replayPager, replays, setPage, tableLoading } from '../dashboard.js'
</script>

<template>
  <SearchPanel :fields="['range', 'appId', 'release', 'path', 'userId', 'userName', 'userPhone']" />
  <ReplayPanel :replays="replays" :load-replay="getReplay" :loading="tableLoading.replays" :total="replayPager.total" :page="replayPager.page" :page-size="replayPager.pageSize" @page-change="setPage('replays', $event)" />
</template>
