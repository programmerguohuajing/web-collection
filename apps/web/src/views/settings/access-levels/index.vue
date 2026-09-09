<script setup lang="ts">
/**
 * 成员与数据等级（降级为只读）。
 *
 * 账号体系上线后：
 * - 保留四级数据访问矩阵 LEVELS 与“我的当前等级”徽章；
 * - 保留审计日志只读入口（GET /api/audit/data-access）；
 * - 成员登记 / 等级调整等写操作已迁移至 /teams，本页不再直接写 /api/members；
 * - 新增“团队管理”跳转，引导到有写能力的团队控制台。
 *
 * 长文本（审计操作者 / 对象）沿用 <OverflowTip>（EP 2.14）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { pageLoading } from '../../../dashboard.js'
import { useAuth } from '../../../composables/useAuth'
import OverflowTip from '../../../components/OverflowTip.vue'

const router = useRouter()
const { authApi, accountsEnabled, isLoggedIn } = useAuth()

const loading = ref(false)
const currentLevel = ref<string | null>(null)
const auditDrawer = ref(false)
const auditItems = ref<Array<Record<string, unknown>>>([])

const LEVELS = [
  {
    key: 'L4', cls: 'l4', title: '完整数据', role: '平台管理员',
    rows: [['IP', '完整 IP', true], ['userId / 手机', '原值', true], ['原始事件', '✅', true], ['导出', '✅', true]]
  },
  {
    key: 'L3', cls: 'l3', title: '运维诊断', role: '研发',
    rows: [['IP', '段脱敏 + 归属地', true], ['userId / 手机', '原值 / 脱敏', true], ['原始事件', '✅', true], ['导出', '✅ 脱敏', true]]
  },
  {
    key: 'L2', cls: 'l2', title: '业务分析', role: '产品 / 运营（默认）',
    rows: [['IP', '归属省市 + 运营商', true], ['userId / 手机', 'hash8 / 脱敏', true], ['原始事件', '✅ 脱敏', true], ['导出', '❌', false]]
  },
  {
    key: 'L1', cls: 'l1', title: '只读统计', role: '外部 / 演示',
    rows: [['IP', '❌', false], ['userId / 手机', '❌', false], ['原始事件', '❌ 仅聚合', false], ['导出', '❌', false]]
  }
]

const readOnly = computed(() => accountsEnabled.value)

async function load(): Promise<void> {
  loading.value = true
  pageLoading.value = true
  try {
    const levelData = await authApi('/api/me/access-level', { requestKey: 'al:me' }).catch(() => null)
    currentLevel.value = (levelData as { level?: string } | null)?.level || null
  } catch {
    currentLevel.value = null
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

async function openAudit(): Promise<void> {
  auditDrawer.value = true
  try {
    const data = await authApi('/api/audit/data-access', { requestKey: 'al:audit' })
    auditItems.value = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []
  } catch {
    auditItems.value = []
  }
}

function goTeams(): void {
  if (!isLoggedIn.value) {
    ElMessage.info('请先登录后再管理团队')
    router.push('/login')
    return
  }
  router.push('/teams')
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-heading">
      <div>
        <h1>成员与数据等级</h1>
        <p>四级数据访问模型（L1~L4），按角色裁剪 API 响应中的敏感字段；展示层分级，存储始终含完整数据。</p>
      </div>
      <div style="display: flex; gap: 8px">
        <el-button @click="openAudit">审计日志</el-button>
        <el-button type="primary" @click="goTeams">团队管理</el-button>
      </div>
    </div>

    <div class="caliber-note">
      <span class="ci">◈</span>
      <div>
        <b>合规内建</b>：查询侧统一脱敏中间件按请求者等级处理敏感字段（ip / userId / user_phone / context.* PII）。
        <b>白名单制</b>——新接口默认全脱敏，显式声明才放行；中间件故障 fail-close，绝不 fail-open。
        <template v-if="readOnly">当前为账号体系模式，成员与等级的调整请在<b>团队管理</b>中进行。</template>
        <template v-else>当前部署无账号体系，全局等级由环境变量 <code>DATA_ACCESS_LEVEL</code> 配置<template v-if="currentLevel">（当前：<b>{{ currentLevel }}</b>）</template>。</template>
      </div>
    </div>

    <!-- 我的当前等级 -->
    <el-alert
      v-if="currentLevel"
      class="level-banner"
      type="success"
      :closable="false"
      show-icon
      :title="`我的当前数据等级：${currentLevel}`"
    />

    <!-- 等级矩阵卡 -->
    <div class="lvl-grid">
      <div v-for="level in LEVELS" :key="level.key" class="lvl-card" :class="level.cls">
        <div class="lc-head">
          <div class="lc-badge">{{ level.key }}</div>
          <div>
            <h4>{{ level.title }}</h4>
            <div class="lc-role">{{ level.role }}<template v-if="currentLevel === level.key"> · 当前</template></div>
          </div>
        </div>
        <div v-for="[label, value, yes] in level.rows" :key="label" class="lc-row">
          <span class="lk">{{ label }}</span>
          <span class="lv" :class="yes ? 'yes' : 'no'">{{ value }}</span>
        </div>
      </div>
    </div>

    <!-- 审计抽屉（只读） -->
    <el-drawer v-model="auditDrawer" title="数据访问审计" size="480px">
      <el-table :data="auditItems" size="small" border empty-text="暂无审计记录">
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ row.createdAt ? new Date(Number(row.createdAt)).toLocaleString() : '-' }}</template>
        </el-table-column>
        <el-table-column label="操作者" width="140">
          <template #default="{ row }"><OverflowTip :text="row.memberId || row.actor || '-'" /></template>
        </el-table-column>
        <el-table-column prop="action" label="动作" width="110" />
        <el-table-column label="对象" min-width="160">
          <template #default="{ row }"><OverflowTip :text="row.target || '-'" /></template>
        </el-table-column>
      </el-table>
    </el-drawer>
  </div>
</template>

<style scoped>
.level-banner { margin: 4px 0 16px; }
</style>
