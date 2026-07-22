<script setup>
import { nextTick, ref } from 'vue'
import { Replayer } from '@rrweb/replay'

const props = defineProps({
  replays: { type: Array, default: () => [] },
  loadReplay: { type: Function, required: true },
  loading: Boolean,
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 10 }
})
defineEmits(['page-change', 'size-change'])

const replayEl = ref(null)
const isPlaying = ref(false)
const progress = ref(0)
const duration = ref(0)
const currentReplayId = ref('')
let currentReplayer = null
let progressTimer = 0

const REASON_MAP = {
  error: '报错',
  route: '页面跳转',
  page_unload: '页面关闭',
  max_duration: '达到时长上限',
  normal: '正常结束'
}

function reasonLabel(reason) {
  return REASON_MAP[reason] || '未记录'
}

function replayUser(row) {
  const value = row.userName || row.userId || row.userPhone || row.user || row.username || row.account || row.accountName || row.memberName || row.nickname || ''
  return value == null || value === 'null' ? '' : value
}

function fitReplay(width, height) {
  const viewport = replayEl.value?.querySelector('.replayer-wrapper')
  const iframe = replayEl.value?.querySelector('iframe')
  if (!viewport || !iframe || !width || !height) return

  const panelWidth = replayEl.value.clientWidth
  const panelHeight = replayEl.value.clientHeight
  const scale = Math.min(panelWidth / width, panelHeight / height, 1)
  const scaledWidth = width * scale
  const scaledHeight = height * scale

  viewport.style.transformOrigin = 'top left'
  viewport.style.transform = `scale(${scale})`
  viewport.style.left = `${Math.max((panelWidth - scaledWidth) / 2, 0)}px`
  viewport.style.top = `${Math.max((panelHeight - scaledHeight) / 2, 0)}px`
  iframe.style.width = `${width}px`
  iframe.style.height = `${height}px`
}

async function play(item) {
  currentReplayId.value = item.replayId
  const events = await props.loadReplay(item.replayId)
  await nextTick()
  destroyPlayer()
  if (!events.length || !replayEl.value) return

  const meta = events.find((event) => event.type === 4)?.data || {}
  const width = meta.width || replayEl.value.clientWidth || 1024
  const height = meta.height || replayEl.value.clientHeight || 768

  try {
    currentReplayer = new Replayer(events, {
      root: replayEl.value,
      width,
      height,
      UNSAFE_replayCanvas: true,
      showWarning: false
    })
    duration.value = Math.max(events[events.length - 1].timestamp - events[0].timestamp, 0)
    progress.value = 0
    fitReplay(width, height)
    currentReplayer.play()
    isPlaying.value = true
    startProgress()
  } catch (error) {
    destroyPlayer()
  }
}

function playReplay() {
  currentReplayer?.play()
  isPlaying.value = true
  startProgress()
}

function pauseReplay() {
  currentReplayer?.pause()
  isPlaying.value = false
  window.clearInterval(progressTimer)
}

function seek(value) {
  if (!currentReplayer) return
  currentReplayer.play(value)
  if (!isPlaying.value) {
    currentReplayer.pause()
  }
  progress.value = value
}

function startProgress() {
  window.clearInterval(progressTimer)
  progressTimer = window.setInterval(() => {
    if (!currentReplayer || !duration.value) return
    const next = Math.min(progress.value + 500, duration.value)
    progress.value = next
    if (next >= duration.value) {
      window.clearInterval(progressTimer)
      isPlaying.value = false
    }
  }, 500)
}

function destroyPlayer() {
  window.clearInterval(progressTimer)
  progressTimer = 0
  progress.value = 0
  duration.value = 0
  isPlaying.value = false
  currentReplayer = null
  if (replayEl.value) {
    replayEl.value.innerHTML = ''
  }
}

function formatTime(ms) {
  const seconds = Math.floor(ms / 1000)
  const minute = Math.floor(seconds / 60)
  const second = String(seconds % 60).padStart(2, '0')
  return `${minute}:${second}`
}
defineExpose({ play })
</script>

<template>
  <section class="grid replay-grid section">
    <el-card v-loading="loading" shadow="never" class="panel">
      <template #header>
        <div class="panel-head">
          <h2>会话回放</h2>
          <small>{{ replays.length }} 条</small>
        </div>
      </template>
      <el-table :data="replays" row-key="replayId" highlight-current-row :current-row-key="currentReplayId" size="small" empty-text="暂无回放">
        <el-table-column label="页面" min-width="260">
          <template #default="{ row }">
            <span class="table-ellipsis" :title="row.url || row.sessionId || ''">{{ row.url || row.sessionId || '' }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="replays.some(row => replayUser(row))" label="用户" min-width="140">
          <template #default="{ row }">
            <span class="table-ellipsis" :title="replayUser(row) || ''">{{ replayUser(row) || '' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="版本" width="120">
          <template #default="{ row }">
            <span class="table-ellipsis" :title="row.release || ''">{{ row.release || '' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结束原因" width="110">
          <template #default="{ row }">{{ reasonLabel(row.endReason) }}</template>
        </el-table-column>
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ row.lastSeen ? new Date(row.lastSeen).toLocaleString() : '' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="play(row)">播放</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="total > pageSize"
        class="pager"
        background
        layout="sizes, prev, pager, next, total"
        :current-page="page"
        :page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        @current-change="$emit('page-change', $event)"
        @size-change="$emit('size-change', $event)"
      />
    </el-card>

    <el-card shadow="never" class="panel replay-panel">
      <template #header>
        <div class="panel-head">
          <h2>播放窗口</h2>
          <small>{{ formatTime(progress) }} / {{ formatTime(duration) }}</small>
        </div>
      </template>
      <div class="replay-stage" ref="replayEl"></div>
      <div class="replay-controls">
        <el-button type="primary" :disabled="!duration" @click="isPlaying ? pauseReplay() : playReplay()">
          {{ isPlaying ? '暂停' : '播放' }}
        </el-button>
        <el-slider :model-value="progress" :max="duration || 1" :step="500" :disabled="!duration" @change="seek" />
      </div>
    </el-card>
  </section>
</template>
