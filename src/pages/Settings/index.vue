<script setup>
import { ref, onMounted, onUnmounted, inject, computed, watch } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { api } from '../../api.js'
import { openUrl } from '@tauri-apps/plugin-opener'
import iconUrl from '../../assets/icon.png'

const navigate = inject('navigate')
let unlistenProxySettings = null

const port = ref(9999)
const autoStart = ref(false)
const logEnabled = ref(false)
const saved = ref(false)

const httpProxyEnabled = ref(false)
const httpProxyUrl = ref('')
const httpProxyUsername = ref('')
const httpProxyPassword = ref('')
const httpProxyExcludeProfiles = ref([])
const showProxyAuth = ref(false)

// 提供商列表
const profiles = ref([])

const stats = ref(null)
const logs = ref([])
const trendTab = ref('year')
const statsTab = ref('provider')
const heatMode = ref('requests')  // 'requests' | 'tokens'
const logSearch = ref({ provider: '', model: '', dateFrom: '', dateTo: '' })
const logPage = ref(1)
const logPageSize = ref(5)
const trendHover = ref(null) // { x, y, date, count, tokens }

// Custom confirm dialog (window.confirm doesn't work reliably in Tauri WebView)
const confirmState = ref({ visible: false, message: '', resolve: null })
function showConfirm(message) {
  return new Promise(resolve => {
    confirmState.value = { visible: true, message, resolve }
  })
}
function confirmOk() { confirmState.value.resolve(true); confirmState.value.visible = false }
function confirmCancel() { confirmState.value.resolve(false); confirmState.value.visible = false }

async function loadSettings() {
  const s = await api.getSettings()
  port.value = s.port || 9999
  autoStart.value = s.autoStart || false
  logEnabled.value = await api.getLogEnabled()

  // 加载代理配置
  if (s.httpProxy) {
    httpProxyEnabled.value = s.httpProxy.enabled || false
    httpProxyUrl.value = s.httpProxy.url || ''
    httpProxyUsername.value = s.httpProxy.username || ''
    httpProxyPassword.value = s.httpProxy.password || ''
    httpProxyExcludeProfiles.value = s.httpProxy.excludeProfiles || []
  }
}
async function loadProfiles() {
  profiles.value = await api.getProfiles()
}

async function saveSettings() {
  const n = parseInt(port.value, 10)
  if (isNaN(n) || n < 1 || n > 65535) { port.value = 9999; return }
  await api.setSettings({
    port: n,
    autoStart: autoStart.value,
    logEnabled: logEnabled.value,
    httpProxy: {
      enabled: httpProxyEnabled.value,
      url: httpProxyUrl.value,
      username: httpProxyUsername.value || null,
      password: httpProxyPassword.value || null,
      excludeProfiles: httpProxyExcludeProfiles.value
    }
  })
  saved.value = true; setTimeout(() => saved.value = false, 1500)
}

async function saveProxySettings() {
  await saveSettings()
}
async function toggleLogging() { await api.setLogEnabled(logEnabled.value) }
async function loadStats() { stats.value = await api.getStats(); logs.value = await api.getLogs(1000) }
async function clearLogs() {
  if (!await showConfirm('确定要清除所有请求日志吗？统计计数将保留。')) return
  await api.clearLogs(); await loadStats()
}
async function clearAllData() {
  if (!await showConfirm('确定要清除所有统计数据吗？此操作不可恢复。')) return
  await api.clearAggregatedStats(); await loadStats()
}
async function clearLogsBodyData() {
  if (!await showConfirm('确定要清空所有请求参数和返回参数吗？统计计数将保留。')) return
  await api.clearLogsBodies(); await loadStats()
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

const CHART_W=400; const CHART_H=200; const PAD_L=36; const PAD_R=32; const PAD_T=16; const PAD_B=36
function fmtLocal(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
const DAY_MS=86400000
const HEAT_COLORS_REQ=['#f1f5f9','#dbeafe','#93c5fd','#3b82f6','#1d4ed8']
const HEAT_COLORS_TOK=['#f1f5f9','#fef08a','#fbbf24','#f59e0b','#d97706']
const heatHover = ref(null) // { date, count, mode, left, top }

const heatmapData = computed(() => {
  if (!stats.value||!stats.value.yearMap) return { columns:[], months:[] }
  const isToken = heatMode.value === 'tokens'
  const ym = isToken ? (stats.value.yearMapTokens || {}) : stats.value.yearMap
  const now=new Date()
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate())
  const start=new Date(today.getTime()-365*DAY_MS)
  const startDow=start.getDay()||7
  start.setDate(start.getDate()-(startDow-1))
  const end=new Date(today.getTime())

  const maxCount=Math.max(1,...Object.values(ym))
  const colors=isToken?HEAT_COLORS_TOK:HEAT_COLORS_REQ
  const allDays=[]
  for (let d=new Date(start);d<=end;d.setDate(d.getDate()+1)) {
    const ds=fmtLocal(d.getTime()); const cnt=ym[ds]||0
    const lv=cnt===0?0:Math.min(4,Math.ceil((cnt/maxCount)*4))
    allDays.push({date:ds,count:cnt,color:colors[lv],level:lv})
  }

  const columns=[]
  for (let i=0;i<allDays.length;i+=7) {
    columns.push(allDays.slice(i,i+7))
  }

  const months=[]; const mn=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月']
  let lm=-1
  for (let c=0;c<columns.length;c++) {
    const m=parseInt(columns[c][0].date.slice(5,7),10)-1
    if (m!==lm){ months.push({col:c,label:mn[m]}); lm=m }
  }
  return {columns,months}
})

const BOTTOM_Y = CHART_H - PAD_B
function smoothPath(pts) {
  if (pts.length < 2) { const p=pts[0]||{x:0,y:0}; return `M${p.x},${p.y}` }
  const clampY = y => Math.min(Math.max(y, PAD_T), BOTTOM_Y)
  let d=''
  for (let i=0; i<pts.length-1; i++) {
    const p0=pts[i===0?0:i-1], p1=pts[i], p2=pts[i+1], p3=pts[i+2]||p2
    const cp1x=p1.x+(p2.x-p0.x)/6, cp1y=clampY(p1.y+(p2.y-p0.y)/6)
    const cp2x=p2.x-(p3.x-p1.x)/6, cp2y=clampY(p2.y-(p3.y-p1.y)/6)
    d+= i===0?`M${p1.x},${p1.y} C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`:`S${cp2x},${cp2y} ${p2.x},${p2.y}`
  }
  return d
}

function niceMax(v) {
  if (v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const norm = v / mag
  if (norm <= 1) return mag
  if (norm <= 2) return 2 * mag
  if (norm <= 5) return 5 * mag
  return 10 * mag
}

const trendData = computed(() => {
  if (!stats.value||!stats.value.trend.length) return {reqPath:'',reqFill:'',tokPath:'',tokFill:'',circles:[],tokCircles:[],maxCount:1,maxTokens:1,total:0,totalTokens:0,yTicks:[],yTicksTok:[]}
  const d=stats.value.trend
  const rawMc=Math.max(...d.map(x=>x.count),1)
  const rawMt=Math.max(...d.map(x=>x.tokens),1)
  const mc=niceMax(rawMc)
  const mt=niceMax(rawMt)
  const w=CHART_W-PAD_L-PAD_R; const h=CHART_H-PAD_T-PAD_B
  const total=d.reduce((s,x)=>s+x.count,0)
  const totalTokens=d.reduce((s,x)=>s+x.tokens,0)

  // 请求次数线
  const reqPts=d.map((x,i)=>({
    x:PAD_L+(i/Math.max(d.length-1,1))*w,
    y:PAD_T+h-(x.count/mc)*h,
    count:x.count,tokens:x.tokens,date:x.date
  }))
  const reqPath=smoothPath(reqPts)
  const reqFill=reqPath+` L${reqPts[reqPts.length-1].x},${CHART_H-PAD_B} L${reqPts[0].x},${CHART_H-PAD_B} Z`

  // Token 线
  const tokPts=d.map((x,i)=>({
    x:PAD_L+(i/Math.max(d.length-1,1))*w,
    y:PAD_T+h-(x.tokens/mt)*h,
    count:x.count,tokens:x.tokens,date:x.date
  }))
  const tokPath=smoothPath(tokPts)
  const tokFill=tokPath+` L${tokPts[tokPts.length-1].x},${CHART_H-PAD_B} L${tokPts[0].x},${CHART_H-PAD_B} Z`

  const yTicks=[0,Math.round(mc/2),mc]
  const yTicksTok=[0,Math.round(mt/2),mt]
  return {reqPath,reqFill,tokPath,tokFill,circles:reqPts,tokCircles:tokPts,maxCount:mc,maxTokens:mt,total,totalTokens,yTicks,yTicksTok}
})

const filteredLogs = computed(() => {
  const s = logSearch.value
  return logs.value.filter(l => {
    if (s.provider && !(l.provider || '').toLowerCase().includes(s.provider.toLowerCase())) return false
    if (s.model && !(l.model || '').toLowerCase().includes(s.model.toLowerCase())) return false
    if (s.dateFrom) {
      const from = new Date(s.dateFrom).getTime()
      if (l.timestamp < from) return false
    }
    if (s.dateTo) {
      const to = new Date(s.dateTo).getTime() + 86400000
      if (l.timestamp >= to) return false
    }
    return true
  })
})

const logTotalPages = computed(() => {
  const size = parseInt(logPageSize.value) || 5
  return Math.max(1, Math.ceil(filteredLogs.value.length / size))
})

const pagedLogs = computed(() => {
  const size = parseInt(logPageSize.value) || 5
  const total = filteredLogs.value.length
  const totalPages = Math.max(1, Math.ceil(total / size))
  const page = Math.min(Math.max(parseInt(logPage.value) || 1, 1), totalPages)
  const start = (page - 1) * size
  return filteredLogs.value.slice(start, start + size)
})

const logProviderOptions = computed(() => [...new Set(logs.value.map(l => l.provider).filter(Boolean))])
const logModelOptions = computed(() => [...new Set(logs.value.map(l => l.model).filter(Boolean))])

const providerTokenMap = computed(() => {
  if (!stats.value || !stats.value.byProviderTokens) return {}
  const m = {}
  for (const t of stats.value.byProviderTokens) m[t.provider] = t.total
  return m
})

let copyTimer = 0
const copyMsg = ref('')
function copyText(text, label) {
  const el = document.createElement('textarea')
  el.value = text; el.style.position = 'fixed'; el.style.left = '-9999px'
  document.body.appendChild(el); el.select(); document.execCommand('copy')
  document.body.removeChild(el)
  copyMsg.value = label + '复制成功'
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copyMsg.value = '' }, 1500)
}

function resetLogPage() { logPage.value = 1 }
function prevPage() { logPage.value = Math.max(1, (parseInt(logPage.value) || 1) - 1) }
function nextPage() { logPage.value = Math.min(logTotalPages.value, (parseInt(logPage.value) || 1) + 1) }

// Keep logPage in valid range when data/pageSize changes
watch([logTotalPages, logPageSize], () => {
  const max = logTotalPages.value
  const cur = parseInt(logPage.value) || 1
  if (cur > max) logPage.value = max
  else if (cur < 1) logPage.value = 1
})

const updateInfo = ref(null)
const checkingUpdate = ref(false)
const currentVersion = ref('')
const isDev = import.meta.env.DEV

async function checkForUpdates() {
  checkingUpdate.value = true
  try {
    const info = await api.checkForUpdates()
    updateInfo.value = info
    if (!isDev && info.has_update) {
      const ok = await showConfirm(`发现新版本 ${info.latest_version}，是否前往下载？`)
      if (ok) openUrl(info.download_url).catch(e => console.error('openUrl failed:', e))
    }
  } catch (e) {
    console.error('检查更新失败:', e)
  } finally {
    checkingUpdate.value = false
  }
}

function openDownloadPage() {
  if (updateInfo.value?.download_url) {
    openUrl(updateInfo.value.download_url).catch(e => console.error('openUrl failed:', e))
  }
}
function openGithub() {
  openUrl('https://github.com/IronManCantFix/AIGateway').catch(e => console.error('openUrl failed:', e))
}

onMounted(async () => {
  await loadSettings()
  await loadProfiles()
  await loadStats()
  currentVersion.value = await api.getAppVersion()

  // 监听托盘菜单的代理设置变化
  unlistenProxySettings = await listen('proxy-settings-changed', async () => {
    await loadSettings()
  })
})

onUnmounted(() => {
  unlistenProxySettings?.()
})
</script>

<template>
  <div class="settings">
    <Transition name="fade">
      <div class="copy-toast" v-if="copyMsg">{{ copyMsg }}</div>
    </Transition>
    <div class="page-header">
      <button class="back-link" @click="navigate('gateway')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        返回
      </button>
      <h2>设置与统计</h2>
    </div>

    <!-- 代理端口 -->
    <div class="card">
      <div class="card-header"><h3>代理端口</h3></div>
      <div class="card-body">
        <div class="field-row">
          <input v-model.number="port" type="number" min="1" max="65535" @change="saveSettings" />
          <span class="saved" v-if="saved">&check; 已保存</span>
        </div>
      </div>
    </div>

    <!-- HTTP 代理 -->
    <div class="card">
      <div class="card-header"><h3>HTTP 代理</h3></div>
      <div class="card-body">
        <label class="check-field">
          <input type="checkbox" v-model="httpProxyEnabled" @change="saveProxySettings" />
          <span>启用 HTTP 代理</span>
        </label>

        <div class="proxy-config" v-if="httpProxyEnabled">
          <div class="proxy-field">
            <label>代理地址</label>
            <input v-model="httpProxyUrl" placeholder="http://127.0.0.1:7890" @change="saveProxySettings" />
          </div>

          <div class="proxy-auth-toggle" @click="showProxyAuth = !showProxyAuth">
            {{ showProxyAuth ? '隐藏认证信息' : '显示认证信息（可选）' }}
          </div>

          <div class="proxy-auth" v-if="showProxyAuth">
            <div class="proxy-field">
              <label>用户名</label>
              <input v-model="httpProxyUsername" placeholder="可选" @change="saveProxySettings" />
            </div>
            <div class="proxy-field">
              <label>密码</label>
              <input v-model="httpProxyPassword" type="password" placeholder="可选" @change="saveProxySettings" />
            </div>
          </div>

          <div class="proxy-exclude" v-if="profiles.length > 0">
            <label>不需要代理的提供商</label>
            <div class="exclude-list">
              <label v-for="p in profiles" :key="p.id" class="check-field exclude-item">
                <input type="checkbox"
                  :value="p.id"
                  v-model="httpProxyExcludeProfiles"
                  @change="saveProxySettings" />
                <span>{{ p.name }}</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 自动启动 -->
    <div class="card">
      <div class="card-body">
        <label class="check-field" @change="saveSettings">
          <input type="checkbox" v-model="autoStart" />
          <span>启动应用时自动开启代理</span>
        </label>
      </div>
    </div>

    <!-- 日志开关 -->
    <div class="card">
      <div class="card-body">
        <label class="check-field" @change="toggleLogging">
          <input type="checkbox" v-model="logEnabled" />
          <span>记录请求参数与返回参数</span>
        </label>
        <p class="field-hint">开启后会在请求日志中记录请求体和响应体内容（完整保留，不截断），立即生效</p>
      </div>
    </div>

    <template v-if="stats">
      <!-- 总览 -->
      <div class="card">
        <div class="card-header">
          <h3>请求统计</h3>
          <div class="header-actions">
            <button class="refresh-btn" @click="loadStats">刷新</button>
            <button class="clear-btn danger" @click="clearAllData">清除统计</button>
          </div>
        </div>
        <div class="card-body overview-body">
          <div class="overview-stats">
            <div class="overview-stat">
              <div class="stat-number">{{ stats.totalRequests.toLocaleString() }}</div>
              <div class="stat-desc">总请求数</div>
            </div>
            <div class="overview-divider"></div>
            <div class="overview-stat" v-if="stats.totalTokens">
              <div class="stat-number token">{{ fmtTok(stats.totalTokens) }}</div>
              <div class="stat-desc">Token 消耗</div>
            </div>
            <div class="overview-stat" v-else>
              <div class="stat-number muted">—</div>
              <div class="stat-desc">Token 消耗</div>
            </div>
            <div class="overview-divider"></div>
            <div class="overview-stat">
              <div class="stat-number">{{ Math.round(stats.totalRequests / Math.max(stats.trend.length, 1)).toLocaleString() }}</div>
              <div class="stat-desc">日均请求</div>
            </div>
          </div>
          <div class="token-breakdown" v-if="stats.totalTokens">
            <div class="token-item">
              <span class="token-label">Prompt</span>
              <span class="token-value">{{ fmtTok(stats.totalPromptTokens) }}</span>
            </div>
            <div class="token-item">
              <span class="token-label">Completion</span>
              <span class="token-value">{{ fmtTok(stats.totalCompletionTokens) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 趋势 Tab -->
      <div class="card">
        <div class="card-tabs">
          <button :class="{ active: trendTab === 'year' }" @click="trendTab = 'year'">全年热力图</button>
          <button :class="{ active: trendTab === 'month' }" @click="trendTab = 'month'">30 天趋势</button>
        </div>
        <div class="card-body" v-if="trendTab === 'year'">
          <div class="heat-mode-toggle">
            <button :class="{ active: heatMode === 'requests' }" @click="heatMode = 'requests'">请求数</button>
            <button :class="{ 'active-tok': heatMode === 'tokens' }" @click="heatMode = 'tokens'">Token</button>
          </div>
          <div class="heatmap-wrap" v-if="heatmapData.columns.length">
            <div class="heatmap-months" :style="{ gridTemplateColumns: 'repeat('+heatmapData.columns.length+', 1fr)' }">
              <span v-for="m in heatmapData.months" :key="m.col" :style="{ gridColumnStart: m.col + 1 }">{{ m.label }}</span>
            </div>
            <div class="heatmap-body" style="position:relative">
              <div class="heatmap-grid" :style="{ gridTemplateColumns: '20px repeat('+heatmapData.columns.length+', 1fr)' }">
                <span class="heat-wd" style="grid-row:1">一</span>
                <span class="heat-wd" style="grid-row:2"></span>
                <span class="heat-wd" style="grid-row:3">三</span>
                <span class="heat-wd" style="grid-row:4"></span>
                <span class="heat-wd" style="grid-row:5">五</span>
                <span class="heat-wd" style="grid-row:6"></span>
                <span class="heat-wd" style="grid-row:7">日</span>
                <template v-for="col in heatmapData.columns" :key="col[0].date">
                  <span v-for="day in col" :key="day.date"
                    class="heat-cell" :style="{ background: day.color }"
                    @mouseenter="heatHover = (() => { const r = $event.target.getBoundingClientRect(); return { date: day.date, count: day.count, mode: heatMode, left: r.left + r.width / 2, top: r.top } })()"
                    @mouseleave="heatHover = null"></span>
                </template>
              </div>
              <Teleport to="body">
                <Transition name="fade">
                  <div v-if="heatHover" class="heat-tooltip"
                    :style="{ left: heatHover.left + 'px', top: heatHover.top + 'px' }">
                    <div class="heat-tip-date">{{ heatHover.date }}</div>
                    <div class="heat-tip-val">{{ heatHover.mode === 'tokens' ? fmtTok(heatHover.count) + ' tokens' : heatHover.count + ' 次请求' }}</div>
                  </div>
                </Transition>
              </Teleport>
            </div>
            <div class="heatmap-legend">
              <span>少</span>
              <span v-for="c in (heatMode === 'tokens' ? HEAT_COLORS_TOK : HEAT_COLORS_REQ)" :key="c" class="legend-cell" :style="{ background: c }"></span>
              <span>多</span>
            </div>
          </div>
          <div class="card-empty" v-else>暂无数据</div>
        </div>
        <div class="card-body trend-body" v-if="trendTab === 'month'">
          <template v-if="stats.trend.length">
            <div class="trend-header">
              <div class="trend-stat">
                <span class="trend-val">{{ trendData.total.toLocaleString() }}</span>
                <span class="trend-lbl">30 天请求</span>
              </div>
              <div class="trend-stat">
                <span class="trend-val token-color">{{ fmtTok(trendData.totalTokens) }}</span>
                <span class="trend-lbl">30 天 Token</span>
              </div>
              <div class="trend-stat">
                <span class="trend-val">{{ Math.round(trendData.total / Math.max(stats.trend.length, 1)) }}</span>
                <span class="trend-lbl">日均请求</span>
              </div>
            </div>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-dot req"></span>请求数</span>
              <span class="legend-item"><span class="legend-dot tok"></span>Token</span>
            </div>
            <div class="chart-wrap">
              <svg :viewBox="'0 0 '+CHART_W+' '+CHART_H" class="trend-svg" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <linearGradient id="reqAreaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#6366f1" stop-opacity="0.2"/>
                    <stop offset="100%" stop-color="#6366f1" stop-opacity="0.01"/>
                  </linearGradient>
                  <linearGradient id="tokAreaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.2"/>
                    <stop offset="100%" stop-color="#f59e0b" stop-opacity="0.01"/>
                  </linearGradient>
                  <linearGradient id="reqLineGrad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stop-color="#6366f1"/>
                    <stop offset="100%" stop-color="#8b5cf6"/>
                  </linearGradient>
                  <linearGradient id="tokLineGrad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stop-color="#f59e0b"/>
                    <stop offset="100%" stop-color="#f97316"/>
                  </linearGradient>
                </defs>
                <!-- Grid lines -->
                <line v-for="t in trendData.yTicks" :key="'g'+t"
                  :x1="PAD_L" :y1="PAD_T+(CHART_H-PAD_T-PAD_B)-(t/trendData.maxCount)*(CHART_H-PAD_T-PAD_B)"
                  :x2="CHART_W-PAD_R" :y2="PAD_T+(CHART_H-PAD_T-PAD_B)-(t/trendData.maxCount)*(CHART_H-PAD_T-PAD_B)"
                  stroke="#e2e8f0" stroke-width="1" stroke-dasharray="4,4"/>
                <!-- Left Y axis labels (requests) -->
                <text v-for="t in trendData.yTicks" :key="'yr'+t"
                  :x="PAD_L-8" :y="PAD_T+(CHART_H-PAD_T-PAD_B)-(t/trendData.maxCount)*(CHART_H-PAD_T-PAD_B)+4"
                  text-anchor="end" fill="#6366f1" font-size="9" font-family="SF Mono, monospace">{{ t }}</text>
                <!-- Right Y axis labels (tokens) -->
                <text v-for="t in trendData.yTicksTok" :key="'yt'+t"
                  :x="CHART_W-PAD_R+8" :y="PAD_T+(CHART_H-PAD_T-PAD_B)-(t/trendData.maxTokens)*(CHART_H-PAD_T-PAD_B)+4"
                  text-anchor="start" fill="#f59e0b" font-size="9" font-family="SF Mono, monospace">{{ fmtTok(t) }}</text>
                <!-- Token area + line -->
                <path :d="trendData.tokFill" fill="url(#tokAreaGrad)"/>
                <path :d="trendData.tokPath" fill="none" stroke="url(#tokLineGrad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <!-- Request area + line -->
                <path :d="trendData.reqFill" fill="url(#reqAreaGrad)"/>
                <path :d="trendData.reqPath" fill="none" stroke="url(#reqLineGrad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <!-- X axis -->
                <line :x1="PAD_L" :y1="CHART_H-PAD_B" :x2="CHART_W-PAD_R" :y2="CHART_H-PAD_B" stroke="#e2e8f0" stroke-width="1"/>
                <!-- Token data points -->
                <circle v-for="(c,idx) in trendData.tokCircles" :key="'t'+idx" :cx="c.x" :cy="c.y" r="8" fill="transparent" stroke="none"
                  @mouseenter="trendHover = c" @mouseleave="trendHover = null"/>
                <circle v-for="(c,idx) in trendData.tokCircles" :key="'td'+idx" :cx="c.x" :cy="c.y" r="2.5" :fill="trendHover&&trendHover.date===c.date?'#f59e0b':'#fff'" :stroke="'#f59e0b'" stroke-width="1.5" style="pointer-events:none"/>
                <!-- Request data points and X labels -->
                <g v-for="(c,idx) in trendData.circles" :key="'r'+c.date">
                  <circle :cx="c.x" :cy="c.y" r="8" fill="transparent" stroke="none"
                    @mouseenter="trendHover = c" @mouseleave="trendHover = null"/>
                  <circle :cx="c.x" :cy="c.y" r="2.5" :fill="trendHover&&trendHover.date===c.date?'#6366f1':'#fff'" :stroke="'#6366f1'" stroke-width="1.5" style="pointer-events:none"/>
                  <text :x="c.x" :y="CHART_H-PAD_B+16" text-anchor="middle" fill="#94a3b8" font-size="9" font-family="SF Mono, monospace"
                    v-if="idx%Math.ceil(trendData.circles.length/7)===0||idx===trendData.circles.length-1">{{ c.date.slice(5) }}</text>
                </g>
                <!-- Hover tooltip -->
                <g v-if="trendHover">
                  <line :x1="trendHover.x" :y1="PAD_T" :x2="trendHover.x" :y2="CHART_H-PAD_B" stroke="#94a3b8" stroke-width="0.5" stroke-dasharray="3,3"/>
                  <rect :x="Math.min(trendHover.x+8, CHART_W-PAD_R-100)" :y="Math.max(PAD_T, trendHover.y-36)" width="96" height="30" rx="6" fill="#1e293b" opacity="0.92"/>
                  <text :x="Math.min(trendHover.x+14, CHART_W-PAD_R-94)" :y="Math.max(PAD_T+10, trendHover.y-24)" fill="#e2e8f0" font-size="10" font-family="SF Mono, monospace">{{ trendHover.date.slice(5) }}</text>
                  <text :x="Math.min(trendHover.x+14, CHART_W-PAD_R-94)" :y="Math.max(PAD_T+22, trendHover.y-12)" fill="#94a3b8" font-size="9" font-family="SF Mono, monospace">{{ trendHover.count }}次 / {{ fmtTok(trendHover.tokens) }}</text>
                </g>
              </svg>
            </div>
          </template>
          <div class="card-empty" v-else>暂无数据</div>
        </div>
      </div>

      <!-- 统计 Tab -->
      <div class="card">
        <div class="card-tabs">
          <button :class="{ active: statsTab === 'provider' }" @click="statsTab = 'provider'">提供商</button>
          <button :class="{ active: statsTab === 'model' }" @click="statsTab = 'model'">模型</button>
          <button :class="{ active: statsTab === 'logs' }" @click="statsTab = 'logs'">日志</button>
        </div>

        <div class="card-body" v-if="statsTab === 'provider'">
          <template v-if="stats.byProviderModel && stats.byProviderModel.length">
            <div v-for="pv in stats.byProviderModel" :key="pv.provider" class="provider-group">
              <div class="stat-row main">
                <span class="stat-name">{{ pv.provider }}</span>
                <div class="stat-vals">
                  <span class="stat-val token-val" v-if="providerTokenMap[pv.provider]">{{ fmtTok(providerTokenMap[pv.provider]) }}</span>
                  <span class="stat-val">{{ pv.count }}<span class="unit">次</span></span>
                </div>
              </div>
              <div class="sub-row" v-for="m in pv.models" :key="m.model">
                <span class="sub-name">{{ m.model }}</span>
                <span class="sub-val">{{ m.count }}</span>
              </div>
            </div>
          </template>
          <div class="card-empty" v-else>暂无数据</div>
        </div>

        <div class="card-body" v-if="statsTab === 'model'">
          <template v-if="stats.byModel && stats.byModel.length">
            <div class="model-table-header">
              <span class="model-col-name">模型</span>
              <span class="model-col-count">调用次数</span>
              <span class="model-col-token">Token 量</span>
            </div>
            <div class="model-row" v-for="m in stats.byModel" :key="m.model">
              <span class="model-col-name">{{ m.model }}</span>
              <span class="model-col-count">{{ m.count }}</span>
              <span class="model-col-token" v-if="m.tokens">{{ fmtTok(m.tokens.total) }}</span>
              <span class="model-col-token" v-else>—</span>
            </div>
          </template>
          <div class="card-empty" v-else>暂无数据</div>
        </div>

        <div class="card-body" v-if="statsTab === 'logs'" style="padding:0">
          <div class="log-toolbar" v-if="logs.length">
            <div class="log-search-row">
              <select v-model="logSearch.provider" @change="resetLogPage" class="log-filter">
                <option value="">全部提供商</option>
                <option v-for="p in logProviderOptions" :key="p" :value="p">{{ p }}</option>
              </select>
              <select v-model="logSearch.model" @change="resetLogPage" class="log-filter">
                <option value="">全部模型</option>
                <option v-for="m in logModelOptions" :key="m" :value="m">{{ m }}</option>
              </select>
              <input type="date" v-model="logSearch.dateFrom" @change="resetLogPage" class="log-filter" placeholder="开始日期" />
              <input type="date" v-model="logSearch.dateTo" @change="resetLogPage" class="log-filter" placeholder="结束日期" />
            </div>
            <div class="log-toolbar-actions">
              <span class="log-count">共 {{ filteredLogs.length }} 条</span>
              <div class="log-clear-btns">
                <button class="refresh-btn" @click="loadStats">刷新</button>
                <button class="clear-body-btn" @click="clearLogs">清除日志</button>
                <button class="clear-body-btn" @click="clearLogsBodyData">清空参数</button>
              </div>
            </div>
          </div>
          <div class="log-list" v-if="pagedLogs.length">
            <div class="log-item" v-for="l in pagedLogs" :key="l.timestamp">
              <div class="log-top">
                <span class="log-badge" :class="statusLabel(l.statusCode)">{{ l.statusCode }}</span>
                <span class="log-badge log-proxy" v-if="l.proxy">PROXY</span>
                <span class="log-ep">{{ endpointLabel(l.endpoint) }}</span>
                <span class="log-upstream" v-if="l.upstreamUrl" :title="l.upstreamUrl">{{ shortUrl(l.upstreamUrl) }}</span>
                <span class="log-time">{{ fmtTime(l.timestamp) }}</span>
              </div>
              <div class="log-meta">
                <span>{{ l.provider || '-' }}</span>
                <span v-if="l.modelMapping" class="log-mapping">{{ l.originalModel || '?' }} → {{ l.modelMapping }} | {{ l.provider || '-' }}</span>
                <span v-else>{{ l.model }}</span>
                <span class="log-dur">{{ l.duration }}ms</span>
                <span class="log-tokens" v-if="l.totalTokens">P {{ fmtTok(l.promptTokens) }} / C {{ fmtTok(l.completionTokens) }} / T {{ fmtTok(l.totalTokens) }}</span>
              </div>
              <div class="log-err" v-if="l.error">{{ l.error }}</div>
              <details class="log-detail" v-if="l.requestBody || l.responseBody">
                <summary>查看参数</summary>
                <div class="log-body" v-if="l.requestBody"><span class="log-body-label">请求</span><button class="copy-body-btn" @click="copyText(l.requestBody, '请求参数')">复制</button><pre>{{ l.requestBody }}</pre></div>
                <div class="log-body" v-if="l.responseBody"><span class="log-body-label">响应</span><button class="copy-body-btn" @click="copyText(l.responseBody, '响应参数')">复制</button><pre>{{ l.responseBody }}</pre></div>
              </details>
            </div>
          </div>
          <div class="log-pagination">
            <div class="page-size">
              <span>每页</span>
              <select v-model.number="logPageSize" @change="resetLogPage">
                <option :value="5">5</option>
                <option :value="10">10</option>
                <option :value="20">20</option>
                <option :value="50">50</option>
              </select>
              <span>条</span>
            </div>
            <template v-if="logTotalPages > 1">
              <button :disabled="logPage <= 1" @click="prevPage">上一页</button>
              <span class="page-info">{{ logPage }} / {{ logTotalPages }}</span>
              <button :disabled="logPage >= logTotalPages" @click="nextPage">下一页</button>
            </template>
          </div>
          <div class="card-empty" v-if="logs.length && !pagedLogs.length">无匹配结果</div>
          <div class="card-empty" v-if="!logs.length">暂无数据</div>
        </div>
      </div>
    </template>

    <!-- 关于 -->
    <div class="about">
      <img :src="iconUrl" class="about-logo" alt="AIGateway" />
      <p><strong>AIGateway</strong></p>
      <p class="about-version">
        {{ isDev ? '开发版' : (currentVersion || '...') }}
        <button class="check-update-btn" @click="checkForUpdates" :disabled="checkingUpdate">
          {{ checkingUpdate ? '检查中...' : '检查更新' }}
        </button>
        <button class="download-btn" v-if="updateInfo?.has_update && !isDev" @click="openDownloadPage">前往下载</button>
      </p>
      <p class="about-update-hint" v-if="isDev && updateInfo">最新正式版: {{ updateInfo.latest_version }}</p>
      <p class="about-update-hint" v-else-if="updateInfo?.has_update">新版本 {{ updateInfo.latest_version }} 可用</p>
      <p class="about-update-hint up-to-date" v-else-if="updateInfo">已是最新版本</p>
      <p>作者 Claude Code &amp; DeepSeek v4 Pro &amp; mimo-v2.5-pro</p>
      <p><span class="github-link" @click="openGithub"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg> GitHub</span></p>
    </div>
  </div>

  <!-- 确认弹窗 -->
  <Teleport to="body">
    <div class="confirm-overlay" v-if="confirmState.visible" @click.self="confirmCancel">
      <div class="confirm-dialog">
        <p class="confirm-msg">{{ confirmState.message }}</p>
        <div class="confirm-actions">
          <button class="confirm-cancel" @click="confirmCancel">取消</button>
          <button class="confirm-ok" @click="confirmOk">确定</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings { padding: 16px; max-width: 780px; margin: 0 auto; padding-bottom: 40px; }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.page-header h2 { font-size: 18px; font-weight: 700; color: #1e293b; margin: 0; }
.back-link { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border: none; border-radius: 8px; background: #f1f5f9; font-size: 13px; color: #64748b; cursor: pointer; transition: all .15s; }
.back-link:hover { background: #e2e8f0; color: #334155; }
.card { margin-bottom: 12px; border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; overflow: hidden; }
.card-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px 0; }
.card-header h3 { font-size: 12px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .6px; }
.card-body { padding: 12px 16px 16px; }
.card-empty { padding: 20px 16px; text-align: center; color: #cbd5e1; font-size: 13px; }
.card-tabs { display: flex; gap: 0; border-bottom: 1px solid #e2e8f0; }
.card-tabs button { padding: 10px 16px; border: none; background: transparent; font-size: 13px; font-weight: 500; color: #94a3b8; cursor: pointer; border-bottom: 2px solid transparent; transition: all .15s; margin-bottom: -1px; }
.card-tabs button:hover { color: #475569; }
.card-tabs button.active { color: #6366f1; border-bottom-color: #6366f1; }
.field-row { display: flex; align-items: center; gap: 12px; }
.field-row input[type=number] { padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 10px; font-size: 15px; font-weight: 500; font-family: 'SF Mono','Fira Code',monospace; outline: none; width: 130px; transition: all .15s; background: #f8fafc; }
.field-row input[type=number]:focus { border-color: #a5b4fc; background: #fff; box-shadow: 0 0 0 3px rgba(165,180,252,.15); }
.saved { font-size: 13px; color: #22c55e; font-weight: 500; }
.check-field { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 14px; color: #334155; }
.check-field input[type=checkbox] { width: 18px; height: 18px; accent-color: #6366f1; cursor: pointer; }
.field-hint { font-size: 12px; color: #94a3b8; margin: 6px 0 0; }

/* Overview stats */
.overview-body { padding: 20px 20px 16px; }
.overview-stats { display: flex; align-items: center; justify-content: center; gap: 0; margin-bottom: 16px; }
.overview-stat { text-align: center; padding: 0 24px; }
.overview-divider { width: 1px; height: 40px; background: #e2e8f0; }
.stat-number { font-size: 28px; font-weight: 800; color: #1e293b; line-height: 1; font-family: 'SF Mono','Fira Code',monospace; }
.stat-number.token { background: linear-gradient(135deg, #6366f1, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.stat-number.muted { color: #cbd5e1; }
.stat-desc { font-size: 11px; color: #94a3b8; margin-top: 4px; text-transform: uppercase; letter-spacing: .5px; }
.token-breakdown { display: flex; justify-content: center; gap: 20px; padding-top: 12px; border-top: 1px solid #f1f5f9; }
.token-item { display: flex; align-items: center; gap: 6px; }
.token-label { font-size: 11px; color: #94a3b8; }
.token-value { font-size: 12px; font-weight: 600; color: #6366f1; font-family: 'SF Mono',monospace; }

/* Trend chart */
.trend-body { padding: 16px 20px 20px; }
.trend-header { display: flex; justify-content: center; gap: 32px; margin-bottom: 16px; }
.trend-stat { text-align: center; }
.trend-val { font-size: 20px; font-weight: 700; color: #1e293b; font-family: 'SF Mono',monospace; }
.trend-val.token-color { background: linear-gradient(135deg, #f59e0b, #f97316); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.trend-lbl { font-size: 11px; color: #94a3b8; display: block; margin-top: 2px; }
.chart-legend { display: flex; justify-content: center; gap: 20px; margin-bottom: 12px; }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #64748b; }
.legend-dot { width: 10px; height: 3px; border-radius: 2px; }
.legend-dot.req { background: linear-gradient(90deg, #6366f1, #8b5cf6); }
.legend-dot.tok { background: linear-gradient(90deg, #f59e0b, #f97316); }
.chart-wrap { background: #fafafa; border-radius: 12px; padding: 16px 12px 8px; }
.trend-svg { width: 100%; overflow: visible; }
.heat-mode-toggle { display: flex; gap: 4px; margin-bottom: 12px; }
.heat-mode-toggle button { padding: 4px 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; font-size: 12px; color: #64748b; cursor: pointer; transition: all .15s; }
.heat-mode-toggle button.active { background: #6366f1; color: #fff; border-color: #6366f1; }
.heat-mode-toggle button.active-tok { background: #f59e0b; color: #fff; border-color: #f59e0b; }
.heat-tooltip { position: fixed; transform: translate(-50%, -110%); background: #1e293b; color: #e2e8f0; padding: 6px 10px; border-radius: 6px; font-size: 11px; white-space: nowrap; pointer-events: none; z-index: 99999; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
.heat-tooltip::after { content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%); border: 4px solid transparent; border-top-color: #1e293b; }
.heat-tip-date { color: #94a3b8; font-size: 10px; margin-bottom: 2px; }
.heat-tip-val { font-weight: 600; font-family: 'SF Mono',monospace; }

.stat-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; }
.stat-row + .stat-row { border-top: 1px solid #f1f5f9; }
.stat-row.main { padding: 10px 0; }
.stat-name { font-size: 13px; color: #334155; font-weight: 600; }
.stat-vals { display: flex; align-items: center; gap: 12px; }
.stat-val { font-size: 14px; font-weight: 700; color: #6366f1; font-family: 'SF Mono',monospace; }
.token-val { font-size: 12px; color: #f59e0b; }
.provider-group + .provider-group { margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0; }
.sub-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0 4px 16px; }
.sub-name { font-size: 12px; color: #64748b; font-family: 'SF Mono',monospace; }
.sub-val { font-size: 12px; color: #94a3b8; font-family: 'SF Mono',monospace; }
.unit { font-size: 10px; font-weight: 400; color: #cbd5e1; margin-left: 2px; }
.model-table-header { display: flex; align-items: center; padding: 0 0 8px; border-bottom: 1px solid #e2e8f0; margin-bottom: 4px; }
.model-table-header span { font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .3px; }
.model-row { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid #f8fafc; }
.model-col-name { flex: 1; min-width: 0; font-size: 13px; color: #334155; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-col-count { width: 80px; text-align: right; font-size: 14px; font-weight: 700; color: #6366f1; font-family: 'SF Mono',monospace; }
.model-col-token { width: 80px; text-align: right; font-size: 13px; font-weight: 600; color: #f59e0b; font-family: 'SF Mono',monospace; }
.header-actions { display: flex; gap: 6px; }
.refresh-btn { padding: 3px 8px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; font-size: 12px; color: #64748b; cursor: pointer; transition: all .15s; }
.refresh-btn:hover { background: #f1f5f9; }
.clear-btn { padding: 3px 8px; border: 1px solid #fecaca; border-radius: 6px; background: #fff; font-size: 12px; color: #ef4444; cursor: pointer; transition: all .15s; }
.clear-btn:hover { background: #fef2f2; }
.clear-btn.danger { border-color: #fca5a5; color: #b91c1c; }
.clear-btn.danger:hover { background: #fef2f2; }
.heatmap-wrap { width: 100%; }
.heatmap-months { display: grid; gap: 1px; margin-bottom: 4px; padding-left: 21px; font-size: 10px; color: #94a3b8; width: calc(100% - 21px); }
.heatmap-months span { grid-row: 1; }
.heatmap-body { }
.heatmap-grid { display: grid; grid-template-rows: repeat(7, 1fr); grid-auto-flow: column; gap: 1px; aspect-ratio: 8/1; width: 100%; }
.heat-wd { font-size: 9px; color: #cbd5e1; display: flex; align-items: center; }
.heat-cell { border-radius: 2px; cursor: pointer; transition: outline .1s; }
.heat-cell:hover { outline: 1.5px solid #6366f1; outline-offset: -1px; }
.heatmap-legend { display: flex; align-items: center; justify-content: flex-end; gap: 3px; margin-top: 8px; font-size: 10px; color: #94a3b8; }
.legend-cell { width: 10px; height: 10px; border-radius: 2px; }
.trend-svg { width: 100%; overflow: visible; }
.log-list { overflow: visible; }
.log-toolbar { padding: 12px 16px 8px; border-bottom: 1px solid #f1f5f9; }
.log-search-row { display: flex; gap: 8px; flex-wrap: wrap; }
.log-filter { padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 12px; color: #334155; background: #f8fafc; outline: none; min-width: 0; flex: 1; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; padding-right: 28px; }
.log-filter:focus { border-color: #a5b4fc; background: #fff; }
.log-toolbar-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.log-clear-btns { display: flex; gap: 6px; }
.log-count { font-size: 12px; color: #94a3b8; }
.clear-body-btn { padding: 3px 8px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; font-size: 12px; color: #64748b; cursor: pointer; transition: all .15s; }
.clear-body-btn:hover { background: #f1f5f9; }
.log-pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px 16px; border-top: 1px solid #f1f5f9; }
.log-pagination button { padding: 4px 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; font-size: 12px; color: #475569; cursor: pointer; transition: all .15s; }
.log-pagination button:hover:not(:disabled) { background: #f1f5f9; }
.log-pagination button:disabled { opacity: .4; cursor: default; }
.page-info { font-size: 12px; color: #64748b; font-family: 'SF Mono',monospace; }
.page-size { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #94a3b8; margin-right: auto; }
.page-size select { padding: 2px 22px 2px 6px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 12px; color: #334155; background: #fff; outline: none; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 4px center; }
.log-item { padding: 10px 16px; border-top: 1px solid #f1f5f9; }
.log-top { display: flex; align-items: center; gap: 8px; }
.log-badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; font-family: 'SF Mono',monospace; }
.log-badge.success { background: #dcfce7; color: #16a34a; }
.log-badge.warn { background: #fef9c3; color: #ca8a04; }
.log-badge.error { background: #fee2e2; color: #dc2626; }
.log-proxy { background: #dbeafe; color: #2563eb; font-size: 10px; }
.log-upstream { font-size: 11px; color: #94a3b8; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-ep { font-size: 13px; color: #334155; }
.log-time { font-size: 11px; color: #94a3b8; margin-left: auto; }
.log-meta { display: flex; gap: 12px; margin-top: 3px; font-size: 12px; color: #64748b; }
.log-dur { font-family: 'SF Mono',monospace; }
.log-tokens { font-family: 'SF Mono',monospace; color: #6366f1; }
.log-mapping { font-family: 'SF Mono',monospace; color: #8b5cf6; font-size: 11px; }
.log-err { font-size: 12px; color: #dc2626; margin-top: 3px; }
.divider { height: 1px; background: #e2e8f0; margin: 8px 16px; }
.log-detail { margin-top: 6px; }
.log-detail summary { font-size: 12px; color: #6366f1; cursor: pointer; user-select: none; }
.log-body { margin-top: 8px; }
.log-body-label { font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .5px; }
.copy-body-btn { margin-left: 8px; padding: 1px 7px; border: 1px solid #e2e8f0; border-radius: 4px; background: #fff; font-size: 11px; color: #64748b; cursor: pointer; transition: all .15s; }
.copy-body-btn:hover { background: #f1f5f9; color: #334155; }
.copy-toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 999; padding: 8px 20px; border-radius: 10px; font-size: 13px; font-weight: 500; color: #166534; background: #f0fdf4; border: 1px solid #bbf7d0; box-shadow: 0 4px 16px rgba(0,0,0,.1); pointer-events: none; }
.fade-enter-active { transition: all .2s ease-out; }
.fade-leave-active { transition: all .15s ease-in; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.log-body pre { margin-top: 4px; padding: 8px 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 11px; font-family: 'SF Mono',monospace; color: #475569; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }

/* HTTP Proxy */
.proxy-config { margin-top: 12px; padding-top: 12px; border-top: 1px solid #f1f5f9; }
.proxy-field { margin-bottom: 12px; }
.proxy-field label { display: block; font-size: 13px; font-weight: 600; color: #64748b; margin-bottom: 6px; }
.proxy-field input { width: 100%; padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 10px; font-size: 14px; outline: none; transition: all .15s; background: #f8fafc; }
.proxy-field input:focus { border-color: #a5b4fc; background: #fff; box-shadow: 0 0 0 3px rgba(165,180,252,.15); }
.proxy-auth-toggle { font-size: 13px; color: #6366f1; cursor: pointer; margin-bottom: 12px; user-select: none; }
.proxy-auth-toggle:hover { text-decoration: underline; }
.proxy-exclude { margin-top: 16px; padding-top: 12px; border-top: 1px solid #f1f5f9; }
.proxy-exclude > label { display: block; font-size: 13px; font-weight: 600; color: #64748b; margin-bottom: 10px; }
.exclude-list { display: flex; flex-direction: column; gap: 8px; }
.exclude-item { font-size: 13px; }

.about-version { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 13px; color: #94a3b8; font-family: 'SF Mono',monospace; }
.about-update-hint { font-size: 12px; color: #6366f1; margin: -4px 0 0; }
.about-update-hint.up-to-date { color: #22c55e; }
.check-update-btn { padding: 3px 10px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; font-size: 12px; color: #64748b; cursor: pointer; transition: all .15s; }
.check-update-btn:hover:not(:disabled) { background: #f1f5f9; }
.check-update-btn:disabled { opacity: .6; cursor: default; }
.download-btn { padding: 3px 10px; border: none; border-radius: 6px; background: #6366f1; font-size: 12px; color: #fff; font-weight: 500; cursor: pointer; transition: all .15s; }
.download-btn:hover { background: #4f46e5; }
.about { text-align: center; padding: 32px 16px; color: #94a3b8; font-size: 13px; line-height: 1.8; }
.about-logo { width: 64px; height: 64px; margin-bottom: 8px; }
.about strong { color: #64748b; }
.github-link { display: inline-flex; align-items: center; gap: 5px; color: #6366f1; text-decoration: none; vertical-align: middle; cursor: pointer; }
.github-link:hover { text-decoration: underline; }

/* Confirm dialog */
.confirm-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; }
.confirm-dialog { background: #fff; border-radius: 14px; padding: 28px 32px 20px; min-width: 320px; max-width: 420px; box-shadow: 0 20px 60px rgba(0,0,0,.2); }
.confirm-msg { font-size: 15px; color: #1e293b; line-height: 1.6; margin: 0 0 24px; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
.confirm-cancel { padding: 8px 20px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; font-size: 14px; color: #64748b; cursor: pointer; transition: all .15s; }
.confirm-cancel:hover { background: #f8fafc; border-color: #cbd5e1; }
.confirm-ok { padding: 8px 20px; border: none; border-radius: 8px; background: #ef4444; font-size: 14px; color: #fff; font-weight: 500; cursor: pointer; transition: all .15s; }
.confirm-ok:hover { background: #dc2626; }
</style>
