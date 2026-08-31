<script setup>
import { onMounted, reactive, ref, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ChatDotRound, Promotion, Plus, BellFilled } from '@element-plus/icons-vue'
import { api } from '../../../dashboard.js'

const route = useRoute()
const conversations = ref([])
const messages = ref([])          // 当前会话消息 [{role, content}]
const activeConvId = ref(null)
const question = ref('')
const loading = ref(false)
const insights = ref([])
const scrollRef = ref(null)

function pushPrefill() {
  const q = route.query.q
  if (typeof q === 'string' && q) question.value = q
}

async function loadConversations() {
  try {
    const data = await api('/api/ai/conversations?limit=30', { requestKey: 'assistant:conv' })
    conversations.value = data?.items || []
  } catch { /* 忽略 */ }
}

async function loadInsights() {
  try {
    const data = await api('/api/ai/findings?status=open&limit=20', { requestKey: 'assistant:insights' })
    insights.value = data?.items || []
  } catch { /* 忽略 */ }
}

async function send() {
  const text = question.value.trim()
  if (!text || loading.value) return
  loading.value = true
  messages.value.push({ role: 'user', content: text })
  question.value = ''
  await scrollBottom()
  try {
    const body = { question: text }
    if (activeConvId.value) body.conversationId = activeConvId.value
    const r = await api('/api/ai/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), requestKey: 'assistant:ask'
    })
    messages.value = r.messages || [...messages.value, { role: 'assistant', content: r.answer }]
    activeConvId.value = r.conversationId
    await loadConversations()
  } catch (e) {
    ElMessage.error(e?.message || '提问失败')
  } finally {
    loading.value = false
    await scrollBottom()
  }
}

function newChat() {
  activeConvId.value = null
  messages.value = []
}

async function openConversation(c) {
  activeConvId.value = c.id
  messages.value = c.messages || []
  await scrollBottom()
}

function useInsight(f) {
  question.value = `分析这条 AI 洞察：${f.summary}`
}

async function scrollBottom() {
  await nextTick()
  if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight
}

const SCOPE_LABEL = {
  'error-cluster': '错误簇', 'release-regression': '发布回归',
  'perf-regression': '性能退化', 'metric-drop': '指标骤降'
}

onMounted(() => { pushPrefill(); loadConversations(); loadInsights() })
</script>

<template>
  <div class="assistant-page">
    <!-- 左：会话历史 -->
    <aside class="col col-left">
      <div class="col-head">
        <span>对话历史</span>
        <el-button :icon="Plus" circle size="small" @click="newChat" />
      </div>
      <div class="conv-list">
        <div
          v-for="c in conversations" :key="c.id"
          class="conv-item" :class="{ active: c.id === activeConvId }"
          @click="openConversation(c)"
        >{{ c.title || '未命名对话' }}</div>
        <p v-if="!conversations.length" class="empty">暂无历史对话</p>
      </div>
    </aside>

    <!-- 中：对话 -->
    <section class="col col-center">
      <div class="col-head"><el-icon><ChatDotRound /></el-icon> AI 助手</div>
      <div ref="scrollRef" class="chat-scroll">
        <p v-if="!messages.length" class="empty">向 AI 助手提问，例如：「为什么今天 iOS 支付转化率掉了？」「上周三的崩溃高峰是什么？」</p>
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div class="bubble">{{ m.content }}</div>
        </div>
      </div>
      <div class="chat-input">
        <el-input
          v-model="question" type="textarea" :rows="2" resize="none"
          placeholder="输入问题，Enter 发送（Shift+Enter 换行）"
          @keydown.enter.exact.prevent="send"
        />
        <el-button type="primary" :icon="Promotion" :loading="loading" @click="send">发送</el-button>
      </div>
    </section>

    <!-- 右：主动洞察 -->
    <aside class="col col-right">
      <div class="col-head"><el-icon><BellFilled /></el-icon> 主动洞察</div>
      <div class="insight-list">
        <div v-for="f in insights" :key="f.id" class="insight-item" @click="useInsight(f)">
          <el-tag size="small">{{ SCOPE_LABEL[f.scope] || f.scope }}</el-tag>
          <p>{{ f.summary }}</p>
        </div>
        <p v-if="!insights.length" class="empty">暂无未处理洞察</p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.assistant-page { display: grid; grid-template-columns: 240px 1fr 280px; height: calc(100vh - 120px); gap: 12px; padding: 12px 16px; }
.col { border: 1px solid var(--el-border-color-lighter); border-radius: 10px; display: flex; flex-direction: column; min-height: 0; background: var(--el-bg-color); }
.col-head { display: flex; align-items: center; gap: 6px; padding: 12px 14px; font-weight: 600; border-bottom: 1px solid var(--el-border-color-lighter); }
.col-left .col-head { justify-content: space-between; }
.conv-list, .insight-list, .chat-scroll { overflow-y: auto; padding: 10px 12px; flex: 1; min-height: 0; }
.conv-item { padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; margin-bottom: 4px; }
.conv-item:hover { background: var(--el-fill-color-light); }
.conv-item.active { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.chat-scroll { display: flex; flex-direction: column; gap: 10px; }
.msg { display: flex; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 78%; padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.msg.user .bubble { background: var(--el-color-primary); color: #fff; }
.msg.assistant .bubble { background: var(--el-fill-color-light); }
.chat-input { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--el-border-color-lighter); }
.insight-item { padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 8px; border: 1px solid var(--el-border-color-lighter); }
.insight-item:hover { border-color: var(--el-color-primary); }
.insight-item p { margin: 6px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.empty { color: var(--el-text-color-placeholder); font-size: 13px; text-align: center; margin-top: 24px; }
</style>
