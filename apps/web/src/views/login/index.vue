<script setup lang="ts">
/**
 * /login —— 顶层登录 / 注册页（不套 Layout）。
 *
 * - 提交登录 → POST /api/auth/login → 存 eys_at → 跳 /teams（accounts 开）或 /。
 * - 开放注册开启（capabilities.openRegister）或带 ?invite=TOKEN 时显示注册表单；
 *   注册若返回令牌则自动登录，否则回登录框提示手动登录。
 * - 已登录（token + /api/me 通过）直接跳转走。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Loading, User, Lock, UserFilled } from '@element-plus/icons-vue'
import { useAuth } from '../../composables/useAuth'

const { isLoggedIn, accountsEnabled, login, register, loadCapabilities, loadMe } = useAuth()
const route = useRoute()
const router = useRouter()

const inviteToken = ref(typeof route.query.invite === 'string' ? route.query.invite : '')
const mode = ref<'login' | 'register'>('login')
const ready = ref(false)
const submitting = ref(false)

const loginForm = reactive({ email: '', password: '' })
const registerForm = reactive({ name: '', email: '', password: '' })

const showRegister = computed(() => mode.value === 'register')
const canRegister = computed(() => accountsEnabled.value || Boolean(inviteToken.value))

async function goAway() {
  await router.replace(accountsEnabled.value ? '/teams' : '/')
}

onMounted(async () => {
  await loadCapabilities()
  if (isLoggedIn.value) {
    try {
      await loadMe()
      await goAway()
      return
    } catch {
      /* token 失效，留在登录页 */
    }
  }
  mode.value = canRegister.value ? 'register' : 'login'
  ready.value = true
})

async function onLogin(): Promise<void> {
  if (!loginForm.email.trim() || !loginForm.password) return ElMessage.warning('请输入邮箱和密码')
  submitting.value = true
  try {
    await login(loginForm.email.trim(), loginForm.password)
    ElMessage.success('登录成功')
    await goAway()
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '登录失败')
  } finally {
    submitting.value = false
  }
}

async function onRegister(): Promise<void> {
  if (!registerForm.email.trim() || !registerForm.password) return ElMessage.warning('请输入邮箱和密码')
  submitting.value = true
  try {
    const auto = await register({
      email: registerForm.email.trim(),
      password: registerForm.password,
      name: registerForm.name.trim() || undefined,
      inviteToken: inviteToken.value || undefined
    })
    if (auto) {
      ElMessage.success('注册成功')
      await goAway()
    } else {
      ElMessage.success('注册成功，请使用账号登录')
      loginForm.email = registerForm.email
      mode.value = 'login'
    }
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '注册失败')
  } finally {
    submitting.value = false
  }
}

function toggle(target: 'login' | 'register'): void {
  mode.value = target
}
</script>

<template>
  <div class="auth-shell">
    <div class="auth-card">
      <div class="auth-brand">
        <span class="brand-logo">{{ brandShortName }}</span>
        <div>
          <h1>{{ brandName }}</h1>
          <p>{{ brandSubtitle }} · 账号登录</p>
        </div>
      </div>

      <el-alert v-if="inviteToken" type="info" :closable="false" show-icon class="auth-invite">
        <template #title>你收到一个团队邀请，注册后将加入对应团队</template>
      </el-alert>

      <el-tabs v-model="mode" class="auth-tabs">
        <el-tab-pane label="登录" name="login" />
        <el-tab-pane label="注册" name="register" :disabled="!canRegister" />
      </el-tabs>

      <!-- 登录 -->
      <el-form v-if="!showRegister" :model="loginForm" @submit.prevent="onLogin" label-position="top">
        <el-form-item label="邮箱">
          <el-input v-model="loginForm.email" type="email" placeholder="you@team.com" :prefix-icon="User" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="loginForm.password"
            type="password"
            show-password
            placeholder="请输入密码"
            :prefix-icon="Lock"
            autocomplete="current-password"
            @keyup.enter="onLogin"
          />
        </el-form-item>
        <el-button type="primary" native-type="submit" :loading="submitting" class="auth-submit">
          <el-icon v-if="submitting"><Loading /></el-icon> 登录
        </el-button>
      </el-form>

      <!-- 注册 -->
      <el-form v-else :model="registerForm" @submit.prevent="onRegister" label-position="top">
        <el-form-item label="名称">
          <el-input v-model="registerForm.name" placeholder="可选，如 张工" :prefix-icon="UserFilled" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="registerForm.email" type="email" placeholder="you@team.com" :prefix-icon="User" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="registerForm.password"
            type="password"
            show-password
            placeholder="请设置密码"
            :prefix-icon="Lock"
            autocomplete="new-password"
            @keyup.enter="onRegister"
          />
        </el-form-item>
        <el-button type="primary" native-type="submit" :loading="submitting" class="auth-submit">
          <el-icon v-if="submitting"><Loading /></el-icon> 注册
        </el-button>
      </el-form>

      <div class="auth-foot" v-if="canRegister">
        <el-link type="primary" @click="toggle(showRegister ? 'login' : 'register')">
          {{ showRegister ? '已有账号？去登录' : '没有账号？去注册' }}
        </el-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-shell { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; background: var(--el-bg-color-page, #f5f7fa); }
.auth-card { width: 100%; max-width: 380px; background: var(--el-bg-color, #fff); border-radius: 12px; padding: 28px 28px 22px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
.auth-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.brand-logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg,#4f7cff,#3b5bdb); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px; }
.auth-brand h1 { margin: 0; font-size: 18px; }
.auth-brand p { margin: 2px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.auth-invite { margin-bottom: 14px; }
.auth-tabs { margin-bottom: 6px; }
.auth-submit { width: 100%; margin-top: 6px; }
.auth-foot { text-align: center; margin-top: 14px; font-size: 13px; }
</style>
