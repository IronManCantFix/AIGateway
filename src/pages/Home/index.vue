<script setup>
import { ref, onMounted, onUnmounted, computed, inject, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '../../api.js'
import { listen } from '@tauri-apps/api/event'
import iconUrl from '../../assets/icon.png'

const { t } = useI18n()
const navigate = inject('navigate')

const proxyStatus = ref('stopped')
const proxyPort = ref(9999)
const profiles = ref([])
const activeProfileIds = ref([])
const toast = ref('')
const modelMappings = ref({ enabled: false, rules: [] })
const confirmState = ref({ visible: false, message: '', resolve: null })
let statusUnlisten = null
let toastUnlisten = null
let refreshUnlisten = null
let mappingSaveTimer = 0

const proxyUrl = computed(() => `http://127.0.0.1:${proxyPort.value}`)

function maskApiKey(key) {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '***' + key.slice(-4)
}

function isActive(id) {
  return activeProfileIds.value.includes(id)
}

async function loadData() {
  profiles.value = await api.getProfiles()
  activeProfileIds.value = await api.getActiveProfiles()
  const status = await api.getProxyStatus()
  proxyStatus.value = status.status
  proxyPort.value = status.port
  modelMappings.value = await api.getModelMappings()
}

const aggregatedModels = computed(() => {
  const activeSet = new Set(activeProfileIds.value)
  const activeProfiles = profiles.value.filter(p => activeSet.has(p.id))
  const modelProviders = {}
  for (const p of activeProfiles) {
    if (Array.isArray(p.models)) {
      for (const m of p.models) {
        if (!modelProviders[m]) modelProviders[m] = []
        modelProviders[m].push(p.name)
      }
    }
  }
  const result = []
  const seen = new Set()
  for (const p of activeProfiles) {
    if (Array.isArray(p.models)) {
      for (const m of p.models) {
        if (!seen.has(m)) {
          seen.add(m)
          result.push({ model: m, providers: modelProviders[m] })
        }
      }
    }
  }
  return result
})

async function toggleProxy() {
  if (proxyStatus.value === 'running' || proxyStatus.value === 'starting') {
    await api.stopProxy()
  } else {
    try { await api.startProxy() } catch (e) {
      const msg = typeof e === 'string' ? e : (e?.message || JSON.stringify(e))
      showToast(t('home.toast.startFailed', { msg }))
      return
    }
  }
  await loadData()
}

async function toggleProfile(id) {
  const enabled = !isActive(id)
  await api.toggleProfile(id, enabled)
  await loadData()
}

function copyUrl() {
  api.copyText(proxyUrl.value)
  showToast(t('home.toast.urlCopied'))
}

async function copyModelId(id) {
  await api.copyText(id)
  showToast(t('home.toast.modelCopied', { id }))
}

async function copyProfile(p) {
  await api.addProfile({
    name: `${p.name} ${t('home.label.copySuffix')}`,
    providerType: p.providerType,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    defaultModel: p.defaultModel,
    models: p.models ? [...p.models] : []
  })
  await loadData()
  showToast(t('home.toast.profileCopied', { name: p.name }))
}

function showConfirm(message) {
  return new Promise(resolve => {
    confirmState.value = { visible: true, message, resolve }
  })
}
function confirmOk() { confirmState.value.resolve(true); confirmState.value.visible = false }
function confirmCancel() { confirmState.value.resolve(false); confirmState.value.visible = false }

async function confirmDelete(id) {
  if (!await showConfirm(t('home.confirm.deleteProfile'))) return
  await api.deleteProfile(id)
  await loadData()
}

function providerLabel(type) {
  const map = { 'openai-chat': 'OpenAI Chat', 'openai-response': 'OpenAI Response', 'anthropic-message': 'Anthropic', 'openai-image': 'OpenAI Image', 'newapi': 'NEW API' }
  return map[type] || type
}

function providerColor(type) {
  const map = { 'openai-chat': '#10b981', 'openai-response': '#f59e0b', 'anthropic-message': '#8b5cf6', 'openai-image': '#ec4899', 'newapi': '#06b6d4' }
  return map[type] || '#6b7280'
}

function modelCountText(p) {
  const count = (p.models && p.models.length) || 0
  if (count === 0) return t('home.label.noModels')
  return t('home.label.modelCount', { count })
}

// --- Drag & drop reorder (mouse events) ---
const dragIndex = ref(null)
let dragStartY = 0
let dragStarted = false
let containerTop = 0
let rowHeight = 0
let ghostEl = null
let ghostOffsetY = 0
const DRAG_THRESHOLD = 5

function onHandleMouseDown(e, index) {
  e.preventDefault()
  dragStartY = e.clientY
  dragStarted = false
  const rowEl = e.target.closest('.provider-row')
  const onMouseMove = (ev) => {
    if (!dragStarted && Math.abs(ev.clientY - dragStartY) < DRAG_THRESHOLD) return
    if (!dragStarted) {
      dragStarted = true
      dragIndex.value = index
      document.body.style.userSelect = 'none'
      const rows = document.querySelectorAll('.provider-row')
      if (rows.length > 0) {
        const firstRect = rows[0].getBoundingClientRect()
        containerTop = firstRect.top
        rowHeight = firstRect.height + 4
      }
      const rect = rowEl.getBoundingClientRect()
      ghostOffsetY = ev.clientY - rect.top
      ghostEl = document.createElement('div')
      const isDark = document.documentElement.dataset.theme === 'dark'
      ghostEl.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:9999;pointer-events:none;opacity:0.85;box-shadow:0 8px 24px rgba(0,0,0,.15);border-radius:12px;background:${isDark ? 'rgba(22,31,56,.9)' : 'rgba(255,255,255,.9)'};backdrop-filter:blur(16px);border:2px solid rgba(99,102,241,.3);display:flex;align-items:center;padding:12px;font-size:14px;font-weight:600;color:${isDark ? '#e8ecf4' : '#0f172a'};`
      ghostEl.textContent = rowEl.querySelector('.pr-name')?.textContent || ''
      document.body.appendChild(ghostEl)
    }
    if (ghostEl) {
      ghostEl.style.top = (ev.clientY - ghostOffsetY) + 'px'
    }
    const count = profiles.value.length
    let targetIdx = Math.round((ev.clientY - containerTop) / rowHeight)
    targetIdx = Math.max(0, Math.min(targetIdx, count - 1))
    if (targetIdx !== dragIndex.value) {
      const fromIdx = dragIndex.value
      const arr = [...profiles.value]
      const [moved] = arr.splice(fromIdx, 1)
      arr.splice(targetIdx, 0, moved)
      profiles.value = arr
      dragIndex.value = targetIdx
    }
  }
  const onMouseUp = async () => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.userSelect = ''
    if (ghostEl) { ghostEl.remove(); ghostEl = null }
    dragIndex.value = null
    if (!dragStarted) return
    try {
      await api.reorderProfiles(profiles.value.map(p => p.id))
    } catch (err) {
      const msg = typeof err === 'string' ? err : (err?.message || '')
      showToast(t('home.toast.reorderFailed', { msg }))
      await loadData()
    }
  }
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

let toastTimer = 0
function showToast(msg) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 3500)
}

// --- Model Mappings ---
async function toggleModelMappings() {
  modelMappings.value = { ...modelMappings.value, enabled: !modelMappings.value.enabled }
  await api.setModelMappings(modelMappings.value)
}

async function addMappingRule() {
  modelMappings.value = {
    ...modelMappings.value,
    rules: [...modelMappings.value.rules, { from: '', to: '' }]
  }
  await api.setModelMappings(modelMappings.value)
}

async function removeMappingRule(index) {
  const rules = [...modelMappings.value.rules]
  rules.splice(index, 1)
  modelMappings.value = { ...modelMappings.value, rules }
  await api.setModelMappings(modelMappings.value)
}

async function updateMappingRule(index, field, value) {
  const rules = [...modelMappings.value.rules]
  rules[index] = { ...rules[index], [field]: value }
  modelMappings.value = { ...modelMappings.value, rules }
  scheduleMappingSave()
}

function scheduleMappingSave() {
  clearTimeout(mappingSaveTimer)
  mappingSaveTimer = setTimeout(async () => {
    try {
      await api.setModelMappings(modelMappings.value)
    } catch (err) {
      const msg = typeof err === 'string' ? err : (err?.message || '')
      showToast(t('home.toast.mappingsSaveFailed', { msg }))
      await loadData()
    }
  }, 400)
}

async function addQuickMappings(fromModels) {
  const existing = new Set(modelMappings.value.rules.map(r => r.from))
  const newRules = fromModels.filter(m => !existing.has(m)).map(m => ({ from: m, to: '' }))
  if (newRules.length === 0) {
    showToast('All mappings already exist')
    return
  }
  modelMappings.value = {
    ...modelMappings.value,
    enabled: true,
    rules: [...modelMappings.value.rules, ...newRules]
  }
  await api.setModelMappings(modelMappings.value)
  showToast(`Added ${newRules.length} mapping(s)`)
}

onMounted(async () => {
  await loadData()
  statusUnlisten = await api.onStatusChange((payload) => {
    proxyStatus.value = payload.status
    if (payload.error === 'EADDRINUSE') {
      // 优先从消息中提取 :PORT 模式，兜底用配置端口
      const portFromMsg = payload.message?.match(/:(\d{2,5})\b/)?.[1]
      const port = portFromMsg || proxyPort.value
      showToast(t('home.toast.portInUse', { port }))
    } else if (payload.crashed) {
      showToast(t('home.toast.proxyCrashed'))
    }
  })
  // Listen for toast messages from tray menu
  toastUnlisten = await listen('show-toast', (event) => {
    showToast(event.payload)
  })
  // Listen for data refresh from tray menu
  refreshUnlisten = await listen('refresh-data', () => {
    loadData()
  })
})

onUnmounted(() => {
  clearTimeout(mappingSaveTimer)
  statusUnlisten?.()
  toastUnlisten?.()
  refreshUnlisten?.()
})
</script>

<template>
  <div class="home">
    <!-- Toast -->
    <Transition name="fade">
      <div class="toast" v-if="toast">{{ toast }}</div>
    </Transition>

    <!-- Header Card -->
    <div class="header-card" :class="{ running: proxyStatus === 'running', starting: proxyStatus === 'starting' || proxyStatus === 'stopping' }">
      <div class="hc-left">
        <img :src="iconUrl" class="hc-logo" alt="AIGateway" />
        <span class="status-dot"></span>
        <div class="hc-info">
          <span class="hc-label">{{ proxyStatus === 'running' ? $t('home.status.running') : proxyStatus === 'starting' ? $t('home.status.starting') : proxyStatus === 'stopping' ? $t('home.status.stopping') : $t('home.status.stopped') }}</span>
          <span class="hc-addr" @click="copyUrl" :title="$t('home.label.clickToCopy')">{{ proxyUrl }}</span>
        </div>
      </div>
      <div class="hc-right">
        <button class="hc-btn-toggle" :disabled="proxyStatus === 'starting' || proxyStatus === 'stopping'" @click="toggleProxy">
          {{ proxyStatus === 'running' || proxyStatus === 'stopping' ? $t('home.button.stop') : $t('home.button.start') }}
        </button>
        <button class="hc-btn-copy" @click="copyUrl" :title="$t('home.label.copyAddress')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="hc-btn-settings" @click="navigate('gw-set')" :title="$t('home.label.settings')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
    </div>

    <!-- 提供商 -->
    <div class="card">
      <div class="card-header">
        <h3>{{ $t('home.section.providers') }}
          <span class="tip-icon">
            ?
            <span class="tip-pop">{{ $t('home.tip.providers') }}</span>
          </span>
        </h3>
        <button class="link-btn" @click="navigate('gw-add')">{{ $t('home.button.add') }}</button>
      </div>
      <div class="card-body" v-if="profiles.length > 0">
        <div class="provider-list" :class="{ scrollable: profiles.length > 5 }">
        <div
          v-for="(p, index) in profiles"
          :key="p.id"
          class="provider-row"
          :class="{ active: isActive(p.id), dragging: dragIndex === index }"
        >
          <div class="pr-drag-handle" :title="$t('home.label.dragToReorder')" @mousedown="onHandleMouseDown($event, index)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
          </div>
          <div class="pr-left" @click="toggleProfile(p.id)">
            <span class="pr-checkbox" :class="{ on: isActive(p.id) }">
              <svg v-if="isActive(p.id)" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg>
            </span>
            <div class="pr-info">
              <span class="pr-name">{{ p.name }}</span>
              <span class="pr-meta">
                <span class="pr-tag" :style="{ background: providerColor(p.providerType) + '18', color: providerColor(p.providerType) }">
                  {{ providerLabel(p.providerType) }}
                </span>
                <span class="pr-key">{{ maskApiKey(p.apiKey) }}</span>
                <span class="pr-models-count">{{ modelCountText(p) }}</span>
              </span>
            </div>
          </div>
          <div class="pr-actions">
            <button class="act-btn" @click="copyProfile(p)">{{ $t('common.copy') }}</button>
            <button class="act-btn" @click="navigate('gw-add', { editId: p.id })">{{ $t('home.button.edit') }}</button>
            <button class="act-btn danger" @click="confirmDelete(p.id)">{{ $t('common.delete') }}</button>
          </div>
        </div>
        </div>
      </div>
      <div class="card-empty" v-else>
        {{ $t('home.empty.providers') }}
      </div>
    </div>

    <!-- 可用模型（聚合自已启用提供商） -->
    <div class="card">
      <div class="card-header">
        <h3>{{ $t('home.section.models') }}
          <span class="tip-icon">
            ?
            <span class="tip-pop" v-html="$t('home.tip.models')"></span>
          </span>
        </h3>
      </div>
      <div class="card-body">
        <div class="model-list" v-if="aggregatedModels.length > 0">
          <div v-for="item in aggregatedModels" :key="item.model" class="model-row">
            <span class="model-id">{{ item.model }}</span>
            <div class="model-providers">
              <span v-for="pv in item.providers" :key="pv" class="provider-tag">{{ pv }}</span>
            </div>
            <button class="model-copy-btn" @click.stop="copyModelId(item.model)" :title="$t('home.label.copyModelId')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
        </div>
        <div class="card-empty" v-else style="padding: 16px 0;">{{ $t('home.empty.models') }}</div>
      </div>
    </div>

    <!-- 模型映射 -->
    <div class="card">
      <div class="card-header">
        <h3>{{ $t('home.section.mappings') }}
          <span class="tip-icon">
            ?
            <span class="tip-pop">{{ $t('home.tip.mappings') }}</span>
          </span>
        </h3>
        <button class="toggle-btn" :class="{ on: modelMappings.enabled }" @click="toggleModelMappings">
          {{ modelMappings.enabled ? $t('home.button.enabled') : $t('home.button.disabled') }}
        </button>
      </div>
      <div class="card-body">
        <div class="mapping-rules" v-if="modelMappings.rules.length > 0">
          <div class="mapping-header">
            <span class="mapping-col-from">{{ $t('home.label.requestModel') }}</span>
            <span class="mapping-arrow"></span>
            <span class="mapping-col-to">{{ $t('home.label.actualModel') }}</span>
            <span class="mapping-col-action"></span>
          </div>
          <div v-for="(rule, index) in modelMappings.rules" :key="index" class="mapping-row">
            <input
              class="mapping-input"
              :value="rule.from"
              @input="updateMappingRule(index, 'from', $event.target.value)"
              :placeholder="$t('home.label.fromPlaceholder')"
              :disabled="!modelMappings.enabled"
            />
            <span class="mapping-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </span>
            <select
              class="mapping-select"
              :value="rule.to"
              @change="updateMappingRule(index, 'to', $event.target.value)"
              :disabled="!modelMappings.enabled"
            >
              <option value="" disabled>{{ $t('home.label.selectActualModel') }}</option>
              <option v-for="item in aggregatedModels" :key="item.model" :value="item.model">{{ item.model }}</option>
            </select>
            <button class="mapping-remove" @click="removeMappingRule(index)" :disabled="!modelMappings.enabled">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="card-empty" v-else-if="!modelMappings.enabled" style="padding: 16px 0;">{{ $t('home.empty.mappingsDisabled') }}</div>
        <div class="card-empty" v-else style="padding: 16px 0;">{{ $t('home.empty.mappingsRules') }}</div>
        <button class="add-rule-btn" v-if="modelMappings.enabled" @click="addMappingRule">{{ $t('home.button.addMapping') }}</button>
        <div class="quick-mappings" v-if="modelMappings.enabled">
          <span class="quick-label">Quick:</span>
          <button class="quick-btn" @click="addQuickMappings(['GPT-5.5', 'GPT-5.4', 'GPT-5.3', 'GPT-5.4-Mini'])">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            codex
          </button>
          <button class="quick-btn" @click="addQuickMappings(['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'])">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            claudecode
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 确认弹窗 -->
  <Teleport to="body">
    <div class="confirm-overlay" v-if="confirmState.visible" @click.self="confirmCancel">
      <div class="confirm-dialog">
        <p class="confirm-msg">{{ confirmState.message }}</p>
        <div class="confirm-actions">
          <button class="confirm-cancel" @click="confirmCancel">{{ $t('common.cancel') }}</button>
          <button class="confirm-ok" @click="confirmOk">{{ $t('common.ok') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ===== Page ===== */
.home {
  padding: 16px;
  max-width: 780px;
  margin: 0 auto;
  min-height: 100vh;
  position: relative;
}

/* ===== Toast ===== */
.toast {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 24px;
  background: var(--bg-elevated);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  white-space: pre-line;
  text-align: center;
  max-width: 380px;
  z-index: 999;
  box-shadow: var(--shadow-md);
  pointer-events: none;
}
.fade-enter-active { transition: all .25s cubic-bezier(.4,0,.2,1); }
.fade-leave-active { transition: all .2s cubic-bezier(.4,0,.2,1); }
.fade-enter-from,
.fade-leave-to { opacity: 0; transform: translateX(-50%) translateY(-8px); }

/* ===== Header Card ===== */
.header-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  margin-bottom: 16px;
  background: var(--bg-card);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  gap: 12px;
  position: relative;
  overflow: hidden;
}
.header-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--glass-shine);
  pointer-events: none;
}
.header-card.running {
  border-color: rgba(52, 211, 153, 0.2);
  background: rgba(52, 211, 153, 0.06);
}
.header-card.starting {
  border-color: rgba(251, 191, 36, 0.2);
  background: rgba(251, 191, 36, 0.06);
}

.hc-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
  position: relative;
  z-index: 1;
}
.hc-logo { width: 28px; height: 28px; flex-shrink: 0; border-radius: 6px; }

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-muted);
  transition: all .3s;
}
.running .status-dot {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}
.starting .status-dot {
  background: var(--warning);
  box-shadow: 0 0 0 3px var(--warning-soft);
  animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.hc-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.hc-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
.running .hc-label { color: var(--success); }
.starting .hc-label { color: var(--warning); }

.hc-addr {
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 11.5px;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color .15s;
  user-select: all;
}
.hc-addr:hover { color: var(--text-secondary); }

.hc-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  position: relative;
  z-index: 1;
}

.hc-btn-toggle {
  padding: 6px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all .2s cubic-bezier(.4,0,.2,1);
  background: var(--accent);
  color: #fff;
}
.hc-btn-toggle:hover { background: var(--accent-hover); box-shadow: var(--shadow-glow); }
.hc-btn-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.running .hc-btn-toggle {
  background: var(--danger-soft);
  color: var(--danger);
  border: 1px solid var(--danger-soft);
}
.running .hc-btn-toggle:hover {
  background: var(--danger-soft);
}

.hc-btn-copy,
.hc-btn-settings {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all .15s;
}
.hc-btn-copy:hover,
.hc-btn-settings:hover {
  background: var(--accent-soft);
  color: var(--text-accent);
}

/* ===== Card ===== */
.card {
  margin-bottom: 16px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  position: relative;
  overflow: hidden;
}
.card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--glass-shine);
  pointer-events: none;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px 0;
  position: relative;
  z-index: 1;
}

.card-header h3 {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: .8px;
}

.card-body {
  padding: 12px 16px 16px;
  position: relative;
  z-index: 1;
}

.card-empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.link-btn {
  padding: 0;
  border: none;
  background: transparent;
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  cursor: pointer;
  transition: color .15s;
}
.link-btn:hover { color: var(--accent-hover); }
.link-btn.danger { color: var(--danger); }
.link-btn.danger:hover { color: #fca5a5; }

/* ===== Provider List ===== */
.provider-list.scrollable {
  max-height: 300px;
  overflow-y: auto;
  padding-right: 2px;
}

/* ===== Provider Row ===== */
.provider-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border-radius: var(--radius-md);
  transition: background .2s, border-color .2s;
  border: 2px solid transparent;
  position: relative;
}
.provider-row + .provider-row { margin-top: 4px; }
.provider-row:hover { background: var(--accent-soft); }
.provider-row.active {
  background: var(--accent-soft);
  border-color: var(--glass-border-hover);
}
.provider-row.dragging { opacity: 0.4; }
.provider-row.drag-over-top { border-top-color: var(--accent); }
.provider-row.drag-over-bottom { border-bottom-color: var(--accent); }

.pr-drag-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  flex-shrink: 0;
  color: var(--text-muted);
  cursor: grab;
  margin-right: 4px;
  transition: color .15s;
}
.pr-drag-handle:hover { color: var(--text-secondary); }
.pr-drag-handle:active { cursor: grabbing; }

.pr-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.pr-checkbox {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 2px solid var(--text-muted);
  flex-shrink: 0;
  transition: all .2s;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pr-checkbox.on {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 8px var(--accent-glow);
}

.pr-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.pr-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pr-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pr-tag {
  font-size: 10.5px;
  padding: 1.5px 7px;
  border-radius: 5px;
  font-weight: 600;
  letter-spacing: .2px;
}

.pr-key {
  font-size: 11px;
  color: var(--text-muted);
  font-family: 'SF Mono', monospace;
}

.pr-models-count {
  font-size: 10.5px;
  color: var(--text-muted);
  font-weight: 500;
}

.pr-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  margin-left: 10px;
}

.act-btn {
  padding: 4px 9px;
  border: none;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all .15s;
  background: var(--accent-soft);
  color: var(--text-secondary);
}
.act-btn:hover { background: var(--accent-soft); color: var(--text-primary); }
.act-btn.danger { color: var(--danger); }
.act-btn.danger:hover { background: var(--danger-soft); }

/* ===== Model Section ===== */
.model-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 380px;
  overflow-y: auto;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  border: 1px solid var(--glass-border);
  transition: background .15s, border-color .15s;
}
.model-row:hover {
  background: var(--accent-soft);
  border-color: var(--glass-border-hover);
}

.model-copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: all .15s;
}
.model-copy-btn:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.model-id {
  font-size: 12.5px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--text-secondary);
  flex-shrink: 0;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-providers {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-left: auto;
}

.provider-tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 500;
  white-space: nowrap;
}

/* ===== Tip Icon ===== */
.tip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 1px solid var(--text-muted);
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  cursor: help;
  vertical-align: middle;
  text-transform: none;
  letter-spacing: 0;
  position: relative;
  transition: all .15s;
}
.tip-icon:hover { border-color: var(--accent); color: var(--accent); }

.tip-pop {
  display: none;
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
  width: 240px;
  padding: 10px 13px;
  background: var(--bg-card);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.6;
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  white-space: normal;
  z-index: 100;
  pointer-events: none;
  text-transform: none;
  letter-spacing: 0;
  box-shadow: var(--shadow-md);
}
.tip-pop::after {
  content: '';
  position: absolute;
  right: 100%;
  top: 50%;
  margin-top: -5px;
  border: 5px solid transparent;
  border-right-color: var(--bg-card);
}
.tip-pop code {
  font-family: monospace;
  background: var(--accent-soft);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--accent-hover);
}
.tip-icon:hover .tip-pop { display: block; }

/* ===== Toggle Button ===== */
.toggle-btn {
  padding: 4px 12px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all .2s;
  background: var(--accent-soft);
  color: var(--text-muted);
}
.toggle-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.toggle-btn:hover { opacity: .85; }

/* ===== Mapping Rules ===== */
.mapping-rules {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mapping-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
}

.mapping-header span {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: .4px;
}

.mapping-col-from { flex: 1; }
.mapping-col-to { flex: 1; }
.mapping-col-action { width: 28px; flex-shrink: 0; }

.mapping-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mapping-input {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--text-primary);
  background: var(--bg-input);
  outline: none;
  transition: all .2s;
}
.mapping-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-glow);
}
.mapping-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mapping-select {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--text-primary);
  background: var(--bg-input);
  outline: none;
  transition: all .2s;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%238b95b0' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 28px;
}
.mapping-select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-glow);
}
.mapping-select:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mapping-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  flex-shrink: 0;
  color: var(--text-muted);
}

.mapping-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all .15s;
  flex-shrink: 0;
}
.mapping-remove:hover:not(:disabled) {
  background: var(--danger-soft);
  color: var(--danger);
}
.mapping-remove:disabled {
  opacity: .3;
  cursor: not-allowed;
}

.add-rule-btn {
  width: 100%;
  padding: 8px;
  margin-top: 8px;
  border: 1px dashed rgba(99, 102, 241, 0.2);
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--accent);
  cursor: pointer;
  transition: all .15s;
}
.add-rule-btn:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.quick-mappings {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.quick-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
}

.quick-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  background: transparent;
  font-size: 11px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all .15s;
}
.quick-btn:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

/* Confirm dialog */
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: var(--bg-overlay);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.confirm-dialog {
  background: var(--bg-card);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  padding: 28px 32px 20px;
  min-width: 320px;
  max-width: 420px;
  box-shadow: var(--shadow-lg);
  position: relative;
  overflow: hidden;
}
.confirm-dialog::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--glass-shine);
  pointer-events: none;
}
.confirm-msg { font-size: 15px; color: var(--text-primary); line-height: 1.6; margin: 0 0 24px; position: relative; z-index: 1; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; position: relative; z-index: 1; }
.confirm-cancel {
  padding: 8px 20px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all .15s;
}
.confirm-cancel:hover { background: var(--accent-soft); border-color: var(--glass-border-hover); }
.confirm-ok {
  padding: 8px 20px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--danger);
  font-size: 14px;
  color: #fff;
  font-weight: 500;
  cursor: pointer;
  transition: all .15s;
}
.confirm-ok:hover { background: #ef4444; box-shadow: 0 0 12px rgba(248, 113, 113, 0.3); }
</style>
