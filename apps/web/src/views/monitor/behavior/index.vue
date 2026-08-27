<script setup>
import { computed, ref } from 'vue'
import { behavior, behaviorEvents, behaviorPager, setPage, setPageSize, summary, tableLoading, refreshAll } from '../../../dashboard.js'
import EventTable from '../../../components/EventTable.vue'
import HeatmapPanel from '../../../components/HeatmapPanel.vue'
import KpiGrid from '../../../components/KpiGrid.vue'
import RankPanel from '../../../components/RankPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
// PRD 06 · 页面参与度（行为分析内嵌 Tab）
import EngagementPanel from '../../../components/prd/EngagementPanel.vue'

const activeTab = ref('overview')
const behaviorKpis = computed(() => [
  { label: '会话数', value: Number(summary.value?.sessions ?? summary.value?.users ?? 0).toLocaleString(), delta: '当前筛选范围', valueClass: 'value-primary', deltaClass: 'delta-good' },
  { label: '页面浏览 PV', value: Number(summary.value?.behavior?.pv ?? 0).toLocaleString(), delta: '行为事件', valueClass: 'value-purple', deltaClass: 'delta-good' },
  { label: '平均停留', value: summary.value?.behavior?.stay ?? '-', delta: '当前筛选范围', valueClass: 'value-success', deltaClass: 'delta-good' },
  { label: '跳出率', value: summary.value?.behavior?.bounceRate != null ? `${summary.value.behavior.bounceRate}%` : '-', delta: '页面会话', valueClass: 'value-danger', deltaClass: 'delta-good' }
])
</script>

<template>
  <KpiGrid :items="behaviorKpis" />
  <SearchPanel :fields="['path', 'userId', 'keyword']" @search="refreshAll" />

  <el-card shadow="never" class="panel section">
    <template #header>
      <div class="panel-tabs">
        <el-radio-group v-model="activeTab" size="default">
          <el-radio-button value="overview">概览排行</el-radio-button>
          <el-radio-button value="heatmap">行为热力图</el-radio-button>
          <el-radio-button value="detail">行为明细</el-radio-button>
          <el-radio-button value="engagement">页面参与度</el-radio-button>
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

    <!-- 页面参与度（PRD 06） -->
    <div v-show="activeTab === 'engagement'">
      <EngagementPanel />
    </div>
  </el-card>
</template>

<style scoped>
.panel-tabs { display: flex; justify-content: center; }
</style>
