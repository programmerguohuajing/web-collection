<script setup>
import { computed, nextTick, ref } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  mode: { type: String, default: 'text' },
  variables: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  minHeight: { type: Number, default: 120 }
})

const emit = defineEmits(['update:modelValue'])

const taRef = ref(null)
const lastCursor = ref(0)
const flashKey = ref('')

const groupedVars = computed(() => {
  const map = new Map()
  for (const v of props.variables) {
    if (!map.has(v.group)) map.set(v.group, [])
    map.get(v.group).push(v)
  }
  return [...map.entries()]
})

const exampleMap = computed(() => {
  const m = {}
  for (const v of props.variables) m[v.key] = v.example
  return m
})

const jsonValid = computed(() => {
  if (props.mode !== 'json' || !props.modelValue) return null
  try { JSON.parse(props.modelValue); return true } catch { return false }
})

const preview = computed(() => {
  if (!props.modelValue) return ''
  return props.modelValue.replace(/\$\{(\w+)\}/g, (_, k) => exampleMap.value[k] ?? '${' + k + '}')
})

function onInput(e) {
  emit('update:modelValue', e.target.value)
}

function cacheCursor() {
  if (taRef.value) lastCursor.value = taRef.value.selectionStart
}

function insertVar(key) {
  const ta = taRef.value
  if (!ta) return
  const active = document.activeElement === ta
  const s = active ? ta.selectionStart : lastCursor.value
  const e = active ? ta.selectionEnd : lastCursor.value
  const ins = '${' + key + '}'
  const next = (props.modelValue || '').slice(0, s) + ins + (props.modelValue || '').slice(e)
  emit('update:modelValue', next)
  nextTick(() => {
    ta.focus()
    const pos = s + ins.length
    ta.selectionStart = ta.selectionEnd = pos
    lastCursor.value = pos
  })
  flashKey.value = key
  setTimeout(() => { flashKey.value = '' }, 600)
}
</script>

<template>
  <div class="tpl-editor">
    <div class="tpl-editor-main" :style="{ minHeight: minHeight + 'px' }">
      <div class="tpl-ta-wrap">
        <textarea
          ref="taRef"
          class="tpl-ta"
          :value="modelValue"
          :placeholder="placeholder"
          spellcheck="false"
          @input="onInput"
          @keyup="cacheCursor"
          @click="cacheCursor"
          @blur="cacheCursor"
        />
        <div class="tpl-ta-foot">
          <span v-if="mode === 'json'" :class="jsonValid ? 'tpl-ok' : 'tpl-bad'">
            {{ jsonValid ? '✓ 合法 JSON' : (modelValue ? '✗ JSON 解析失败' : '请输入 JSON') }}
          </span>
          <span v-else class="tpl-ok">✓ 变量已就绪</span>
          <span class="tpl-hint">点击右侧变量插入光标处</span>
        </div>
      </div>
      <div class="tpl-vars">
        <div v-for="[group, vars] in groupedVars" :key="group" class="tpl-var-group">
          <div class="tpl-var-title">{{ group }}</div>
          <div
            v-for="v in vars"
            :key="v.key"
            class="tpl-vitem"
            :class="{ flash: flashKey === v.key }"
            :title="v.desc + '（示例：' + v.example + '）'"
            @click="insertVar(v.key)"
          >
            <span class="tpl-vl">{{ v.label }}</span>
            <span class="tpl-vk">{{ v.key }}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="tpl-prev">
      <span class="tpl-prev-label">预览（示例值渲染）</span>
      <pre class="tpl-prev-text">{{ preview || '（空模板）' }}</pre>
    </div>
  </div>
</template>

<style scoped>
.tpl-editor { border: 1px solid var(--c-border, #d3d1c7); border-radius: 10px; overflow: hidden; background: var(--c-surface, #fff); }
.tpl-editor-main { display: flex; }
.tpl-ta-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--c-border, #e5e3dc); }
.tpl-ta { flex: 1; width: 100%; box-sizing: border-box; border: 0; outline: 0; resize: vertical; padding: 12px; font-family: "SF Mono", Consolas, Menlo, monospace; font-size: 12.5px; line-height: 1.7; color: var(--c-text, #2c2c2a); background: var(--c-surface, #fff); }
.tpl-ta::placeholder { color: var(--c-text-muted, #b4b2a9); }
.tpl-ta-foot { display: flex; align-items: center; justify-content: space-between; padding: 7px 12px; border-top: 1px solid var(--c-border, #e5e3dc); background: var(--c-surface-3, #fafaf7); }
.tpl-ok { font-size: 11px; color: var(--c-success, #0f6e56); }
.tpl-bad { font-size: 11px; color: var(--c-danger, #a32d2d); }
.tpl-hint { font-size: 11px; color: var(--c-text-muted, #888780); }
.tpl-vars { width: 212px; flex: none; overflow-y: auto; max-height: 240px; background: var(--c-surface, #fff); }
.tpl-var-title { font-size: 11px; font-weight: 500; color: var(--c-text-muted, #888780); padding: 10px 12px 4px; letter-spacing: 0.3px; }
.tpl-vitem { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 12px; cursor: pointer; border-left: 2px solid transparent; }
.tpl-vitem:hover { background: var(--c-surface-3, #f1efe8); }
.tpl-vitem.flash { background: var(--c-primary-soft, #eeedfe); border-left-color: var(--c-primary, #534ab7); }
.tpl-vl { font-size: 12px; color: var(--c-text, #2c2c2a); }
.tpl-vk { font-family: "SF Mono", Consolas, monospace; font-size: 10.5px; color: var(--c-text-muted, #888780); background: var(--c-surface-3, #f1efe8); padding: 1px 5px; border-radius: 4px; }
.tpl-vitem:hover .tpl-vk { background: var(--c-surface, #fff); color: var(--c-primary, #534ab7); }
.tpl-prev { margin-top: 8px; border: 1px dashed var(--c-border, #d3d1c7); border-radius: 8px; padding: 8px 12px; background: var(--c-surface-3, #fafaf7); }
.tpl-prev-label { font-size: 11px; color: var(--c-text-muted, #888780); }
.tpl-prev-text { margin: 4px 0 0; font-family: "SF Mono", Consolas, monospace; font-size: 12px; color: var(--c-text, #2c2c2a); line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow-y: auto; }
@media (max-width: 720px) {
  .tpl-editor-main { flex-direction: column; }
  .tpl-ta-wrap { border-right: 0; border-bottom: 1px solid var(--c-border, #e5e3dc); }
  .tpl-vars { width: 100%; max-height: 160px; }
}
</style>
