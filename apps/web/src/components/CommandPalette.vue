<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, Close, Search } from '@element-plus/icons-vue'

const props = defineProps({
  /** 导航分组数据：[{ label, items: [{ title, path, icon }] }] */
  groups: { type: Array, default: () => [] }
})

const router = useRouter()
const visible = ref(false)
const query = ref('')
const activeIndex = ref(0)
const inputRef = ref(null)
const listRef = ref(null)

/** 拍平为可搜索条目 */
const flatItems = computed(() =>
  props.groups.flatMap(group =>
    (group.items || []).map(item => ({
      title: item.title,
      path: item.path,
      icon: item.icon,
      group: group.label || ''
    }))
  )
)

/** 简单包含匹配：标题 / 分组 / 路径 */
const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return flatItems.value
  return flatItems.value.filter(item =>
    item.title.toLowerCase().includes(q) ||
    item.group.toLowerCase().includes(q) ||
    item.path.toLowerCase().includes(q)
  )
})

/** 按分组聚合渲染，同时保留全局下标供键盘导航 */
const sections = computed(() => {
  const map = new Map()
  results.value.forEach((item, idx) => {
    const key = item.group || '其他'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push({ ...item, flatIndex: idx })
  })
  return [...map.entries()].map(([group, items]) => ({ group, items }))
})

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
/** 高亮标题中的匹配片段 */
function highlight(title) {
  const q = query.value.trim()
  if (!q) return escapeHtml(title)
  const lower = title.toLowerCase()
  const needle = q.toLowerCase()
  const i = lower.indexOf(needle)
  if (i < 0) return escapeHtml(title)
  return escapeHtml(title.slice(0, i)) + '<mark>' + escapeHtml(title.slice(i, i + needle.length)) + '</mark>' + escapeHtml(title.slice(i + needle.length))
}

function open() {
  query.value = ''
  activeIndex.value = 0
  visible.value = true
}
function close() { visible.value = false }

function go(item) {
  if (!item?.path) return
  close()
  router.push(item.path)
}

function onKeydown(e) {
  const n = results.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (n) activeIndex.value = (activeIndex.value + 1) % n
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (n) activeIndex.value = (activeIndex.value - 1 + n) % n
  } else if (e.key === 'Enter') {
    e.preventDefault()
    go(results.value[activeIndex.value])
  }
}

watch(query, () => { activeIndex.value = 0 })

watch(activeIndex, async () => {
  await nextTick()
  listRef.value?.querySelector('.cmd-item.active')?.scrollIntoView({ block: 'nearest' })
})

function onGlobalKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (visible.value) close()
    else open()
  }
}

function onOpened() {
  nextTick(() => inputRef.value?.focus())
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))

defineExpose({ open, close })
</script>

<template>
  <el-dialog
    v-model="visible"
    custom-class="cmd-palette"
    :show-close="false"
    width="640px"
    top="12vh"
    @opened="onOpened"
  >
    <div class="cmd-box">
      <div class="cmd-input-wrap">
        <el-icon class="cmd-search-icon"><Search /></el-icon>
        <input
          ref="inputRef"
          v-model="query"
          class="cmd-input"
          placeholder="搜索页面… 试试「漏斗」「回放」「告警」"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKeydown"
        />
        <kbd v-if="!query" class="cmd-kbd">⌘K</kbd>
        <el-icon v-else class="cmd-clear" @click="query = ''"><Close /></el-icon>
      </div>

      <div ref="listRef" class="cmd-list">
        <template v-if="sections.length">
          <template v-for="section in sections" :key="section.group">
            <div class="cmd-group-label">{{ section.group }}</div>
            <button
              v-for="item in section.items"
              :key="item.path"
              type="button"
              class="cmd-item"
              :class="{ active: item.flatIndex === activeIndex }"
              @click="go(item)"
              @mouseenter="activeIndex = item.flatIndex"
            >
              <span class="cmd-item-icon"><el-icon><component :is="item.icon" /></el-icon></span>
              <span class="cmd-item-body">
                <span class="cmd-item-title" v-html="highlight(item.title)" />
                <span class="cmd-item-path">{{ item.path }}</span>
              </span>
              <el-icon v-if="item.flatIndex === activeIndex" class="cmd-item-go"><ArrowRight /></el-icon>
            </button>
          </template>
        </template>
        <div v-else class="cmd-empty">无匹配页面，换个关键词试试</div>
      </div>

      <div class="cmd-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
        <span><kbd>↵</kbd> 跳转</span>
        <span><kbd>esc</kbd> 关闭</span>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.cmd-palette :deep(.el-dialog__header) { display: none; }
.cmd-palette :deep(.el-dialog__body) { padding: 0; }
.cmd-palette :deep(.el-dialog) {
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28), 0 4px 16px rgba(15, 23, 42, 0.12);
}
.cmd-box { display: flex; flex-direction: column; max-height: 66vh; }
.cmd-input-wrap {
  display: flex; align-items: center; gap: 10px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.cmd-search-icon { font-size: 18px; color: var(--el-text-color-placeholder); flex: none; }
.cmd-input {
  flex: 1; border: none; outline: none; background: transparent;
  font-size: 16px; color: var(--el-text-color-primary);
}
.cmd-input::placeholder { color: var(--el-text-color-placeholder); }
.cmd-kbd, .cmd-footer kbd {
  font-family: inherit; font-size: 11px; color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px; padding: 2px 7px; white-space: nowrap;
}
.cmd-clear { cursor: pointer; color: var(--el-text-color-placeholder); font-size: 15px; }
.cmd-clear:hover { color: var(--el-text-color-primary); }
.cmd-list { overflow-y: auto; padding: 8px; min-height: 120px; }
.cmd-group-label {
  font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
  color: var(--el-text-color-placeholder);
  padding: 10px 12px 4px;
}
.cmd-item {
  display: flex; align-items: center; gap: 12px; width: 100%;
  padding: 9px 12px; border: none; border-radius: 10px;
  background: transparent; cursor: pointer; text-align: left;
  transition: background 120ms ease;
}
.cmd-item.active { background: var(--el-color-primary-light-9); }
.cmd-item-icon {
  display: grid; place-items: center; width: 34px; height: 34px; flex: none;
  border-radius: 9px; font-size: 16px;
  background: var(--el-fill-color-light); color: var(--el-text-color-regular);
}
.cmd-item.active .cmd-item-icon {
  background: var(--el-color-primary); color: #fff;
}
.cmd-item-body { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.cmd-item-title { font-size: 14px; font-weight: 600; color: var(--el-text-color-primary); }
.cmd-item-title :deep(mark) {
  background: transparent; color: var(--el-color-primary); font-weight: 800;
}
.cmd-item-path { font-size: 11px; font-family: var(--font-mono, monospace); color: var(--el-text-color-placeholder); }
.cmd-item-go { color: var(--el-color-primary); font-size: 15px; flex: none; }
.cmd-empty { padding: 36px 0; text-align: center; font-size: 13px; color: var(--el-text-color-placeholder); }
.cmd-footer {
  display: flex; gap: 18px; align-items: center;
  padding: 10px 18px; border-top: 1px solid var(--el-border-color-lighter);
  font-size: 11px; color: var(--el-text-color-secondary);
}
.cmd-footer span { display: inline-flex; align-items: center; gap: 5px; }
</style>
