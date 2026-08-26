<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'

// 自定义下拉选择：替代原生 <select>。
// - 菜单 Teleport 到 body，不受父级 overflow 裁剪
// - 键盘完整可用：Enter/Space/↓ 打开，↑↓ 导航，Home/End 跳转，Enter 选择，Esc 关闭
// - 空间不足自动向上翻转，水平方向钳制在视口内
const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, required: true }, // [{ value, label }] 或纯字符串数组
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  mono: { type: Boolean, default: false }, // 等宽字体（模型 ID 等）
  minWidth: { type: Number, default: 160 }, // 菜单最小宽度，触发器更宽时跟随触发器
  maxHeight: { type: Number, default: 264 }
})

const emit = defineEmits(['update:modelValue', 'change'])

const open = ref(false)
const activeIndex = ref(-1)
const menuStyle = ref({})
const triggerEl = ref(null)
const menuEl = ref(null)

const opts = computed(() =>
  props.options.map(o => typeof o === 'string' ? { value: o, label: o } : o)
)

const selectedLabel = computed(() => {
  const found = opts.value.find(o => o.value === props.modelValue)
  return found ? found.label : ''
})
const hasValue = computed(() => selectedLabel.value !== '')

function select(opt) {
  emit('update:modelValue', opt.value)
  emit('change', opt.value)
  close()
}

function toggle() {
  if (props.disabled) return
  open.value ? close() : openMenu()
}

function openMenu() {
  open.value = true
  const idx = opts.value.findIndex(o => o.value === props.modelValue)
  activeIndex.value = idx >= 0 ? idx : 0
  nextTick(() => {
    position()
    scrollToActive()
  })
}

function close() {
  if (!open.value) return
  open.value = false
  triggerEl.value?.focus?.({ preventScroll: true })
}

function position() {
  const el = triggerEl.value
  const menu = menuEl.value
  if (!el || !menu) return
  const rect = el.getBoundingClientRect()
  const mw = Math.max(props.minWidth, rect.width)
  const mh = menu.offsetHeight || 200
  let x = rect.left
  x = Math.min(x, window.innerWidth - mw - 8)
  x = Math.max(8, x)
  let y = rect.bottom + 6
  // 下方放不下且上方足够时向上翻转
  if (y + mh > window.innerHeight - 8 && rect.top - mh - 6 > 8) {
    y = rect.top - mh - 6
  }
  menuStyle.value = { left: x + 'px', top: y + 'px', width: mw + 'px' }
}

function scrollToActive() {
  const menu = menuEl.value
  if (!menu) return
  const el = menu.querySelector(`[data-idx="${activeIndex.value}"]`)
  el?.scrollIntoView({ block: 'nearest' })
}

function move(delta) {
  if (!opts.value.length) return
  const n = opts.value.length
  let i = activeIndex.value + delta
  // 循环导航
  i = ((i % n) + n) % n
  activeIndex.value = i
  nextTick(scrollToActive)
}

function onTriggerKeydown(e) {
  if (props.disabled) return
  // 关闭状态：任意激活键打开
  if (!open.value) {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault()
      openMenu()
    }
    return
  }
  // 打开状态：导航/选择/关闭
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); move(1); break
    case 'ArrowUp': e.preventDefault(); move(-1); break
    case 'Home': e.preventDefault(); activeIndex.value = 0; nextTick(scrollToActive); break
    case 'End': e.preventDefault(); activeIndex.value = opts.value.length - 1; nextTick(scrollToActive); break
    case 'Enter':
    case ' ':
      e.preventDefault()
      if (activeIndex.value >= 0 && opts.value[activeIndex.value]) select(opts.value[activeIndex.value])
      break
    case 'Escape':
      e.preventDefault()
      close()
      break
    case 'Tab':
      close()
      break
  }
}

function onMenuKeydown(e) {
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); move(1); break
    case 'ArrowUp': e.preventDefault(); move(-1); break
    case 'Home': e.preventDefault(); activeIndex.value = 0; nextTick(scrollToActive); break
    case 'End': e.preventDefault(); activeIndex.value = opts.value.length - 1; nextTick(scrollToActive); break
    case 'Enter':
      e.preventDefault()
      if (activeIndex.value >= 0 && opts.value[activeIndex.value]) select(opts.value[activeIndex.value])
      break
    case 'Escape':
    case 'Tab':
      e.preventDefault()
      close()
      break
  }
}

let scrollTimer = 0
function onViewportChange() {
  if (!open.value) return
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(position, 40)
}

onMounted(() => {
  window.addEventListener('click', onGlobalClick, true)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', onGlobalClick, true)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
  clearTimeout(scrollTimer)
})

function onGlobalClick(e) {
  if (!open.value) return
  const t = e.target
  if (menuEl.value?.contains(t) || triggerEl.value?.contains(t)) return
  open.value = false
}
</script>

<template>
  <button
    ref="triggerEl"
    class="select-trigger"
    :class="{ mono, placeholder: !hasValue, disabled }"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :disabled="disabled"
    @click.stop="toggle"
    @keydown="onTriggerKeydown"
  >
    <span class="select-label" :title="selectedLabel">{{ selectedLabel || placeholder }}</span>
    <svg class="select-chevron" :class="{ up: open }" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
  </button>

  <Teleport to="body">
    <div v-if="open" ref="menuEl" class="select-menu" :class="{ 'is-mono': mono }" :style="{ ...menuStyle, maxHeight: maxHeight + 'px' }" role="listbox" tabindex="-1" @keydown="onMenuKeydown">
      <div
        v-for="(o, i) in opts"
        :key="o.value"
        class="select-option"
        :class="{ selected: o.value === modelValue, active: i === activeIndex }"
        :data-idx="i"
        role="option"
        :aria-selected="o.value === modelValue"
        :title="o.label"
        @mouseenter="activeIndex = i"
        @click.stop="select(o)"
      >
        <span class="select-option-label">{{ o.label }}</span>
        <svg v-if="o.value === modelValue" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      </div>
      <div v-if="opts.length === 0" class="select-empty">{{ placeholder || '-' }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.select-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 28px 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12.5px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  position: relative;
  transition: border-color .15s ease-out, background .15s ease-out;
}
.select-trigger.mono { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; }
.select-trigger:hover:not(:disabled) { border-color: var(--border-hover); }
.select-trigger.placeholder .select-label { color: var(--text-muted); }
.select-trigger.disabled,
.select-trigger:disabled {
  opacity: .4;
  cursor: not-allowed;
}

.select-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.select-chevron {
  position: absolute;
  right: 9px;
  top: 50%;
  margin-top: -5px;
  color: var(--text-muted);
  flex-shrink: 0;
  transition: transform .15s ease-out;
  pointer-events: none;
}
.select-chevron.up { transform: rotate(180deg); }
</style>

<style>
/* 非 scoped：Teleport 到 body 的菜单面板 */
.select-menu {
  position: fixed;
  z-index: var(--z-dropdown, 800);
  max-height: 264px;
  overflow-y: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.select-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background .1s ease-out, color .1s ease-out;
}
.select-menu.is-mono .select-option { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; }
.select-option.active { background: var(--accent-soft); color: var(--text-primary); }
.select-option.selected { color: var(--text-primary); font-weight: 600; }
.select-option.selected svg { color: var(--accent); flex-shrink: 0; }
.select-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.select-empty {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}
</style>
