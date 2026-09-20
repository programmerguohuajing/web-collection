<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Back,
  Check,
  CircleCheck,
  Cpu,
  DocumentCopy,
  Guide,
  Key,
  Odometer,
  Plus,
  Right,
  Setting,
  Warning
} from '@element-plus/icons-vue'

const STORAGE_KEY = 'web_eys_onboarding_completed'

const visible = ref(false)
const activeStep = ref(0)
const router = useRouter()

const steps = [
  { title: '平台概览', icon: Odometer },
  { title: '创建应用', icon: Plus },
  { title: '采集密钥', icon: Key },
  { title: 'SDK 集成', icon: Cpu },
  { title: '验证上报', icon: CircleCheck }
]

const sdkSnippet = computed(() => {
  const origin = window.location.origin || 'https://your-domain.com'
  return `// 1. 安装 Web Collection SDK
// npm install @web-collection/sdk

// 2. 在入口文件 (main.js / App.vue) 初始化 SDK
import WebSDK from '@web-collection/sdk'

WebSDK.init({
  appId: 'your_app_id',       // 在系统设置中创建的应用 ID
  appKey: 'your_app_key',     // 应用对应的采集鉴权 Key
  endpoint: '${origin}/api/v1/report', // 采集服务上报地址
  sampling: {
    error: 1.0,               // 错误采集率 (100%)
    performance: 1.0,         // 性能分析采集率 (100%)
    behavior: 1.0             // 用户行为采集率 (100%)
  },
  plugins: {
    replay: true              // 启用录屏与会话回放
  }
})`
})

function open(startFromZero = true) {
  if (startFromZero) {
    activeStep.value = 0
  }
  visible.value = true
}

function close() {
  visible.value = false
}

function completeTour() {
  localStorage.setItem(STORAGE_KEY, 'true')
  visible.value = false
  ElMessage.success('已完成新手接入引导！')
}

function skipTour() {
  localStorage.setItem(STORAGE_KEY, 'true')
  visible.value = false
}

function prevStep() {
  if (activeStep.value > 0) {
    activeStep.value--
  }
}

function nextStep() {
  if (activeStep.value < steps.length - 1) {
    activeStep.value++
  } else {
    completeTour()
  }
}

function goToSettings() {
  localStorage.setItem(STORAGE_KEY, 'true')
  visible.value = false
  router.push('/settings')
}

function goToLive() {
  localStorage.setItem(STORAGE_KEY, 'true')
  visible.value = false
  router.push('/live')
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(sdkSnippet.value)
    ElMessage.success('SDK 初始化代码已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败，请手动选择复制代码')
  }
}

function isCompleted() {
  return localStorage.getItem(STORAGE_KEY) === 'true'
}

defineExpose({
  open,
  close,
  isCompleted
})
</script>

<template>
  <el-dialog
    v-model="visible"
    title="新手接入与管理后台引导"
    width="760px"
    :close-on-click-modal="false"
    class="onboarding-dialog"
    destroy-on-close
  >
    <!-- 优化后的现代步骤指示器 -->
    <div class="custom-step-bar">
      <div
        v-for="(s, idx) in steps"
        :key="idx"
        class="custom-step-item"
        :class="{
          'is-active': activeStep === idx,
          'is-completed': activeStep > idx,
          'is-upcoming': activeStep < idx
        }"
        @click="activeStep = idx"
      >
        <div class="step-node">
          <div class="step-badge">
            <el-icon v-if="activeStep > idx"><Check /></el-icon>
            <el-icon v-else><component :is="s.icon" /></el-icon>
          </div>
          <span class="step-title">{{ s.title }}</span>
        </div>
        <div v-if="idx < steps.length - 1" class="step-line" :class="{ 'is-active': activeStep > idx }" />
      </div>
    </div>

    <!-- 主体步骤内容容器 -->
    <div class="tour-body">
      <!-- Step 0: 平台概览与欢迎 -->
      <div v-if="activeStep === 0" class="step-card">
        <div class="welcome-banner">
          <el-icon class="banner-icon"><Guide /></el-icon>
          <div>
            <h3>欢迎使用 Web Collection 前端监控与全链路诊断平台</h3>
            <p>为您的全端应用（Web、小程序、Node 等）提供实时错误监控、性能分析、用户行为轨迹、会话回放与 AI 智能诊断。</p>
          </div>
        </div>
        <div class="feature-grid">
          <div class="feature-item">
            <el-icon class="f-icon error-icon"><Warning /></el-icon>
            <div>
              <b>错误与异常捕获</b>
              <span>自动收集 JS 运行时报错、Promise 拒绝、API 异常与 SourceMap 还原。</span>
            </div>
          </div>
          <div class="feature-item">
            <el-icon class="f-icon perf-icon"><Cpu /></el-icon>
            <div>
              <b>性能与链路追踪</b>
              <span>提供 Core Web Vitals、资源加载瀑布图、分布式 APM 链路追踪。</span>
            </div>
          </div>
          <div class="feature-item">
            <el-icon class="f-icon replay-icon"><Odometer /></el-icon>
            <div>
              <b>会话回放与分析</b>
              <span>录制用户崩溃前后的还原视频，结合行为路径分析迅速定界问题。</span>
            </div>
          </div>
          <div class="feature-item">
            <el-icon class="f-icon ai-icon"><Setting /></el-icon>
            <div>
              <b>治理与 AI 诊断</b>
              <span>支持采样上报、合规 DSR 治理、敏感数据掩码以及大模型根因诊断。</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Step 1: 如何创建 AppID -->
      <div v-else-if="activeStep === 1" class="step-card">
        <div class="step-header">
          <div class="step-badge">步骤 1/4</div>
          <h3>创建应用与 AppID</h3>
        </div>
        <p class="step-desc">
          管理后台以<b>应用 (Application)</b> 为数据隔离单元。在接入数据之前，您需要先创建一个应用项目，并获取对应的 <code>AppID</code>。
        </p>

        <div class="instruction-box">
          <ol>
            <li>进入管理后台的 <b>系统设置 -> 项目管理</b> 页面。</li>
            <li>点击 <b>“创建应用”</b> 按钮。</li>
            <li>填写应用名称（如 <code>商城前端主站</code>）与平台类型（如 <code>Web</code>）。</li>
            <li>系统将自动生成全局唯一的 <b>AppID</b>（如 <code>app_mall_web</code>）。</li>
          </ol>
        </div>

        <div class="action-card-prompt">
          <el-button type="primary" plain @click="goToSettings">
            <el-icon><Setting /></el-icon> 立即去系统设置创建应用
          </el-button>
          <span class="prompt-tip">提示：您也可以先完成引导，随后再前往创建。</span>
        </div>
      </div>

      <!-- Step 2: 获取采集密钥 AppKey -->
      <div v-else-if="activeStep === 2" class="step-card">
        <div class="step-header">
          <div class="step-badge">步骤 2/4</div>
          <h3>获取采集密钥 (AppKey / Secret)</h3>
        </div>
        <p class="step-desc">
          为了保障数据上报安全，每个应用除了 <code>AppID</code> 外，还配有一个唯一的 <b>采集密钥 (AppKey)</b> 用于 SDK 校验鉴权。
        </p>

        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="AppID 与 AppKey 的区别"
          description="AppID 为公开的项目唯一标识；AppKey 是用于鉴权数据合法写入的密钥。请在控制台应用列表中进行管理与复制。"
          class="info-alert"
        />

        <div class="instruction-box">
          <div class="list-preview-mock">
            <div class="mock-row">
              <span class="mock-name">Web 商城主站</span>
              <span class="mock-appid">AppID: <code>app_mall_web</code></span>
              <span class="mock-key">AppKey: <code>k_9a8f7e6d...</code></span>
              <el-tag size="small" type="success">已启用</el-tag>
            </div>
          </div>
          <p class="sub-tip">在系统设置的应用列表中，您可以随时查看、复制或重新生成采集密钥。</p>
        </div>
      </div>

      <!-- Step 3: 集成 SDK 代码 -->
      <div v-else-if="activeStep === 3" class="step-card">
        <div class="step-header">
          <div class="step-badge">步骤 3/4</div>
          <h3>SDK 初始化与代码接入</h3>
        </div>
        <p class="step-desc">
          在您的前端项目入口引入 <code>@web-collection/sdk</code>，传入创建好的 <code>AppID</code> 和 <code>AppKey</code> 即可开启监控。
        </p>

        <div class="code-container">
          <div class="code-header">
            <span>JavaScript / TypeScript 初始化示例</span>
            <el-button size="small" type="primary" plain @click="copyCode">
              <el-icon><DocumentCopy /></el-icon> 复制代码
            </el-button>
          </div>
          <pre class="code-block"><code>{{ sdkSnippet }}</code></pre>
        </div>
      </div>

      <!-- Step 4: 数据上报验证与体验 -->
      <div v-else-if="activeStep === 4" class="step-card">
        <div class="step-header">
          <div class="step-badge">步骤 4/4</div>
          <h3>验证数据上报与数据看板</h3>
        </div>
        <p class="step-desc">
          完成 SDK 初始化后，在项目中触发一个测试报错或页面跳转，数据即会实时上报到控制台。
        </p>

        <div class="verify-grid">
          <div class="verify-card">
            <el-icon class="v-icon text-primary"><Odometer /></el-icon>
            <h4>总览看板</h4>
            <p>查看全站错误率、PV/UV、性能指标与趋势分布。</p>
          </div>
          <div class="verify-card">
            <el-icon class="v-icon text-success"><CircleCheck /></el-icon>
            <h4>实时监控</h4>
            <p>秒级流式展现最新接入的数据事件与报错详情。</p>
          </div>
        </div>

        <div class="complete-prompt">
          <el-icon class="c-check-icon"><Check /></el-icon>
          <span>恭喜！您已了解接入流程。点击下方“完成引导”即可开始使用。</span>
        </div>
      </div>
    </div>

    <!-- 底部控制按钮栏 -->
    <template #footer>
      <div class="tour-footer">
        <el-button @click="skipTour">跳过引导</el-button>
        <div class="right-btns">
          <el-button v-if="activeStep > 0" @click="prevStep">
            <el-icon><Back /></el-icon> 上一步
          </el-button>
          <el-button v-if="activeStep < steps.length - 1" type="primary" @click="nextStep">
            下一步 <el-icon><Right /></el-icon>
          </el-button>
          <el-button v-else type="success" @click="completeTour">
            <el-icon><Check /></el-icon> 完成引导
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.onboarding-dialog :deep(.el-dialog__body) {
  padding: 16px 24px 24px;
}

/* 优化步骤条外观 */
.custom-step-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px 20px;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  position: relative;
}

.custom-step-item {
  display: flex;
  flex: 1;
  align-items: center;
  position: relative;
  cursor: pointer;
  user-select: none;
}

.custom-step-item:last-child {
  flex: none;
}

.step-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 2;
  transition: all 0.3s ease;
  min-width: 76px;
}

.step-badge {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  background: var(--el-fill-color-blank);
  border: 2px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
}

.step-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-secondary);
  transition: color 0.3s ease, font-weight 0.3s ease;
  white-space: nowrap;
}

/* 连接线 */
.step-line {
  flex: 1;
  height: 3px;
  background: var(--el-border-color-lighter);
  transition: background-color 0.4s ease;
  margin: 0 8px;
  margin-bottom: 24px;
  border-radius: 2px;
}

.step-line.is-active {
  background: linear-gradient(90deg, #6366f1, #0ea5e9);
}

/* 激活状态 (Active) */
.custom-step-item.is-active .step-badge {
  background: linear-gradient(135deg, #6366f1, #0ea5e9);
  border-color: transparent;
  color: #ffffff;
  transform: scale(1.15);
  box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
}

.custom-step-item.is-active .step-title {
  color: #6366f1;
  font-weight: 700;
}

/* 已完成状态 (Completed) */
.custom-step-item.is-completed .step-badge {
  background: var(--el-color-success-light-9, #ecfdf5);
  border-color: var(--el-color-success, #10b981);
  color: var(--el-color-success, #10b981);
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.2);
}

.custom-step-item.is-completed .step-title {
  color: var(--el-color-success, #10b981);
  font-weight: 600;
}

/* 悬停微效 */
.custom-step-item:hover .step-badge {
  transform: translateY(-2px) scale(1.08);
}

.tour-body {
  min-height: 320px;
}

.welcome-banner {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 20px;
}

.banner-icon {
  font-size: 32px;
  color: var(--el-color-primary);
  flex-shrink: 0;
  margin-top: 2px;
}

.welcome-banner h3 {
  margin: 0 0 6px;
  font-size: 16px;
  color: var(--el-text-color-primary);
}

.welcome-banner p {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}

.feature-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 12px 14px;
}

.f-icon {
  font-size: 20px;
  flex-shrink: 0;
  margin-top: 2px;
}

.error-icon { color: var(--el-color-danger); }
.perf-icon { color: var(--el-color-primary); }
.replay-icon { color: var(--el-color-warning); }
.ai-icon { color: var(--el-color-purple, #8b5cf6); }

.feature-item b {
  display: block;
  font-size: 14px;
  margin-bottom: 4px;
  color: var(--el-text-color-primary);
}

.feature-item span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
  display: block;
}

.step-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.step-badge {
  background: var(--el-color-primary);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
}

.step-header h3 {
  margin: 0;
  font-size: 17px;
}

.step-desc {
  font-size: 13.5px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
  margin-bottom: 16px;
}

.instruction-box {
  background: var(--el-fill-color-light);
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
}

.instruction-box ol {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--el-text-color-primary);
}

.action-card-prompt {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 16px;
}

.prompt-tip {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.info-alert {
  margin-bottom: 16px;
}

.list-preview-mock {
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  padding: 10px 14px;

}

.mock-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}

.mock-name { font-weight: 600; }
.mock-appid code, .mock-key code {
  background: var(--el-fill-color-darker);
  color: var(--el-color-primary);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
}

.sub-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 8px 0 0;
}

.code-container {
  background: #1e1e2e;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-dark);
}

.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  background: #252538;
  color: #a6adc8;
  font-size: 12px;
}

.code-block {
  margin: 0;
  padding: 14px;
  color: #cdd6f4;
  font-family: 'Fira Code', Consolas, Monaco, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  overflow-x: auto;
}

.verify-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}

.verify-card {
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 16px;
  text-align: center;
}

.v-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.verify-card h4 {
  margin: 0 0 6px;
  font-size: 15px;
}

.verify-card p {
  margin: 0;
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}

.complete-prompt {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--el-color-success-light-9);
  border: 1px solid var(--el-color-success-light-6);
  color: var(--el-color-success);
  padding: 12px;
  border-radius: 8px;
  font-size: 13.5px;
  font-weight: 500;
}

.c-check-icon {
  font-size: 18px;
}

.tour-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.right-btns {
  display: flex;
  gap: 8px;
}
</style>
