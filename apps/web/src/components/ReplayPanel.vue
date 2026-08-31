<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Replayer } from '@rrweb/replay'
import '@rrweb/replay/dist/style.css'
import {
  Calendar,
  Clock,
  Filter,
  Monitor,
  RefreshRight,
  User,
  VideoPause,
  VideoPlay,
  WarningFilled
} from '@element-plus/icons-vue'

const props = defineProps({
  replays: { type: Array, default: () => [] },
  loadReplay: { type: Function, required: true },
  loading: Boolean,
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 10 }
})
const emit = defineEmits(['page-change', 'size-change', 'filter', 'refresh', 'replay-not-found'])

const replayEl = ref(null)
const isPlaying = ref(false)
const progress = ref(0)
const duration = ref(0)
const playbackRate = ref(1)
const replayError = ref('')
const currentReplayId = ref('')
const selectedReplay = ref(null)
const loadingReplayId = ref('')
const replayEvents = ref([])
const replayViewport = ref({ width: 0, height: 0 })
let currentReplayer = null
let progressTimer = 0
let playRequestId = 0

// @rrweb/replay 的运行时入口未导出 ReplayerEvents，使用其稳定的公开事件名。
const RRWEB_FULL_SNAPSHOT = 'fullsnapshot-rebuilded'

const REASON_MAP = {
  error: '报错结束',
  route: '页面跳转',
  page_unload: '页面关闭',
  max_duration: '达到时长上限',
  normal: '正常结束'
}

const INCREMENTAL_EVENT_MAP = {
  0: '页面内容更新',
  1: '鼠标移动',
  2: '点击页面元素',
  3: '页面滚动',
  4: '视口尺寸变化',
  5: '输入操作',
  6: '触摸移动',
  7: '媒体交互',
  8: '样式更新',
  9: '画布更新',
  10: '字体加载',
  11: '控制台日志',
  12: '拖拽操作'
}

const currentReplay = computed(() => (
  props.replays.find(item => String(item.replayId) === String(currentReplayId.value)) || selectedReplay.value
))

const currentSessionCode = computed(() => {
  const value = currentReplay.value?.sessionId || currentReplayId.value
  if (!value) return '尚未选择'
  return String(value).length > 18 ? `${String(value).slice(0, 8)}…${String(value).slice(-6)}` : String(value)
})

const currentPageLabel = computed(() => currentReplay.value?.url || '尚未记录页面地址')

const keyEvents = computed(() => {
  if (!replayEvents.value.length) return []
  const firstTimestamp = Number(replayEvents.value[0]?.timestamp) || 0
  return replayEvents.value
    .filter(event => {
      if (event?.type === 1 || event?.type === 2 || event?.type === 4 || event?.type === 5) return true
      return event?.type === 3 && [2, 3, 4, 5, 7, 11, 12].includes(Number(event?.data?.source))
    })
    .slice(0, 8)
    .map((event, index) => ({
      id: `${event.timestamp || 0}-${event.type || 0}-${index}`,
      label: replayEventLabel(event),
      time: formatTime(Math.max((Number(event.timestamp) || firstTimestamp) - firstTimestamp, 0))
    }))
})

const replayErrorCount = computed(() => replayEvents.value.filter(event => {
  if (event?.type !== 5) return false
  const text = `${event?.data?.tag || ''} ${event?.data?.payload?.type || ''}`
  return /error|exception|unhandled/i.test(text)
}).length)

const sessionInfo = computed(() => [
  { icon: User, label: '用户', value: replayUser(currentReplay.value) || '未识别' },
  { icon: User, label: '用户 ID', value: currentReplay.value?.userId || '未采集', mono: true },
  { icon: Monitor, label: '设备', value: deriveDevice(currentReplay.value?.userAgent) },
  {
    icon: Monitor,
    label: '分辨率',
    value: replayViewport.value.width && replayViewport.value.height
      ? `${replayViewport.value.width} × ${replayViewport.value.height}`
      : '未采集',
    mono: true
  },
  { icon: Clock, label: '时长', value: duration.value ? formatDuration(duration.value) : '未采集', mono: true },
  { icon: Calendar, label: '回放时间', value: formatDate(currentReplay.value?.lastSeen) },
  { icon: VideoPlay, label: '事件数', value: replayEvents.value.length ? replayEvents.value.length.toLocaleString() : '0', mono: true },
  { icon: WarningFilled, label: '错误事件', value: `${replayErrorCount.value}`, mono: true, danger: replayErrorCount.value > 0 }
])

function reasonLabel(reason) {
  return REASON_MAP[reason] || '未记录结束原因'
}

function replayUser(row) {
  if (!row) return ''
  const value = row.userName || row.userId || row.userPhone || row.user || row.username || row.account || row.accountName || row.memberName || row.nickname || ''
  return value == null || value === 'null' ? '' : String(value)
}

// 从 SDK 上报的 userAgent 推导 浏览器 / OS / 设备类型（与 runFunnel 的 UA 解析口径一致）。
// 后端 replayList 已返回 userAgent；历史回放该字段为空时回退「未采集」。
function deriveDevice(ua) {
  if (!ua) return '未采集'
  const s = String(ua)
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : 'Other'
  const os = /Windows NT/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
    : /Linux/.test(s) ? 'Linux'
    : 'Unknown OS'
  const device = /Mobile|Android|iPhone|iPod/.test(s) && !/iPad/.test(s) ? '移动端'
    : /iPad|Tablet/.test(s) ? '平板' : '桌面端'
  return `${browser} · ${os} · ${device}`
}

function replayEventLabel(event) {
  if (event?.type === 1) return '页面加载完成'
  if (event?.type === 2) return '生成页面快照'
  if (event?.type === 4) return '记录视口信息'
  if (event?.type === 5) return event?.data?.tag ? `自定义事件 · ${event.data.tag}` : '自定义事件'
  if (event?.type === 3) return INCREMENTAL_EVENT_MAP[Number(event?.data?.source)] || '页面交互'
  return '回放事件'
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

function waitForInitialRender(replayer, timeout = 350) {
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      replayer.off(RRWEB_FULL_SNAPSHOT, finish)
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, timeout)
    // rrweb creates the iframe hidden and only reveals it after the first
    // full snapshot. Waiting for that exact event prevents an immediate pause
    // after the Meta/resize event from cancelling the first frame.
    replayer.on(RRWEB_FULL_SNAPSHOT, finish)
  })
}

function ensureReplayFrameVisible(width, height) {
  const iframe = replayEl.value?.querySelector('iframe')
  if (!iframe) return
  iframe.style.display = 'inherit'
  iframe.setAttribute('width', String(width))
  iframe.setAttribute('height', String(height))
}

async function openReplay(item, autoPlay = false) {
  if (!item?.replayId || loadingReplayId.value === item.replayId) return
  const requestId = ++playRequestId
  replayError.value = ''
  currentReplayId.value = String(item.replayId)
  selectedReplay.value = props.replays.find(row => String(row.replayId) === String(item.replayId)) || item
  loadingReplayId.value = item.replayId
  destroyPlayer()
  replayEvents.value = []
  replayViewport.value = { width: 0, height: 0 }

  try {
    const payload = await props.loadReplay(item.replayId)
    if (requestId !== playRequestId || currentReplayId.value !== String(item.replayId)) return
    await nextTick()
    const events = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.events)
        ? payload.events
        : Array.isArray(payload?.data) ? payload.data : []
    if (!events.length || !replayEl.value) {
      replayError.value = '未获取到回放事件数据'
      // 深链 / 旧列表指向的会话已无回放数据：通知外层清理 URL 参数，
      // 并自动回落到列表中第一条可播的会话，避免停留在死状态。
      emit('replay-not-found', item.replayId)
      fallbackToFirstAvailable(item.replayId)
      return
    }

    const validEvents = events.filter(event => event && Number.isFinite(Number(event.timestamp)))
    if (!validEvents.length) {
      replayError.value = '事件数据格式不完整，无法播放'
      return
    }

    replayEvents.value = validEvents
    const meta = validEvents.find(event => event.type === 4)?.data || {}
    const width = Number(meta.width) || replayEl.value.clientWidth || 1024
    const height = Number(meta.height) || replayEl.value.clientHeight || 768
    replayViewport.value = { width, height }
    currentReplayer = new Replayer(validEvents, {
      root: replayEl.value,
      width,
      height,
      speed: playbackRate.value,
      UNSAFE_replayCanvas: true,
      showWarning: false
    })
    duration.value = Math.max(validEvents[validEvents.length - 1].timestamp - validEvents[0].timestamp, 0)
    progress.value = 0
    currentReplayer.play(0)
    await waitForInitialRender(currentReplayer)
    if (requestId !== playRequestId || currentReplayId.value !== String(item.replayId)) return
    ensureReplayFrameVisible(width, height)
    fitReplay(width, height)
    if (autoPlay) {
      isPlaying.value = true
      startProgress()
    } else {
      currentReplayer.pause()
      isPlaying.value = false
    }
  } catch (error) {
    if (requestId === playRequestId && error?.code !== 'ABORT_ERR') replayError.value = error?.message || '回放加载失败，请稍后重试'
    destroyPlayer()
  } finally {
    if (loadingReplayId.value === item.replayId) loadingReplayId.value = ''
  }
}

function play(item) {
  return openReplay(item, true)
}

/**
 * 当前会话无回放数据时，自动改播列表中第一条有数据的会话。
 * @param {string} failedId - 加载失败的 replayId，跳过它避免递归
 */
function fallbackToFirstAvailable(failedId) {
  const next = props.replays.find(row => row?.replayId && String(row.replayId) !== String(failedId))
  if (next) openReplay(next, false)
}

function prefetch(item) {
  if (item?.replayId) props.loadReplay(item.replayId).catch(() => {})
}

function playReplay() {
  const startAt = duration.value && progress.value >= duration.value ? 0 : progress.value
  progress.value = startAt
  currentReplayer?.play(startAt)
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
  const offset = Math.max(0, Number(value) || 0)
  if (isPlaying.value) {
    currentReplayer.play(offset)
  } else {
    // 暂停态用 pause(offset) 定位：rrweb 会同步应用该偏移前的事件再暂停；
    // 若在未起播时直接 play(offset)，timer 未启动会渲染出异常内容。
    currentReplayer.pause(offset)
  }
  progress.value = offset
}

/** 拖动进度条时仅更新本地进度值（不触发 rrweb seek），松手后由 @change=seek 真正跳转。 */
function onSliderInput(value) {
  progress.value = Math.max(0, Number(value) || 0)
}

function setPlaybackRate(rate) {
  playbackRate.value = rate
  currentReplayer?.setConfig({ speed: rate })
}

function startProgress() {
  window.clearInterval(progressTimer)
  progressTimer = window.setInterval(() => {
    if (!currentReplayer || !duration.value) return
    const current = typeof currentReplayer.getCurrentTime === 'function'
      ? Number(currentReplayer.getCurrentTime())
      : progress.value + (500 * playbackRate.value)
    const next = Math.min(Number.isFinite(current) ? current : progress.value, duration.value)
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
  const player = currentReplayer
  currentReplayer = null
  try { player?.destroy() } catch { /* 已由 Vue 清理 DOM 时无需重复销毁 */ }
  if (replayEl.value) replayEl.value.innerHTML = ''
}

function formatTime(ms) {
  const seconds = Math.floor((Number(ms) || 0) / 1000)
  const minute = Math.floor(seconds / 60)
  const second = String(seconds % 60).padStart(2, '0')
  return `${minute}:${second}`
}

function formatDuration(ms) {
  const seconds = Math.floor((Number(ms) || 0) / 1000)
  const minute = Math.floor(seconds / 60)
  const second = seconds % 60
  return `${minute}m ${second}s`
}

function formatDate(value) {
  if (!value) return '未采集'
  const numericValue = Number(value)
  const date = new Date(Number.isFinite(numericValue) ? numericValue : value)
  return Number.isNaN(date.getTime()) ? '未采集' : date.toLocaleString()
}

watch(() => props.replays, rows => {
  if (!currentReplayId.value && rows?.length) openReplay(rows[0], false)
}, { immediate: true })

onBeforeUnmount(() => {
  playRequestId += 1
  destroyPlayer()
})

defineExpose({ play, currentSessionCode })
</script>

<template>
  <section class="replay-detail-page section">
    <header class="replay-page-head">
      <div class="replay-breadcrumb" aria-label="当前会话">
        <span>用户会话</span>
        <span class="replay-breadcrumb-separator">/</span>
        <strong>{{ currentSessionCode }}</strong>
      </div>
      <div class="replay-page-actions">
        <el-button :icon="Filter" @click="emit('filter')">筛选</el-button>
        <el-button :icon="RefreshRight" :loading="loading" @click="emit('refresh')">刷新</el-button>
      </div>
    </header>

    <div class="replay-detail-grid">
      <el-card shadow="never" class="replay-preview-card">
        <template #header>
          <div class="replay-preview-head">
            <div>
              <h2>rrweb 回放预览</h2>
              <p>{{ currentPageLabel }}<template v-if="duration"> · {{ formatDuration(duration) }}</template></p>
            </div>
            <el-tag v-if="currentReplay" size="small" effect="plain" :type="currentReplay.endReason === 'error' ? 'danger' : 'info'">
              {{ reasonLabel(currentReplay.endReason) }}
            </el-tag>
          </div>
        </template>

        <div class="replay-player-shell" :class="{ 'is-loading': Boolean(loadingReplayId) }">
          <div class="replay-browser-bar" aria-hidden="true">
            <el-icon><Monitor /></el-icon>
            <span>{{ currentReplay?.url || 'about:blank' }}</span>
          </div>
          <div ref="replayEl" class="replay-stage"></div>
          <div v-if="loadingReplayId" class="replay-stage-state">
            <el-icon class="is-loading"><RefreshRight /></el-icon>
            <strong>正在加载会话回放</strong>
            <span>正在重组 rrweb 事件，请稍候</span>
          </div>
          <div v-else-if="!currentReplay" class="replay-stage-state">
            <el-icon><Monitor /></el-icon>
            <strong>暂无可回放的会话</strong>
            <span>调整筛选条件或等待新的会话数据上报</span>
          </div>
          <div v-else-if="replayError" class="replay-stage-state is-error">
            <el-icon><WarningFilled /></el-icon>
            <strong>{{ replayError }}</strong>
            <el-button size="small" plain @click="openReplay(currentReplay, false)">重新加载</el-button>
          </div>
        </div>

        <div class="replay-control-bar">
          <el-button
            class="replay-play-button"
            type="primary"
            circle
            :disabled="!duration"
            :aria-label="isPlaying ? '暂停回放' : '播放回放'"
            @click="isPlaying ? pauseReplay() : playReplay()"
          >
            <el-icon><VideoPause v-if="isPlaying" /><VideoPlay v-else /></el-icon>
          </el-button>
          <el-slider
            :model-value="progress"
            :max="duration || 1"
            :step="500"
            :disabled="!duration"
            :format-tooltip="formatTime"
            tooltip-class="replay-slider-tooltip"
            aria-label="回放进度"
            @input="onSliderInput"
            @change="seek"
          />
          <span class="replay-time">{{ formatTime(progress) }} / {{ formatTime(duration) }}</span>
          <div class="replay-speed segmented" aria-label="播放速度">
            <button
              v-for="rate in [1, 2, 4]"
              :key="rate"
              type="button"
              :class="{ active: playbackRate === rate }"
              @click="setPlaybackRate(rate)"
            >{{ rate }}×</button>
          </div>
        </div>
      </el-card>

      <aside class="replay-side-stack">
        <el-card shadow="never" class="replay-info-card">
          <template #header>
            <div class="panel-head">
              <h2>会话信息</h2>
              <small v-if="currentReplay?.release">v{{ currentReplay.release }}</small>
            </div>
          </template>
          <div class="replay-info-list">
            <div v-for="item in sessionInfo" :key="item.label" class="replay-info-row">
              <span class="replay-info-label"><el-icon><component :is="item.icon" /></el-icon>{{ item.label }}</span>
              <strong :class="{ mono: item.mono, danger: item.danger }">{{ item.value }}</strong>
            </div>
          </div>
        </el-card>

        <el-card shadow="never" class="replay-events-card">
          <template #header>
            <div class="panel-head">
              <h2>关键事件</h2>
              <small>{{ keyEvents.length }} 项</small>
            </div>
          </template>
          <div v-if="keyEvents.length" class="replay-event-list">
            <div v-for="event in keyEvents" :key="event.id" class="replay-event-item">
              <span class="replay-event-icon"><el-icon><VideoPlay /></el-icon></span>
              <div><strong>{{ event.label }}</strong><small>{{ event.time }}</small></div>
            </div>
          </div>
          <el-empty v-else :image-size="54" description="加载回放后展示关键事件" />
        </el-card>

        <el-card shadow="never" class="replay-session-card">
          <template #header>
            <div class="panel-head">
              <h2>最近会话</h2>
              <el-select
                :model-value="pageSize"
                size="small"
                class="replay-page-size"
                aria-label="每页会话数"
                @change="emit('size-change', $event)"
              >
                <el-option v-for="size in [10, 20, 50]" :key="size" :label="`${size} 条/页`" :value="size" />
              </el-select>
            </div>
          </template>
          <div v-if="replays.length" class="replay-session-list">
            <button
              v-for="row in replays"
              :key="row.replayId"
              type="button"
              class="replay-session-item"
              :class="{ active: String(row.replayId) === String(currentReplayId) }"
              @mouseenter="prefetch(row)"
              @focus="prefetch(row)"
              @click="openReplay(row, true)"
            >
              <span><strong>{{ replayUser(row) || row.sessionId || row.replayId }}</strong><small>{{ row.url || '未记录页面地址' }}</small></span>
              <small>{{ formatDate(row.lastSeen) }}</small>
            </button>
          </div>
          <el-empty v-else :image-size="54" description="暂无回放会话" />
          <el-pagination
            v-if="total > pageSize"
            class="replay-session-pager"
            small
            background
            layout="prev, pager, next"
            :current-page="page"
            :page-size="pageSize"
            :total="total"
            @current-change="emit('page-change', $event)"
          />
        </el-card>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.replay-detail-page { display: grid; gap: 16px; }
.replay-page-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.replay-breadcrumb { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--c-text-muted); font-size: 14px; }
.replay-breadcrumb strong { overflow: hidden; color: var(--c-text); font-family: var(--font-mono); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.replay-breadcrumb-separator { color: var(--c-text-faint); }
.replay-page-actions { display: flex; gap: 8px; }
.replay-detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) 304px; gap: 16px; align-items: start; }
.replay-preview-card { min-width: 0; overflow: hidden; }
.replay-preview-card :deep(.el-card__body) { padding: 0; }
.replay-preview-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.replay-preview-head h2 { margin: 0; color: var(--c-text); font-size: 16px; }
.replay-preview-head p { max-width: 720px; margin: 5px 0 0; overflow: hidden; color: var(--c-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.replay-player-shell { position: relative; min-height: 500px; overflow: hidden; background: #0f1420; }
.replay-browser-bar { display: flex; align-items: center; gap: 7px; height: 38px; padding: 0 14px; color: #98a2b3; background: #171d2b; border-bottom: 1px solid rgba(255,255,255,.07); }
.replay-browser-bar .el-icon { flex: 0 0 auto; color: #667085; }
.replay-browser-bar span { min-width: 0; overflow: hidden; font-family: var(--font-mono); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.replay-stage { position: relative; min-height: 462px; overflow: hidden; }
/* 回放页 root 透明时，iframe 会透出外层深色面板（df23697 引入的回归，表现为「黑块」）。
   给 replayer 容器/iframe 一个白底，让透明区域像真实浏览器一样显示白底。 */
.replay-stage :deep(.replayer-wrapper),
.replay-stage :deep(.replayer-wrapper > iframe) {
  background-color: #fff;
}
.replay-stage-state { position: absolute; inset: 38px 0 0; z-index: 2; display: grid; place-content: center; justify-items: center; gap: 9px; padding: 24px; color: #d0d5dd; text-align: center; background: #0f1420; }
.replay-stage-state .el-icon { color: #98a2b3; font-size: 30px; }
.replay-stage-state strong { color: #f2f4f7; font-size: 15px; }
.replay-stage-state span { color: #98a2b3; font-size: 12px; }
.replay-stage-state.is-error .el-icon, .replay-stage-state.is-error strong { color: #fda29b; }
.replay-control-bar { display: grid; grid-template-columns: 36px minmax(160px, 1fr) auto auto; align-items: center; gap: 12px; min-height: 68px; padding: 12px 16px; background: var(--c-surface); border-top: 1px solid var(--c-border-2); }
.replay-play-button { width: 36px; height: 36px; }
.replay-time { color: var(--c-text-muted); font-family: var(--font-mono); font-size: 12px; white-space: nowrap; }
.replay-speed { flex: 0 0 auto; }
.replay-speed button { min-height: 26px; padding: 3px 8px; font-family: var(--font-mono); font-size: 11px; }
.replay-side-stack { display: grid; gap: 16px; min-width: 0; }
.replay-info-list { display: grid; }
.replay-info-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 39px; border-bottom: 1px solid var(--c-border-2); }
.replay-info-row:last-child { border-bottom: 0; }
.replay-info-label { display: inline-flex; align-items: center; gap: 7px; color: var(--c-text-muted); font-size: 12px; }
.replay-info-label .el-icon { color: var(--c-text-faint); }
.replay-info-row strong { max-width: 164px; overflow: hidden; color: var(--c-text); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.replay-info-row strong.mono { font-family: var(--font-mono); font-weight: 500; }
.replay-info-row strong.danger { color: var(--c-danger); }
.replay-event-list { display: grid; }
.replay-event-item { position: relative; display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 9px; padding: 8px 0; }
.replay-event-item:not(:last-child)::after { position: absolute; top: 31px; bottom: -2px; left: 12px; width: 1px; content: ''; background: var(--c-border-2); }
.replay-event-icon { z-index: 1; display: grid; width: 26px; height: 26px; place-items: center; color: var(--c-primary); background: var(--c-primary-soft); border-radius: 50%; }
.replay-event-icon .el-icon { font-size: 12px; }
.replay-event-item div { display: grid; gap: 2px; min-width: 0; }
.replay-event-item strong { overflow: hidden; color: var(--c-text); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.replay-event-item small { font-family: var(--font-mono); font-size: 11px; }
.replay-page-size { width: 104px; }
.replay-session-list { display: grid; gap: 5px; }
.replay-session-item { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 9px 10px; color: var(--c-text); text-align: left; cursor: pointer; background: transparent; border: 1px solid transparent; border-radius: 8px; }
.replay-session-item:hover { background: var(--c-surface-2); }
.replay-session-item.active { color: var(--c-primary); background: var(--c-primary-soft); border-color: rgba(79,70,229,.22); }
.replay-session-item > span { display: grid; gap: 3px; min-width: 0; }
.replay-session-item strong, .replay-session-item small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.replay-session-item strong { font-size: 12px; }
.replay-session-item small { max-width: 104px; color: var(--c-text-muted); font-size: 10px; }
.replay-session-item > small { align-self: center; }
.replay-session-pager { justify-content: center; margin-top: 12px; }

@media (max-width: 1100px) {
  .replay-detail-grid { grid-template-columns: 1fr; }
  .replay-side-stack { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .replay-session-card { grid-column: 1 / -1; }
}

@media (max-width: 720px) {
  .replay-page-head { align-items: flex-start; }
  .replay-page-actions .el-button { padding: 8px; }
  .replay-page-actions .el-button :deep(span) { display: none; }
  .replay-player-shell { min-height: 360px; }
  .replay-stage { min-height: 322px; }
  .replay-control-bar { grid-template-columns: 36px minmax(100px, 1fr) auto; gap: 8px; }
  .replay-speed { grid-column: 1 / -1; justify-self: end; }
  .replay-side-stack { grid-template-columns: 1fr; }
  .replay-session-card { grid-column: auto; }
}
</style>

<!-- 回放进度条 tooltip（el-slider format-tooltip）由 ElTooltip 渲染到 body，需用全局样式。
     不再覆盖 margin-top：Popper 默认把手柄正上方作为基准，手动负 margin 会把它反向推回放画面里。 -->
<style>
.replay-slider-tooltip.el-tooltip__popper {
  padding: 4px 9px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .28);
}
</style>
