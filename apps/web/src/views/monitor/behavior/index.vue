<script setup>
import { ref } from 'vue'
import { behavior, behaviorEvents, behaviorPager, setPage, setPageSize, tableLoading, refreshAll } from '../../../dashboard.js'
import EventTable from '../../../components/EventTable.vue'
import HeatmapPanel from '../../../components/HeatmapPanel.vue'
import RankPanel from '../../../components/RankPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'

const activeTab = ref('overview')
</script>

<template>
  <SearchPanel :fields="['path', 'userId', 'keyword']" @search="refreshAll" />

  <el-card shadow="never" class="panel section">
    <template #header>
      <div class="panel-tabs">
        <el-radio-group v-model="activeTab" size="default">
          <el-radio-button value="overview">概览排行</el-radio-button>
          <el-radio-button value="heatmap">行为热力图</el-radio-button>
          <el-radio-button value="detail">行为明细</el-radio-button>
        </el-radio-group>
      </div>
    </template>

    <!-- 概览 -->
    <div v-show="activeTab === 'overview'">
      <RankPanel class="section" title="行为排行" subtitle="behavior / track" :items="behavior" />
    </div>

    <!-- 热力图 -->
    <div v-show="activeTab === 'heatmap'">
      <HeatmapPanel />
    </div>

    <!-- 明细表 -->
    <div v-show="activeTab === 'detail'">
      <EventTable title="行为与埋点明细" :rows="behaviorEvents" :loading="tableLoading.behavior" :total="behaviorPager.total" :page="behaviorPager.page" :page-size="behaviorPager.pageSize" stream @page-change="setPage('behavior', $event)" @size-change="setPageSize('behavior', $event)" />
    </div>
  </el-card>
</template>

<style scoped>
.panel-tabs { display: flex; justify-content: center; }
</style>
