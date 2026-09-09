<script setup lang="ts">
/**
 * @file 仪表盘头部组件。
 *
 * 能力位驱动：
 * - accounts=false：保持原有 Admin API Key 输入框（零回归，供无账号体系部署沿用）。
 * - accounts=true：渲染账号用户菜单（头像/首字母 + 邮箱、团队切换、角色/等级徽章、
 *   “团队管理” → /teams、“退出登录” → POST /api/auth/logout + 清 token + 跳 /login）。
 *
 * 消费 useAuth 单例的登录态与能力位。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowDown, Switch, Setting, SwitchButton } from '@element-plus/icons-vue'
import { useAuth, ROLE_LABELS, LEVEL_LABELS } from '../composables/useAuth'
import OverflowTip from './OverflowTip.vue'

defineProps({ loading: Boolean })
const apiKey = defineModel('apiKey', { type: String, default: '' })
defineEmits(['refresh'])

const { me, currentTeamId, accountsEnabled, logout, switchTeam, loadCapabilities } = useAuth()
const router = useRouter()
const switching = ref(false)

const initial = computed(() => {
  const u = me.value?.user
  if (!u) return '?'
  return (u.name || u.email || '?').slice(0, 1).toUpperCase()
})
const emailText = computed(() => me.value?.user?.email || '')

async function onSwitchTeam(teamId: string): Promise<void> {
  if (teamId === currentTeamId.value) return
  switching.value = true
  try {
    await switchTeam(teamId)
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '切换团队失败')
  } finally {
    switching.value = false
  }
}

async function onCommand(cmd: string): Promise<void> {
  if (cmd === 'teams') {
    router.push('/teams')
  } else if (cmd === 'logout') {
    await logout()
    await router.replace('/login')
  }
}

onMounted(() => {
  if (accountsEnabled.value) loadCapabilities()
})
</script>

<template>
  <!-- accounts=false：保持原 Admin API Key 输入，零回归 -->
  <section v-if="!accountsEnabled" class="hero section">
    <div>
      <p class="eyebrow">{{ brandName }}</p>
      <h1>前端监控生产看板</h1>
    </div>
    <el-form class="keybar" @submit.prevent="$emit('refresh')">
      <el-input v-model="apiKey" placeholder="Admin API Key" type="password" show-password />
      <el-button type="primary" native-type="submit" :loading="loading">刷新</el-button>
    </el-form>
  </section>

  <!-- accounts=true：账号用户菜单 -->
  <section v-else class="hero section account-hero">
    <div>
      <p class="eyebrow">{{ brandName }}</p>
      <h1>前端监控生产看板</h1>
    </div>
    <el-dropdown trigger="click" class="account-menu" @command="onCommand">
      <span class="account-trigger">
        <span class="account-avatar">{{ initial }}</span>
        <span class="account-email"><OverflowTip :text="emailText" /></span>
        <el-icon><ArrowDown /></el-icon>
      </span>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item disabled class="account-summary">
            <div class="as-email"><OverflowTip :text="emailText" /></div>
            <div class="as-badge">
              <el-tag
                v-if="me?.role"
                size="small"
                :type="me.role === 'owner' ? 'danger' : me.role === 'admin' ? 'warning' : 'info'"
                effect="light"
              >{{ ROLE_LABELS[me.role] }} · {{ LEVEL_LABELS[me.level] }}</el-tag>
            </div>
          </el-dropdown-item>
          <el-dropdown-item divided>
            <div class="team-switch">
              <span class="ts-label"><el-icon><Switch /></el-icon> 当前团队</span>
              <el-select
                :model-value="currentTeamId"
                @change="onSwitchTeam"
                :loading="switching"
                size="small"
                class="ts-select"
              >
                <el-option v-for="t in (me?.teams || [])" :key="t.id" :label="t.name" :value="t.id" />
              </el-select>
            </div>
          </el-dropdown-item>
          <el-dropdown-item command="teams"><el-icon><Setting /></el-icon> 团队管理</el-dropdown-item>
          <el-dropdown-item command="logout" divided><el-icon><SwitchButton /></el-icon> 退出登录</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </section>
</template>

<style scoped>
.account-hero .account-menu { margin-left: auto; }
.account-trigger { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; outline: none; max-width: 280px; }
.account-avatar { width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg,#6366f1,#0ea5e9); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex: none; }
.account-email { max-width: 200px; overflow: hidden; }
.account-summary { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.as-email { max-width: 220px; }
.team-switch { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; }
.ts-label { display: inline-flex; align-items: center; gap: 4px; color: var(--el-text-color-regular); font-size: 13px; white-space: nowrap; }
.ts-select { width: 150px; }
</style>
