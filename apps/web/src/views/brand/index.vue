<script setup lang="ts">
/**
 * /brand —— D4 白标 / 私有化交付（PRD 16）品牌配置页。
 *
 * - 左侧：基础 / 资源 / 登录页 / 域名 四组表单，保存即写 GET/PUT /api/brand。
 * - 右侧：sticky 实时预览卡（本地 CSS 变量驱动，无需刷新即变色）。
 * - 能力位 whiteLabel=false：整页渲染 el-alert 占位（显式提示不静默隐藏），表单全部 disabled。
 * - 权限：brandManage（owner 恒放行；其余需 admin）→ 保存/重置按钮 disabled + tooltip。
 * - 长文本统一用 <OverflowTip>（禁用原生 show-overflow-tooltip，EP 2.14 红线）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuth } from '../../composables/useAuth'
import { canManageBrand } from '../../composables/useBrand'
import { getBrand, saveBrand, resetBrand } from '../../api/brand.js'
import OverflowTip from '../../components/OverflowTip.vue'

const { whiteLabelEnabled, me } = useAuth()

const loading = ref(false)
const saving = ref(false)

interface BrandForm {
  name: string
  shortName: string
  primaryColor: string
  logoUrl: string
  faviconUrl: string
  loginTitle: string
  loginSubtitle: string
  loginFooter: string
  consoleDomain: string
  collectDomain: string
}

function emptyForm(): BrandForm {
  return {
    name: '',
    shortName: '',
    primaryColor: '#4f46e5',
    logoUrl: '',
    faviconUrl: '',
    loginTitle: '',
    loginSubtitle: '',
    loginFooter: '',
    consoleDomain: '',
    collectDomain: ''
  }
}

const form = reactive<BrandForm>(emptyForm())
let savedSnapshot = ''

const canManage = computed(() => canManageBrand(me.value))
const colorValid = computed(() => /^#[0-9a-fA-F]{6}$/.test(form.primaryColor))
const dirty = computed(() => JSON.stringify(form) !== savedSnapshot)

// ---- 本地色板派生（仅预览用；全量色板以保存后 /brand.js 服务端为准） ----
function hexToRgb(hex: string) {
  const h = hex.replace('#', '')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}
function rgbToHsl(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b); const min = Math.min(r, g, b)
  let h = 0; let s = 0; const l = (max + min) / 2; const d = max - min
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4
    }
    h /= 6
  }
  return { h, s, l }
}
function hslToHex(h: number, s: number, l: number) {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const to2 = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${to2(hue2rgb(p, q, h + 1 / 3))}${to2(hue2rgb(p, q, h))}${to2(hue2rgb(p, q, h - 1 / 3))}`
}
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const previewPalette = computed(() => {
  const { r, g, b } = hexToRgb(form.primaryColor || '#4f46e5')
  const { h, s, l } = rgbToHsl(r, g, b)
  return {
    hover: hslToHex(h, s, clamp(l - 0.08, 0, 1)),
    soft: hslToHex(h, clamp(s - 0.05, 0, 1), clamp(l + 0.5, 0, 0.96))
  }
})
const previewVars = computed(() => ({
  '--c-primary': form.primaryColor,
  '--c-primary-hover': previewPalette.value.hover,
  '--c-primary-soft': previewPalette.value.soft
}))

const previewTitle = computed(() => form.loginTitle || form.name || 'Web Collection')
const previewShort = computed(() => form.shortName || (form.name ? form.name.slice(0, 2).toUpperCase() : 'WC'))

// 预览显示用的已保存域名（仅展示，不随表单实时变）
const savedConsoleDomain = ref('')
const savedCollectDomain = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    const data = (await getBrand()) as Partial<BrandForm> & { consoleDomain?: string; collectDomain?: string }
    form.name = data.name || ''
    form.shortName = data.shortName || ''
    form.primaryColor = data.primaryColor || '#4f46e5'
    form.logoUrl = data.logoUrl || ''
    form.faviconUrl = data.faviconUrl || ''
    form.loginTitle = data.loginTitle || ''
    form.loginSubtitle = data.loginSubtitle || ''
    form.loginFooter = data.loginFooter || ''
    form.consoleDomain = data.consoleDomain || ''
    form.collectDomain = data.collectDomain || ''
    savedConsoleDomain.value = data.consoleDomain || ''
    savedCollectDomain.value = data.collectDomain || ''
    savedSnapshot = JSON.stringify(form)
  } catch {
    ElMessage.error('加载品牌配置失败')
  } finally {
    loading.value = false
  }
}

async function onSave(): Promise<void> {
  if (!colorValid.value) {
    ElMessage.warning('主色格式不正确，请使用 #RRGGBB')
    return
  }
  saving.value = true
  try {
    const data = (await saveBrand({ ...form })) as Partial<BrandForm> & { consoleDomain?: string; collectDomain?: string }
    form.consoleDomain = data.consoleDomain || ''
    form.collectDomain = data.collectDomain || ''
    savedConsoleDomain.value = data.consoleDomain || ''
    savedCollectDomain.value = data.collectDomain || ''
    savedSnapshot = JSON.stringify(form)
    ElMessage.success('已保存，刷新页面后全量生效')
    try {
      await ElMessageBox.confirm('是否立即刷新页面，使品牌（主色/标题/Logo/favicon）全量生效？', '保存成功', {
        confirmButtonText: '立即刷新',
        cancelButtonText: '稍后',
        type: 'success'
      })
      window.location.reload()
    } catch {
      /* 用户选择稍后，不打断连续编辑 */
    }
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function onReset(): Promise<void> {
  saving.value = true
  try {
    const data = (await resetBrand()) as Partial<BrandForm> & { consoleDomain?: string; collectDomain?: string }
    form.name = data.name || ''
    form.shortName = data.shortName || ''
    form.primaryColor = data.primaryColor || '#4f46e5'
    form.logoUrl = data.logoUrl || ''
    form.faviconUrl = data.faviconUrl || ''
    form.loginTitle = data.loginTitle || ''
    form.loginSubtitle = data.loginSubtitle || ''
    form.loginFooter = data.loginFooter || ''
    form.consoleDomain = data.consoleDomain || ''
    form.collectDomain = data.collectDomain || ''
    savedConsoleDomain.value = data.consoleDomain || ''
    savedCollectDomain.value = data.collectDomain || ''
    savedSnapshot = JSON.stringify(form)
    ElMessage.success('已重置为默认品牌')
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '重置失败')
  } finally {
    saving.value = false
  }
}

function onCancel(): void {
  Object.assign(form, JSON.parse(savedSnapshot || '{}'))
}

onMounted(load)
</script>

<template>
  <div class="brand-page">
    <div class="page-heading">
      <div>
        <h1>品牌与白标</h1>
        <p>品牌配置为全局生效，仅影响展示与部署文档，不改变任何采集与数据口径。</p>
      </div>
    </div>

    <!-- 能力位未开启：显式占位，不静默隐藏 -->
    <el-alert
      v-if="!whiteLabelEnabled"
      class="section"
      type="info"
      show-icon
      :closable="false"
      title="当前部署不支持白标（capability: whiteLabel）"
      description="Cloudflare Worker 部署需设置 WHITE_LABEL_ENABLED=1 后重启实例方可启用；Node 自托管部署默认支持。"
    />

    <div class="brand-grid">
      <!-- 左：表单 -->
      <el-card class="section form-card" :body-style="{ padding: '18px 20px' }">
        <el-form :model="form" label-width="92px" label-position="right" :disabled="!whiteLabelEnabled">
          <div class="brand-group-title">基础</div>
          <el-form-item label="品牌名" required>
            <el-input v-model="form.name" maxlength="80" show-word-limit placeholder="如 Web Collection" />
          </el-form-item>
          <el-form-item label="侧栏缩写">
            <el-input v-model="form.shortName" maxlength="8" placeholder="如 WC（无 Logo 时展示）" />
          </el-form-item>
          <el-form-item label="主色" :error="colorValid ? '' : '格式应为 #RRGGBB'">
            <div class="color-row">
              <el-color-picker v-model="form.primaryColor" />
              <el-input v-model="form.primaryColor" class="color-hex" placeholder="#4f46e5" />
              <el-button text type="primary" @click="form.primaryColor = '#4f46e5'">重置为 #4f46e5</el-button>
            </div>
          </el-form-item>

          <el-divider />

          <div class="brand-group-title">资源</div>
          <el-form-item label="Logo URL">
            <el-input v-model="form.logoUrl" placeholder="https:// 或 / 开头相对路径；留空走缩写方块" />
          </el-form-item>
          <el-form-item label="Favicon URL">
            <el-input v-model="form.faviconUrl" placeholder="https:// 或 / 开头；留空用 /favicon.svg" />
          </el-form-item>

          <el-divider />

          <div class="brand-group-title">登录页</div>
          <el-form-item label="标题">
            <el-input v-model="form.loginTitle" maxlength="80" show-word-limit placeholder="留空则回落品牌名" />
          </el-form-item>
          <el-form-item label="副标题">
            <el-input v-model="form.loginSubtitle" maxlength="120" show-word-limit placeholder="如 前端遥测平台" />
          </el-form-item>
          <el-form-item label="页脚">
            <el-input v-model="form.loginFooter" type="textarea" :rows="2" maxlength="160" show-word-limit placeholder="备案 / 版权信息（可选）" />
          </el-form-item>

          <el-divider />

          <div class="brand-group-title">域名</div>
          <el-form-item label="控制台域名">
            <el-input v-model="form.consoleDomain" placeholder="monitor.customer.com（仅记录 + 文档引导）" />
          </el-form-item>
          <el-form-item label="采集域名">
            <el-input v-model="form.collectDomain" disabled placeholder="由 SDK init({ endpoint }) 生效" />
            <div class="field-hint">采集域名由 SDK <code>init({ endpoint })</code> 入参生效，此处仅用于生成接入片段，平台不修改采集协议。</div>
          </el-form-item>
        </el-form>

        <div class="brand-actions">
          <el-popconfirm
            v-if="whiteLabelEnabled"
            title="确认重置为内置默认品牌？"
            confirm-button-text="重置"
            cancel-button-text="取消"
            @confirm="onReset"
          >
            <template #reference>
              <el-button :disabled="!canManage || !whiteLabelEnabled" :loading="saving">重置为默认</el-button>
            </template>
          </el-popconfirm>
          <el-button v-else :disabled="true">重置为默认</el-button>

          <el-button @click="onCancel" :disabled="!whiteLabelEnabled || !dirty">取消</el-button>
          <el-tooltip v-if="!canManage" content="需要 Admin 及以上（owner 恒可）" placement="top">
            <el-button type="primary" :loading="saving" :disabled="!canManage || !whiteLabelEnabled" @click="onSave">保存</el-button>
          </el-tooltip>
          <el-button v-else type="primary" :loading="saving" :disabled="!whiteLabelEnabled || !dirty" @click="onSave">保存</el-button>
        </div>
      </el-card>

      <!-- 右：实时预览卡 -->
      <div class="preview-col">
        <el-card class="section preview-card" :body-style="{ padding: '16px' }">
          <template #header>
            <div class="preview-head">
              <span>实时预览</span>
              <el-tag v-if="dirty && whiteLabelEnabled" type="info" size="small">未保存</el-tag>
            </div>
          </template>

          <!-- 微缩侧栏 -->
          <div class="mini-sidebar">
            <div class="mini-brand">
              <img v-if="form.logoUrl" :src="form.logoUrl" class="mini-logo" alt="logo" />
              <span v-else class="mini-logo mini-logo-text">{{ previewShort }}</span>
              <div class="mini-brand-text">
                <strong>{{ form.name || 'Web Collection' }}</strong>
                <small>{{ form.loginSubtitle || '前端遥测平台' }}</small>
              </div>
            </div>
          </div>

          <!-- 主色按钮组 + tag -->
          <div class="preview-block" :style="previewVars">
            <el-button type="primary">主色按钮</el-button>
            <el-button>默认按钮</el-button>
            <el-button type="primary" text>文字按钮</el-button>
            <el-tag :style="{ background: form.primaryColor, borderColor: form.primaryColor, color: '#fff' }">主色标签</el-tag>
          </div>

          <!-- 登录页小样 -->
          <div class="preview-block login-sample" :style="previewVars">
            <div class="login-sample-brand">
              <img v-if="form.logoUrl" :src="form.logoUrl" class="mini-logo" alt="logo" />
              <span v-else class="mini-logo mini-logo-text">{{ previewShort }}</span>
              <div>
                <h3>{{ previewTitle }}</h3>
                <p>{{ form.loginSubtitle || '前端遥测平台' }} · 账号登录</p>
              </div>
            </div>
            <div v-if="form.loginFooter" class="login-sample-footer">
              <OverflowTip :text="form.loginFooter" />
            </div>
          </div>

          <!-- 域名展示 -->
          <div class="preview-domains" v-if="savedConsoleDomain || savedCollectDomain">
            <div class="pd-row"><span class="pd-k">控制台域名</span><OverflowTip :text="savedConsoleDomain || '—'" /></div>
            <div class="pd-row"><span class="pd-k">采集域名</span><OverflowTip :text="savedCollectDomain || '—'" /></div>
          </div>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.brand-page { padding: 18px 20px 40px; }
.brand-grid { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 18px; align-items: start; }
@media (max-width: 1200px) { .brand-grid { grid-template-columns: 1fr; } }
.color-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.color-hex { width: 140px; }
.field-hint { font-size: 12px; color: var(--c-text-faint); margin-top: 4px; line-height: 1.5; }
.field-hint code { background: var(--c-surface-3); padding: 1px 5px; border-radius: 4px; }
.brand-group-title { font-size: 13px; font-weight: 650; color: var(--c-text-muted); margin: 4px 0 12px; }
.brand-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
.preview-col { position: sticky; top: 18px; }
.preview-head { display: flex; align-items: center; justify-content: space-between; font-weight: 600; }
.mini-sidebar { background: linear-gradient(180deg, #071a30, #061426); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
.mini-brand { display: flex; align-items: center; gap: 10px; color: #fff; }
.mini-brand-text { display: flex; flex-direction: column; min-width: 0; }
.mini-brand-text strong { font-size: 15px; }
.mini-brand-text small { color: #9fb2c8; font-size: 11px; }
.mini-logo { width: 30px; height: 30px; border-radius: 7px; object-fit: cover; flex: none; }
.mini-logo-text { display: inline-flex; align-items: center; justify-content: center; background: var(--c-primary, #4f46e5); color: #fff; font-weight: 700; font-size: 12px; }
.preview-block { margin-bottom: 14px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px; border: 1px solid var(--c-border); border-radius: 10px; }
.login-sample { flex-direction: column; align-items: stretch; gap: 10px; }
.login-sample-brand { display: flex; align-items: center; gap: 10px; }
.login-sample-brand h3 { margin: 0; font-size: 16px; }
.login-sample-brand p { margin: 2px 0 0; font-size: 12px; color: var(--c-text-muted); }
.login-sample-footer { font-size: 12px; color: var(--c-text-faint); border-top: 1px dashed var(--c-border-2); padding-top: 8px; }
.preview-domains { font-size: 12px; border-top: 1px solid var(--c-border); padding-top: 10px; }
.pd-row { display: flex; gap: 8px; padding: 3px 0; }
.pd-k { color: var(--c-text-faint); width: 72px; flex: none; }
</style>
