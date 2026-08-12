<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '../../api.js'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'

const { t } = useI18n()

const settings = ref(null)
const status = ref(null)
const stats = ref(null)
const logs = ref([])
const busy = ref(false)
const toast = ref('')
let toastTimer = 0
let unlisteners = []

const isRunning = computed(() => status.value?.status === 'running')

const statusText = computed(() => {
  const s = status.value?.status
  if (s === 'running') return t('home.status.running')
  if (s === 'starting') return t('home.status.starting')
  if (s === 'stopping') return t('home.status.stopping')
  return t('home.status.stopped')
})

const addr = computed(() => {
  const port = status.value?.port ?? settings.value?.port
  return `http://127.0.0.1:${port ?? 9999}`
})

const httpProxyEnabled = computed(() => !!settings.value?.httpProxy?.enabled)

const todayCount = computed(() => stats.value?.today?.count ?? 0)
const todayTokens = computed(() => stats.value?.today?.tokens ?? 0)
const speedStats = computed(() => stats.value?.today?.speed ?? null)

function fmtTokens(n) {
  if (n == null) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K'
  return String(n)
}

function fmtSpeed(n) {
  if (n == null || !isFinite(n)) return '—'
  const v = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10
  return `${v} tok/s`
}

function fmtRelative(ts) {
  const diff = Math.max(0, Date.now() - ts)
  const min = 60_000
  const hour = 3_600_000
  const day = 86_400_000
  if (diff < min) return t('panel.relative.justNow')
  if (diff < hour) return t('panel.relative.minutesAgo', { n: Math.floor(diff / min) })
  if (diff < day) return t('panel.relative.hoursAgo', { n: Math.floor(diff / hour) })
  return t('panel.relative.daysAgo', { n: Math.floor(diff / day) })
}

// 网关本地处理、不转发上游的接口不计入调用统计
function isRelayEndpoint(endpoint) {
  const path = (endpoint || '').split('?')[0]
  return path !== '/v1/models' && !path.includes('count_tokens')
}

const recentModels = computed(() => {
  const seen = new Set()
  const out = []
  for (const e of logs.value) {
    if (e.statusCode !== 200 || !isRelayEndpoint(e.endpoint)) continue
    const m = e.model
    if (!m || m === '-' || seen.has(m)) continue
    seen.add(m)
    out.push({ model: m, provider: e.provider || '-', time: e.timestamp })
    if (out.length >= 3) break
  }
  return out
})

function showToast(msg) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 2500)
}

function onVisibility() {
  if (document.visibilityState === 'visible') {
    loadAll()
      .then(() => fitWindow())
      .catch((e) => {
        showToast(typeof e === 'string' ? e : (e?.message || JSON.stringify(e)))
      })
  }
}

// 测量实际内容高度，精确设置窗口大小，最大440px
const MAX_HEIGHT = 520
async function fitWindow() {
  await nextTick()
  try {
    const el = document.querySelector('.panel')
    if (!el) return
    const natural = Math.ceil(el.scrollHeight) + 82 // border 1px * 2 + 80px padding
    const h = Math.min(natural, MAX_HEIGHT)
    await getCurrentWindow().setSize(new LogicalSize(360, h))
  } catch (e) {
    /* ignore */
  }
}

async function loadAll() {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const [s, st, agg, lg] = await Promise.all([
    api.getSettings(),
    api.getProxyStatus(),
    api.getStats(),
    api.getLogs(500, 0, { dateFrom: todayStart.getTime(), statusClass: '2xx' })
  ])
  settings.value = s
  status.value = st
  stats.value = agg
  logs.value = lg.logs || []
}

async function toggleProxy() {
  if (busy.value) return
  busy.value = true
  try {
    if (isRunning.value) {
      status.value = { ...status.value, status: 'stopping' }
      await api.stopProxy()
    } else {
      status.value = { ...status.value, status: 'starting' }
      status.value = await api.startProxy()
    }
  } catch (e) {
    showToast(typeof e === 'string' ? e : (e?.message || JSON.stringify(e)))
  } finally {
    busy.value = false
  }
}

async function toggleHttpProxy() {
  const next = { ...settings.value }
  const cur = next.httpProxy || { enabled: false, url: '', username: null, password: null, excludeProfiles: [] }
  next.httpProxy = { ...cur, enabled: !cur.enabled }
  try {
    settings.value = await api.setSettings(next)
  } catch (e) {
    showToast(typeof e === 'string' ? e : (e?.message || JSON.stringify(e)))
  }
}

async function copyModel(model) {
  try {
    await api.copyText(model)
    showToast(t('panel.copied', { model }))
  } catch (e) {
    /* ignore clipboard errors */
  }
}

async function copyAddr() {
  try {
    await api.copyText(addr.value)
    showToast(t('home.toast.urlCopied'))
  } catch (e) {
    /* ignore clipboard errors */
  }
}

async function openMain() {
  try { await api.showMainWindow() } catch (e) { /* ignore */ }
}

async function quit() {
  try { await api.quitApp() } catch (e) { /* ignore */ }
}

onMounted(async () => {
  // 窗口重新可见时刷新数据（面板隐藏期间统计可能过期）
  document.addEventListener('visibilitychange', onVisibility)

  try {
    await loadAll()
  } catch (e) {
    showToast(typeof e === 'string' ? e : (e?.message || JSON.stringify(e)))
  }
  await fitWindow()
  unlisteners.push(await api.onStatusChange(async (payload) => {
    status.value = { ...(status.value || {}), ...payload }
  }))
  unlisteners.push(await api.onSettingsChange(async () => {
    settings.value = await api.getSettings()
  }))
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  clearTimeout(toastTimer)
  unlisteners.forEach((fn) => { try { fn() } catch (e) { /* ignore */ } })
})
</script>

<template>
  <div class="panel">
    <header class="panel-header" data-tauri-drag-region>
      <span class="status-dot" :class="{ running: isRunning }"></span>
      <span class="status-text">{{ statusText }}</span>
      <button class="addr" :title="$t('panel.copyAddrHint')" @click="copyAddr">{{ addr }}</button>
    </header>

    <section class="toggles">
      <div class="toggle-card">
        <div class="tc-info">
          <span class="tc-label">{{ $t('panel.proxy') }}</span>
          <span class="tc-sub">{{ isRunning ? $t('home.status.running') : $t('home.status.stopped') }}</span>
        </div>
        <button
          class="switch"
          :class="{ on: isRunning, disabled: busy }"
          role="switch"
          :aria-checked="isRunning"
          @click="toggleProxy"
        ><span class="knob"></span></button>
      </div>
      <div class="toggle-card">
        <div class="tc-info">
          <span class="tc-label">{{ $t('panel.httpProxy') }}</span>
          <span class="tc-sub">{{ httpProxyEnabled ? $t('panel.on') : $t('panel.off') }}</span>
        </div>
        <button
          class="switch"
          :class="{ on: httpProxyEnabled }"
          role="switch"
          :aria-checked="httpProxyEnabled"
          @click="toggleHttpProxy"
        ><span class="knob"></span></button>
      </div>
    </section>

    <section class="stats">
      <div class="stat-card">
        <div class="stat-num">{{ todayCount }}</div>
        <div class="stat-label">{{ $t('panel.todayCalls') }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-num tok">{{ fmtTokens(todayTokens) }}</div>
        <div class="stat-label">{{ $t('panel.todayTokens') }}</div>
      </div>
    </section>

    <section class="speed-stats">
      <div class="stat-card">
        <div class="stat-num speed">{{ fmtSpeed(speedStats?.max) }}</div>
        <div class="stat-label">{{ $t('panel.speedMax') }}</div>
        <div class="stat-sub" v-if="speedStats?.maxProvider">{{ speedStats.maxProvider }} · {{ speedStats.maxModel }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-num speed">{{ fmtSpeed(speedStats?.min) }}</div>
        <div class="stat-label">{{ $t('panel.speedMin') }}</div>
        <div class="stat-sub" v-if="speedStats?.minProvider">{{ speedStats.minProvider }} · {{ speedStats.minModel }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-num speed">{{ fmtSpeed(speedStats?.avg) }}</div>
        <div class="stat-label">{{ $t('panel.speedAvg') }}</div>
      </div>
    </section>

    <section class="recent">
      <div class="recent-title">{{ $t('panel.recentModels') }}</div>
      <div class="recent-list" v-if="recentModels.length">
        <button
          v-for="(m, i) in recentModels"
          :key="m.model + '-' + i"
          class="recent-item"
          @click="copyModel(m.model)"
          :title="$t('panel.copyHint')"
        >
          <span class="rm-model">{{ m.model }}</span>
          <span class="rm-provider">{{ m.provider }}</span>
          <span class="rm-time">{{ fmtRelative(m.time) }}</span>
        </button>
      </div>
      <div class="recent-empty" v-else>{{ $t('panel.emptyModels') }}</div>
    </section>

    <footer class="panel-footer">
      <button class="foot-btn primary" @click="openMain">{{ $t('panel.openMain') }}</button>
      <button class="foot-btn danger" @click="quit">{{ $t('panel.quit') }}</button>
    </footer>

    <Transition name="panel-fade">
      <div class="panel-toast" v-if="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.panel {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 10px;
  max-height: 520px;
  border-radius: 14px;
  background: var(--bg-base);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  user-select: none;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px;
  margin-bottom: 10px;
}

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--danger);
  flex-shrink: 0;
}
.status-dot.running {
  background: var(--success);
}

.status-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.addr {
  margin-left: auto;
  font-size: 11px;
  font-family: 'SF Mono', Menlo, monospace;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: none;
  background: transparent;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all 0.15s;
  max-width: 55%;
}
.addr:hover {
  color: var(--text-accent);
  background: var(--accent-soft);
}

.toggles {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}

.toggle-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
}

.tc-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.tc-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.tc-sub {
  font-size: 11px;
  color: var(--text-muted);
}

.switch {
  position: relative;
  width: 42px;
  height: 24px;
  border: none;
  border-radius: 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.18s, border-color 0.18s;
  flex-shrink: 0;
}
.switch.on {
  background: var(--accent);
  border-color: var(--accent);
}
.switch.disabled {
  opacity: 0.6;
  cursor: progress;
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--shadow-sm);
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}
.switch.on .knob {
  transform: translateX(18px);
}

.stats {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.speed-stats {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.stat-card {
  flex: 1;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-num {
  font-size: 20px;
  font-weight: 700;
  color: var(--accent);
  font-family: 'SF Mono', Menlo, monospace;
  line-height: 1.2;
}
.stat-num.tok {
  color: #f59e0b;
}

.stat-num.speed {
  font-size: 14px;
  color: var(--text-primary);
  white-space: nowrap;
}

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
}

.stat-sub {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.8;
}

.recent {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  padding: 10px 10px 8px;
  flex-shrink: 0;
  margin-bottom: 6px;
}

.recent-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 0 4px 8px;
}

.recent-list {
  display: flex;
  flex-direction: column;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 6px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s;
}
.recent-item:hover {
  background: var(--tab-hover-bg);
}
.recent-item + .recent-item {
  border-top: 1px solid var(--border-subtle);
}

.rm-model {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', Menlo, monospace;
}

.rm-provider {
  max-width: 90px;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rm-time {
  font-size: 10.5px;
  color: var(--text-muted);
  white-space: nowrap;
}

.recent-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  font-size: 12px;
  color: var(--text-muted);
}

.panel-footer {
  display: flex;
  gap: 8px;
  margin-top: auto;
}

.foot-btn {
  flex: 1;
  padding: 9px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.foot-btn:hover {
  background: var(--tab-hover-bg);
  border-color: var(--border-hover);
}
.foot-btn.primary {
  color: var(--text-accent);
  background: var(--accent-soft);
  border-color: transparent;
}
.foot-btn.primary:hover {
  background: var(--accent);
  color: #fff;
}
.foot-btn.danger {
  color: var(--danger);
  border-color: rgba(248, 113, 113, 0.25);
}
.foot-btn.danger:hover {
  background: var(--danger-soft);
}

.panel-toast {
  position: absolute;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  padding: 7px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: 12px;
  color: var(--text-primary);
  box-shadow: var(--shadow-md);
  white-space: nowrap;
  max-width: 90%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.panel-fade-enter-active,
.panel-fade-leave-active {
  transition: opacity 0.18s;
}
.panel-fade-enter-from,
.panel-fade-leave-to {
  opacity: 0;
}
</style>
<style>
/* 面板窗口：根元素透明，body 可滚动但隐藏滚动条 */
html,
body,
#app {
  background: transparent !important;
  min-height: 0 !important;
}

body {
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  clip-path: inset(0 round 14px);
}

body::-webkit-scrollbar {
  display: none;
}

</style>
