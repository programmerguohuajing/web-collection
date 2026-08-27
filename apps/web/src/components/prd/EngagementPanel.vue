<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, pageLoading, queryFromFilters } from '../../dashboard.js'

const loading = ref(false)
const loadError = ref('')
const items = ref([])
const pager = reactive({ page: 1, pageSize: 20, total: 0 })
const keyword = ref('')

// ---------------- 单页详情 ----------------
const detailDrawer = ref(false)
const detailLoading = ref(false)
const detail = ref(null)
// ---------------- 改版对比 ----------------
const compareDrawer = ref(false)
const compareForm = reactive({ path: '', aStart: '', bStart: '', spanDays: 7 })
const compareResult = ref(null)
const comparing = ref(false)

async function load() {
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const params = new URLSearchParams(queryFromFilters({ page: pager.page, pageSize: pager.pageSize }, ['appId', 'release', 'startTime', 'endTime']))
    if (keyword.value.trim()) params.set('q', keyword.value.trim())
    const data = await api(`/api/analytics/engagement?${params}`, { requestKey: 'engagement:list' })
    items.value = Array.isArray(data?.items) ? data.items : []
    pager.total = Number(data?.total || 0)
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') {
      loadError.value = error.message || '参与度报表加载失败'
      items.value = []
      pager.total = 0
    }
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

function seconds(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '-'
  return `${(Number(ms) / 1000).toFixed(1)}s`
}
function percent(value) {
  return value == null || !Number.isFinite(Number(value)) ? '-' : `${(Number(value) * 100).toFixed(0)}%`
}

function dayInput(offsetDays) {
  // 把"X 天前"对齐到当天的 00:00 UTC，与 new Date('YYYY-MM-DD') 解析一致；
  // 这样 aStart/bStart + spanDays 不会落到"半天"导致对比窗口跨日漂移
  const date = new Date(Date.now() - offsetDays * 86400000)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    .toISOString().slice(0, 10)
}

/** 默认对照区间：a 段=前 7 天，b 段=最近 7 天；spanDays 限定不超过 14 避免跨未来 */
function defaultCompareRange() {
  return { aStart: dayInput(14), bStart: dayInput(7), spanDays: 7 }
}

async function openDetail(row) {
  compareDrawer.value = false
  detailDrawer.value = true
  detailLoading.value = true
  detail.value = null
  try {
    const params = new URLSearchParams(queryFromFilters({ path: row.path }, ['appId']))
    detail.value = await api(`/api/analytics/engagement/detail?${params}`, { requestKey: `engagement:${row.path}` })
  } catch (error) {
    ElMessage.error(error.message || '页面详情加载失败')
    detailDrawer.value = false
  } finally {
    detailLoading.value = false
  }
}

async function openCompare(row) {
  detailDrawer.value = false
  compareDrawer.value = true
  Object.assign(compareForm, { path: row.path, ...defaultCompareRange() })
  await runCompare()
}

async function runCompare() {
  comparing.value = true
  compareResult.value = null
  try {
    const params = new URLSearchParams(queryFromFilters({
      path: compareForm.path,
      start: String(new Date(compareForm.bStart).getTime()),
      end: String(new Date(compareForm.bStart).getTime() + compareForm.spanDays * 86400000),
      compareStart: String(new Date(compareForm.aStart).getTime()),
      compareEnd: String(new Date(compareForm.aStart).getTime() + compareForm.spanDays * 86400000)
    }, ['appId']))
    compareResult.value = await api(`/api/analytics/engagement/detail?${params}`, { requestKey: `engagement:compare:${compareForm.path}` })
  } catch (error) {
    ElMessage.error(error.message || '对比数据加载失败')
  } finally {
    comparing.value = false
  }
}

const COMPARE_ROWS = [
  { key: 'avgDwellMs', label: '平均停留', format: seconds },
  { key: 'reach75Rate', label: '75% 触达率', format: percent },
  { key: 'bounceRate', label: '跳出率', format: percent }
]
function deltaLabel(row) {
  const a = compareResult.value?.compare?.a?.[row.key]
  const b = compareResult.value?.compare?.b?.[row.key]
  if (a == null || b == null || Number(a) === 0) return '-'
  const pct = (Number(b) - Number(a)) / Number(a) * 100
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
}
function deltaClass(row) {
  const label = deltaLabel(row)
  if (label === '-' ) return ''
  const value = parseFloat(label)
  // 停留/触达上升为好；跳出率下降为好
  const good = row.key === 'bounceRate' ? value < 0 : value > 0
  return good ? 'delta-good' : 'delta-bad'
}

onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div>
    <div class="caliber-note">
      <span class="ci">◈</span>
      <div><b>口径</b>：平均停留 = dwell_ms 均值（剔除超 2h 异常样本）；75% 触达率 = scroll_buckets[75] 比例；跳出 = 停留 &lt;3s 且无交互；分享会话率 = 含 share 会话/总会话。旧 SDK 无参与度字段按「无数据」处理，不纳入滚动指标。样本 &lt;30 标记仅供参考。</div>
    </div>

    <el-card shadow="never" class="section panel">
      <template #header>
        <div class="panel-head">
          <b>页面参与度报表</b>
          <el-input v-model="keyword" placeholder="按路径过滤" clearable style="width: 200px" @keyup.enter="load(); pager.page = 1" />
        </div>
      </template>
      <el-alert v-if="loadError" type="error" :title="loadError" show-icon :closable="false" style="margin-bottom: 10px">
        <template #default><el-button link type="primary" @click="load">重试</el-button></template>
      </el-alert>
      <el-table :data="items" border v-loading="loading" empty-text="暂无参与度数据（需新版 SDK 上报 page_leave 参与度字段）">
        <el-table-column label="页面" min-width="220"><template #default="{ row }"><b>{{ row.path }}</b></template></el-table-column>
        <el-table-column label="浏览量" width="100" align="right"><template #default="{ row }">{{ row.pv.toLocaleString() }}</template></el-table-column>
        <el-table-column label="访客" width="90" align="right"><template #default="{ row }">{{ row.uv.toLocaleString() }}</template></el-table-column>
        <el-table-column label="平均停留" width="100" align="right"><template #default="{ row }">{{ seconds(row.avgDwellMs) }}</template></el-table-column>
        <el-table-column label="P90 停留" width="100" align="right"><template #default="{ row }">{{ seconds(row.p90DwellMs) }}</template></el-table-column>
        <el-table-column label="平均滚动" width="100" align="right"><template #default="{ row }">{{ percent(row.avgScroll) }}</template></el-table-column>
        <el-table-column label="75% 触达率" width="110" align="right"><template #default="{ row }">{{ percent(row.reach75Rate) }}</template></el-table-column>
        <el-table-column label="跳出率" width="90" align="right"><template #default="{ row }">{{ percent(row.bounceRate) }}</template></el-table-column>
        <el-table-column label="分享会话率" width="110" align="right"><template #default="{ row }">{{ percent(row.shareSessionRate) }}</template></el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)" data-test="engagement-detail">单页详情</el-button>
            <el-button link type="primary" @click="openCompare(row)" data-test="engagement-compare">改版对比</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination class="pager" background layout="prev, pager, next, total" :current-page="pager.page" :page-size="pager.pageSize" :total="pager.total" @current-change="value => { pager.page = value; load() }" />
    </el-card>

    <!-- 单页详情抽屉 -->
    <el-drawer v-model="detailDrawer" :title="`页面详情 · ${detail?.path || ''}`" size="480px">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <h4 style="margin: 0 0 8px; font-size: 13px">停留时长分布</h4>
          <div v-for="bucket in detail.distribution" :key="bucket.label" class="dist-bar">
            <span class="db-label">{{ bucket.label }}</span>
            <div class="db-track"><div class="db-fill" :style="{ width: `${Math.round((bucket.rate || 0) * 100)}%` }" /></div>
            <span class="db-val">{{ Math.round((bucket.rate || 0) * 100) }}%</span>
          </div>

          <h4 style="margin: 16px 0 8px; font-size: 13px">滚动深度漏斗</h4>
          <div class="scroll-funnel">
            <div v-for="row in detail.scrollFunnel" :key="row.threshold" class="scroll-row">
              <span class="sl">{{ Math.round(row.threshold * 100) }}%</span>
              <div class="strack"><div class="sfill" :style="{ width: `${Math.round((row.rate || 0) * 100)}%` }">{{ row.rate != null ? `${Math.round(row.rate * 100)}%` : '' }}</div></div>
              <span class="sp" />
            </div>
          </div>

          <p style="color: var(--c-text-faint); font-size: 12px; margin-top: 12px">
            样本量 {{ detail.sampleSize }} {{ detail.sufficientSample ? '≥ 30，统计有效。' : '< 30，仅供参考。' }}
          </p>
        </template>
      </div>
    </el-drawer>

    <!-- 改版对比抽屉 -->
    <!-- 改版对比：注意 v-if 强制每次打开重建，避免与 detailDrawer 共存时 title 状态串扰 -->
    <el-drawer v-if="compareDrawer" v-model="compareDrawer" :title="`改版对比 · ${compareForm.path}`" size="520px">
      <div class="compare-form">
        <el-date-picker v-model="compareForm.aStart" type="date" value-format="YYYY-MM-DD" placeholder="A 段起始" style="width: 150px" @change="runCompare" />
        <el-date-picker v-model="compareForm.bStart" type="date" value-format="YYYY-MM-DD" placeholder="B 段起始" style="width: 150px" @change="runCompare" />
        <el-select v-model="compareForm.spanDays" style="width: 100px" @change="runCompare">
          <el-option :value="3" label="跨 3 天" /><el-option :value="7" label="跨 7 天" /><el-option :value="14" label="跨 14 天" />
        </el-select>
      </div>
      <p style="color: var(--c-text-faint); font-size: 11.5px; margin: 4px 0 12px">
        A：{{ compareForm.aStart }} 起 · B：{{ compareForm.bStart }} 起（各取 {{ compareForm.spanDays }} 天）
      </p>
      <div v-loading="comparing">
        <el-table v-if="compareResult?.compare" :data="COMPARE_ROWS" size="small" border>
          <el-table-column prop="label" label="指标" width="120" />
          <el-table-column label="A" align="right"><template #default="{ row }">{{ compareResult.compare.a?.[row.key] != null ? row.format(compareResult.compare.a[row.key]) : '-' }}</template></el-table-column>
          <el-table-column label="B" align="right"><template #default="{ row }">{{ compareResult.compare.b?.[row.key] != null ? row.format(compareResult.compare.b[row.key]) : '-' }}</template></el-table-column>
          <el-table-column label="Δ" align="right" width="100"><template #default="{ row }"><span :class="deltaClass(row)">{{ deltaLabel(row) }}</span></template></el-table-column>
        </el-table>
        <el-empty v-else-if="!comparing" description="该路径无可比样本" :image-size="60" />
        <div v-if="compareResult?.sampleSize != null" style="color: var(--c-text-faint); font-size: 11.5px; margin-top: 8px">B 段样本量 {{ compareResult.sampleSize }}</div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.delta-good { color: var(--c-success); font-weight: 650; }
.delta-bad { color: var(--c-danger); font-weight: 650; }
.compare-form { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
