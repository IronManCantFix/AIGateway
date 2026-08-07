<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '../../api.js'

const { t } = useI18n()

const logEnabled = ref(false)
const logs = ref([])
const logsLoading = ref(false)
const logsLoaded = ref(false)
const logFileSize = ref(0)
const logSearch = ref({ provider: '', model: '', statusCode: '', dateFrom: '', dateTo: '' })
const logPage = ref(1)
const logPageSize = ref(5)
const logTotal = ref(0)
const profiles = ref([])

const confirmState = ref({ visible: false, message: '', resolve: null })
function showConfirm(message) {
  return new Promise(resolve => {
    confirmState.value = { visible: true, message, resolve }
  })
}
function confirmOk() { confirmState.value.resolve(true); confirmState.value.visible = false }
function confirmCancel() { confirmState.value.resolve(false); confirmState.value.visible = false }

async function loadProfiles() {
  profiles.value = await api.getProfiles()
}

function buildLogFilter() {
  const s = logSearch.value
  const filter = {}
  if (s.provider) filter.provider = s.provider
  if (s.model) filter.model = s.model
  if (s.statusCode) filter.statusClass = s.statusCode
  // input[type=date] 的值是 YYYY-MM-DD，new Date(str) 会按 UTC 解析导致时区偏移，
  // 这里按本地时区解析成当天 00:00，dateTo 取次日 00:00 以包含所选整天
  if (s.dateFrom) filter.dateFrom = parseLocalDate(s.dateFrom).getTime()
  if (s.dateTo) {
    const d = parseLocalDate(s.dateTo)
    filter.dateTo = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  }
  return Object.keys(filter).length ? filter : null
}

function parseLocalDate(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

async function loadLogs() {
  logsLoading.value = true
  try {
    const limit = logPageSize.value
    const offset = (logPage.value - 1) * limit
    const [page, size] = await Promise.all([
      api.getLogs(limit, offset, buildLogFilter()),
      api.getLogFileSize()
    ])
    const list = page?.logs || []
    list.forEach((l, i) => { if (!l._id) l._id = l.timestamp + '_' + i })
    logs.value = list
    logTotal.value = page?.total || 0
    logFileSize.value = size || 0
    logsLoaded.value = true
  } finally {
    logsLoading.value = false
  }
}

async function clearLogs() {
  if (!await showConfirm(t('settings.confirm.clearLogs'))) return
  try {
    await api.clearLogs()
    logs.value = []
    logTotal.value = 0
    logPage.value = 1
    logsLoaded.value = false
    logFileSize.value = 0
  } catch (e) {
    console.error('Clear logs failed:', e)
  }
}

async function clearLogsBodyData() {
  if (!await showConfirm(t('settings.confirm.clearBodies'))) return
  try {
    await api.clearLogsBodies()
    await loadLogs()
  } catch (e) {
    console.error('Clear log bodies failed:', e)
  }
}

async function toggleLogging() {
  await api.setLogEnabled(logEnabled.value)
}

function statusLabel(c) {
  if (c >= 200 && c < 300) return 'success'
  if (c >= 400 && c < 500) return 'warn'
  return 'error'
}

function endpointLabel(ep) {
  const m = { '/v1/chat/completions':'Chat','/v1/responses':'Responses','/v1/messages':'Messages','/v1/models':'Models' }
  return m[ep] || ep
}

function shortUrl(url) {
  if (!url) return ''
  try {
    const u = new URL(url)
    return u.hostname + u.pathname
  } catch { return url }
}

function fmtTime(ts) {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const MM = String(d.getMonth() + 1).padStart(2, '0')
  const DD = String(d.getDate()).padStart(2, '0')
  return `${MM}-${DD} ${hh}:${mm}:${ss}`
}

function fmtTok(n) {
  if (n == null) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K'
  return String(n)
}

function fmtSize(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

let copyTimer = 0
const copyMsg = ref('')
async function copyText(text, label) {
  try {
    await api.copyText(text)
    copyMsg.value = t('common.copySuccess', { label })
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copyMsg.value = '' }, 1500)
  } catch (e) {
    console.error('Copy text failed:', e)
  }
}

const logTotalPages = computed(() => {
  const size = logPageSize.value || 5
  return Math.max(1, Math.ceil(logTotal.value / size))
})

const hasActiveLogFilter = computed(() => {
  const s = logSearch.value
  return !!(s.provider || s.model || s.statusCode || s.dateFrom || s.dateTo)
})

const logHasNextPage = computed(() => logPage.value < logTotalPages.value)

const logProviderOptions = computed(() => [...new Set(profiles.value.map(p => p.name).filter(Boolean))])
const logModelOptions = computed(() => {
  const selectedProvider = logSearch.value.provider
  const source = selectedProvider
    ? profiles.value.filter(p => p.name === selectedProvider)
    : profiles.value
  return [...new Set(source.flatMap(p => p.models || []).filter(Boolean))]
})

watch(() => logSearch.value.provider, () => {
  if (logSearch.value.model && !logModelOptions.value.includes(logSearch.value.model)) {
    logSearch.value.model = ''
  }
})

function resetLogPage() {
  logPage.value = 1
  loadLogs().catch(e => console.error('Load logs failed:', e))
}
function prevPage() {
  if (logPage.value > 1) {
    logPage.value -= 1
    loadLogs().catch(e => console.error('Load logs failed:', e))
  }
}
function nextPage() {
  if (logHasNextPage.value) {
    logPage.value += 1
    loadLogs().catch(e => console.error('Load logs failed:', e))
  }
}

onMounted(async () => {
  logEnabled.value = await api.getLogEnabled()
  loadProfiles().catch(e => console.error('Load profiles failed:', e))
  loadLogs().catch(e => console.error('Load logs failed:', e))
})
</script>

<template>
  <div class="logs-page">
    <Transition name="fade">
      <div class="copy-toast" v-if="copyMsg">{{ copyMsg }}</div>
    </Transition>
    <div class="page-header">
      <h2>{{ $t('nav.logs') }}</h2>
    </div>

    <!-- 日志开关 -->
    <div class="log-toggle-card">
      <label class="log-toggle-row" @change="toggleLogging">
        <div class="log-toggle-label">
          {{ $t('settings.label.logEnabled') }}
          <p class="log-toggle-hint">{{ $t('settings.label.logHint') }}</p>
        </div>
        <div class="log-toggle-control">
          <input type="checkbox" v-model="logEnabled" />
        </div>
      </label>
    </div>

    <div class="card">
      <div class="card-body" style="padding:0">
        <div class="log-toolbar" v-if="logs.length || hasActiveLogFilter">
          <div class="log-search-row">
            <select v-model="logSearch.provider" @change="resetLogPage" class="log-filter">
              <option value="">{{ $t('settings.placeholder.allProviders') }}</option>
              <option v-for="p in logProviderOptions" :key="p" :value="p">{{ p }}</option>
            </select>
            <select v-model="logSearch.model" @change="resetLogPage" class="log-filter">
              <option value="">{{ $t('settings.placeholder.allModels') }}</option>
              <option v-for="m in logModelOptions" :key="m" :value="m">{{ m }}</option>
            </select>
            <select v-model="logSearch.statusCode" @change="resetLogPage" class="log-filter">
              <option value="">{{ $t('settings.placeholder.allStatuses') }}</option>
              <option value="2xx">{{ $t('settings.label.status2xx') }}</option>
              <option value="4xx">{{ $t('settings.label.status4xx') }}</option>
              <option value="5xx">{{ $t('settings.label.status5xx') }}</option>
            </select>
            <input type="date" v-model="logSearch.dateFrom" @change="resetLogPage" class="log-filter" :placeholder="$t('settings.placeholder.dateFrom')" />
            <input type="date" v-model="logSearch.dateTo" @change="resetLogPage" class="log-filter" :placeholder="$t('settings.placeholder.dateTo')" />
          </div>
          <div class="log-toolbar-actions">
            <span class="log-size">{{ $t('settings.label.logFileSize', { size: fmtSize(logFileSize) }) }}</span>
            <div class="log-clear-btns">
              <button class="refresh-btn" @click="loadLogs()" :disabled="logsLoading">{{ logsLoading ? $t('common.loading') : $t('settings.button.refresh') }}</button>
              <button class="clear-body-btn" @click="clearLogs">{{ $t('settings.button.clearLogs') }}</button>
              <button class="clear-body-btn" @click="clearLogsBodyData">{{ $t('settings.button.clearBodies') }}</button>
            </div>
          </div>
        </div>

        <div class="log-list" v-if="logs.length">
          <div class="log-item" v-for="(l, idx) in logs" :key="l._id || idx">
            <div class="log-top">
              <span class="log-badge" :class="statusLabel(l.statusCode)">{{ l.statusCode }}</span>
              <span class="log-badge log-method" v-if="l.method">{{ l.method }}</span>
              <span class="log-badge log-proxy" v-if="l.proxy">PROXY</span>
              <span class="log-ep">{{ endpointLabel(l.endpoint) }}</span>
              <span class="log-upstream" v-if="l.upstreamUrl" :title="l.upstreamUrl">{{ shortUrl(l.upstreamUrl) }}</span>
              <span class="log-time">{{ fmtTime(l.timestamp) }}</span>
            </div>
            <div class="log-meta">
              <span>{{ l.provider || '-' }}</span>
              <span v-if="l.originalModel && l.originalModel !== l.model" class="log-mapping">{{ l.originalModel }} → {{ l.model }}</span>
              <span v-else>{{ l.model }}</span>
              <span class="log-dur">{{ l.duration }}ms</span>
              <span class="log-tokens" v-if="l.totalTokens">P {{ fmtTok(l.promptTokens) }} / C {{ fmtTok(l.completionTokens) }} / T {{ fmtTok(l.totalTokens) }}</span>
              <span class="log-body-size" v-if="l.bodySizeBefore">Body {{ fmtSize(l.bodySizeBefore) }} → {{ fmtSize(l.bodySizeAfter) }}</span>
            </div>
            <div class="log-err" v-if="l.error">{{ l.error }}</div>
            <details class="log-detail" v-if="l.requestBody || l.responseBody">
              <summary>{{ $t('settings.label.viewParams') }}</summary>
              <div class="log-body" v-if="l.requestBody"><span class="log-body-label">{{ $t('settings.label.request') }}</span><button class="copy-body-btn" @click="copyText(l.requestBody, $t('settings.copyLabel.requestPayload'))">{{ $t('common.copy') }}</button><pre>{{ l.requestBody }}</pre></div>
              <div class="log-body" v-if="l.responseBody"><span class="log-body-label">{{ $t('settings.label.response') }}</span><button class="copy-body-btn" @click="copyText(l.responseBody, $t('settings.copyLabel.responsePayload'))">{{ $t('common.copy') }}</button><pre>{{ l.responseBody }}</pre></div>
            </details>
          </div>
        </div>
        
        <div class="log-pagination" v-if="logTotal > 0">
          <div class="page-size">
            <span>{{ $t('settings.label.perPagePrefix', { count: logTotal }) }}</span>
            <select v-model.number="logPageSize" @change="resetLogPage">
              <option :value="5">5</option>
              <option :value="10">10</option>
              <option :value="20">20</option>
              <option :value="50">50</option>
            </select>
            <span>{{ $t('settings.label.perPageSuffix') }}</span>
          </div>
          <button :disabled="logPage <= 1 || logsLoading" @click="prevPage">{{ $t('settings.button.prevPage') }}</button>
          <span class="page-info">{{ $t('settings.label.pageInfo', { page: logPage, total: logTotalPages }) }}</span>
          <button :disabled="!logHasNextPage || logsLoading" @click="nextPage">{{ $t('settings.button.nextPage') }}</button>
        </div>

        <div class="card-empty" v-if="logsLoading">{{ $t('settings.label.logsLoading') }}</div>
        <div class="card-empty" v-else-if="logsLoaded && !logs.length && hasActiveLogFilter">{{ $t('settings.label.noFilteredLogs') }}</div>
        <div class="card-empty" v-else-if="logsLoaded && !logs.length">{{ $t('settings.label.empty') }}</div>
        <div class="card-empty" v-else-if="!logsLoaded">{{ $t('settings.label.logsHint') }}</div>
      </div>
    </div>
  </div>

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
.logs-page { padding: 16px; max-width: 780px; margin: 0 auto; padding-bottom: 40px; }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.page-header h2 { font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 0; }
.log-toggle-card { margin-bottom: 12px; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
.log-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; cursor: pointer; margin: 0; }
.log-toggle-label { flex: 1; min-width: 0; font-size: 14px; color: var(--text-primary); font-weight: 500; }
.log-toggle-hint { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; font-weight: 400; }
.log-toggle-control { flex-shrink: 0; display: flex; align-items: center; }
.log-toggle-control input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); cursor: pointer; }
.card { margin-bottom: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); overflow: hidden; }
.card-body { padding: 12px 16px 16px; position: relative; z-index: 1; }
.card-empty { padding: 20px 16px; text-align: center; color: var(--text-muted); font-size: 13px; }

.log-list { overflow: visible; }
.log-toolbar { padding: 12px 16px 8px; border-bottom: 1px solid var(--border-subtle); }
.log-search-row { display: flex; gap: 8px; flex-wrap: wrap; }
.log-filter { padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; color: var(--text-primary); background: var(--bg-input); outline: none; min-width: 0; flex: 1; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%238b95b0' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; padding-right: 28px; }
.log-filter:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.log-toolbar-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.log-size { font-size: 12px; color: var(--text-muted); font-family: 'SF Mono',monospace; }
.log-clear-btns { display: flex; gap: 6px; }
.clear-body-btn, .refresh-btn { padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; font-size: 12px; color: var(--text-secondary); cursor: pointer; transition: all .15s; }
.clear-body-btn:hover, .refresh-btn:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--border-hover); }

.log-pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--border-subtle); }
.log-pagination button { padding: 4px 12px; border: 1px solid var(--border); border-radius: 6px; background: transparent; font-size: 12px; color: var(--text-secondary); cursor: pointer; transition: all .15s; }
.log-pagination button:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--border-hover); }
.log-pagination button:disabled { opacity: .3; cursor: default; }
.page-info { font-size: 12px; color: var(--text-secondary); font-family: 'SF Mono',monospace; }
.page-size { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-muted); margin-right: auto; }
.page-size select { padding: 2px 22px 2px 6px; border: 1px solid var(--border); border-radius: 4px; font-size: 12px; color: var(--text-primary); background: var(--bg-input); outline: none; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%238b95b0' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 4px center; }

.log-item { padding: 10px 16px; border-top: 1px solid var(--border-subtle); }
.log-item:first-child { border-top: none; }
.log-top { display: flex; align-items: center; gap: 8px; }
.log-badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; font-family: 'SF Mono',monospace; }
.log-badge.success { background: var(--success-soft); color: var(--success); }
.log-badge.warn { background: var(--warning-soft); color: var(--warning); }
.log-badge.error { background: var(--danger-soft); color: var(--danger); }
.log-proxy { background: rgba(59,130,246,.12); color: #60a5fa; font-size: 10px; }
.log-method { background: var(--accent-soft); color: var(--text-secondary); font-size: 10px; letter-spacing: .3px; }
.log-upstream { font-size: 11px; color: var(--text-muted); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-ep { font-size: 13px; color: var(--text-secondary); }
.log-time { font-size: 11px; color: var(--text-muted); margin-left: auto; }
.log-meta { display: flex; gap: 12px; margin-top: 3px; font-size: 12px; color: var(--text-secondary); }
.log-dur { font-family: 'SF Mono',monospace; }
.log-tokens { font-family: 'SF Mono',monospace; color: var(--accent); }
.log-body-size { font-family: 'SF Mono',monospace; color: #f59e0b; font-size: 11px; }
.log-mapping { font-family: 'SF Mono',monospace; color: #8b5cf6; font-size: 11px; }
.log-err { font-size: 12px; color: var(--danger); margin-top: 3px; }
.log-detail { margin-top: 6px; }
.log-detail summary { font-size: 12px; color: var(--accent); cursor: pointer; user-select: none; }
.log-body { margin-top: 8px; }
.log-body-label { font-size: 10px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .5px; }
.copy-body-btn { margin-left: 8px; padding: 1px 7px; border: 1px solid var(--border); border-radius: 4px; background: transparent; font-size: 11px; color: var(--text-secondary); cursor: pointer; transition: all .15s; }
.copy-body-btn:hover { background: var(--accent-soft); color: var(--text-primary); }
.log-body pre { margin-top: 4px; padding: 8px 10px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 11px; font-family: 'SF Mono',monospace; color: var(--text-secondary); white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }

/* Toast */
.copy-toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 999; padding: 8px 20px; border-radius: var(--radius-md); font-size: 13px; font-weight: 500; color: var(--success); background: var(--success-soft); border: 1px solid rgba(52,211,153,.2); box-shadow: var(--shadow-md); pointer-events: none; }
.fade-enter-active { transition: all .25s cubic-bezier(.4,0,.2,1); }
.fade-leave-active { transition: all .2s cubic-bezier(.4,0,.2,1); }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* Confirm dialog */
.confirm-overlay { position: fixed; inset: 0; z-index: 9999; background: var(--bg-overlay); display: flex; align-items: center; justify-content: center; }
.confirm-dialog { background: var(--bg-card); border-radius: var(--radius-lg); border: 1px solid var(--border); padding: 28px 32px 20px; min-width: 320px; max-width: 420px; box-shadow: var(--shadow-lg); }
.confirm-msg { font-size: 15px; color: var(--text-primary); line-height: 1.6; margin: 0 0 24px; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
.confirm-cancel { padding: 8px 20px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; font-size: 14px; color: var(--text-secondary); cursor: pointer; transition: all .15s; }
.confirm-cancel:hover { background: var(--accent-soft); border-color: var(--border-hover); }
.confirm-ok { padding: 8px 20px; border: none; border-radius: var(--radius-sm); background: var(--danger); font-size: 14px; color: #fff; font-weight: 500; cursor: pointer; transition: all .15s; }
.confirm-ok:hover { background: #ef4444; box-shadow: 0 0 12px rgba(248,113,113,.3); }
</style>
