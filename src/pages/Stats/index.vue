<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '../../api.js'

const { t } = useI18n()

const stats = ref(null)
const statsLoading = ref(false)
const trendTab = ref('year')
const statsTab = ref('provider')
const heatMode = ref('requests')
const trendHover = ref(null)
const heatHover = ref(null)
const heatTipEl = ref(null)

// 热力图悬浮提示：记录格子中心位置，渲染后按实际宽度钳制在视口内
function setHeatHover(day, mode, rect) {
  heatHover.value = {
    date: day.date,
    count: day.count,
    cached: (stats.value?.yearMapCachedTokens || {})[day.date] || 0,
    mode,
    left: rect.left + rect.width / 2,
    top: rect.top
  }
  nextTick(adjustHeatTipPos)
}

function adjustHeatTipPos() {
  const el = heatTipEl.value
  if (!el || !heatHover.value) return
  const margin = 8
  const half = el.offsetWidth / 2
  let left = heatHover.value.left
  if (left - half < margin) left = margin + half
  if (left + half > window.innerWidth - margin) left = window.innerWidth - margin - half
  if (left !== heatHover.value.left) heatHover.value.left = left
}

const confirmState = ref({ visible: false, message: '', resolve: null })
function showConfirm(message) {
  return new Promise(resolve => {
    confirmState.value = { visible: true, message, resolve }
  })
}
function confirmOk() { confirmState.value.resolve(true); confirmState.value.visible = false }
function confirmCancel() { confirmState.value.resolve(false); confirmState.value.visible = false }

async function loadStats() {
  statsLoading.value = true
  try {
    const nextStats = await api.getStats()
    stats.value = nextStats
  } finally {
    statsLoading.value = false
  }
}

async function clearAllData() {
  if (!await showConfirm(t('settings.confirm.clearStats'))) return
  await api.clearAggregatedStats(); stats.value = null; await loadStats()
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

function getHeatColors(mode) {
  const style = getComputedStyle(document.documentElement)
  if (mode === 'tokens') {
    return [style.getPropertyValue('--heat-tok-0'), style.getPropertyValue('--heat-tok-1'), style.getPropertyValue('--heat-tok-2'), style.getPropertyValue('--heat-tok-3'), style.getPropertyValue('--heat-tok-4')]
  }
  return [style.getPropertyValue('--heat-req-0'), style.getPropertyValue('--heat-req-1'), style.getPropertyValue('--heat-req-2'), style.getPropertyValue('--heat-req-3'), style.getPropertyValue('--heat-req-4')]
}

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
  const colors=getHeatColors(isToken?'tokens':'requests')
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

  const months=[]; const mn=t('settings.chart.monthsShort').split(',')
  let lm=-1
  for (let c=0;c<columns.length;c++) {
    const m=parseInt(columns[c][0].date.slice(5,7),10)-1
    if (m!==lm){ months.push({col:c,label:mn[m]}); lm=m }
  }
  return {columns,months}
})

const weekdayLabels = computed(() => t('settings.chart.weekdaysShort').split(','))

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
  if (!stats.value||!stats.value.trend.length) return {reqPath:'',reqFill:'',tokPath:'',tokFill:'',circles:[],tokCircles:[],maxCount:1,maxTokens:1,total:0,totalTokens:0,totalCached:0,yTicks:[],yTicksTok:[]}
  const d=stats.value.trend
  const rawMc=Math.max(...d.map(x=>x.count),1)
  const rawMt=Math.max(...d.map(x=>x.tokens),1)
  const mc=niceMax(rawMc)
  const mt=niceMax(rawMt)
  const w=CHART_W-PAD_L-PAD_R; const h=CHART_H-PAD_T-PAD_B
  const total=d.reduce((s,x)=>s+x.count,0)
  const totalTokens=d.reduce((s,x)=>s+x.tokens,0)
  const totalCached=d.reduce((s,x)=>s+(x.cached||0),0)

  const reqPts=d.map((x,i)=>({
    x:PAD_L+(i/Math.max(d.length-1,1))*w,
    y:PAD_T+h-(x.count/mc)*h,
    count:x.count,tokens:x.tokens,cached:x.cached||0,date:x.date
  }))
  const reqPath=smoothPath(reqPts)
  const reqFill=reqPath+` L${reqPts[reqPts.length-1].x},${CHART_H-PAD_B} L${reqPts[0].x},${CHART_H-PAD_B} Z`

  const tokPts=d.map((x,i)=>({
    x:PAD_L+(i/Math.max(d.length-1,1))*w,
    y:PAD_T+h-(x.tokens/mt)*h,
    count:x.count,tokens:x.tokens,cached:x.cached||0,date:x.date
  }))
  const tokPath=smoothPath(tokPts)
  const tokFill=tokPath+` L${tokPts[tokPts.length-1].x},${CHART_H-PAD_B} L${tokPts[0].x},${CHART_H-PAD_B} Z`

  const yTicks=[0,Math.round(mc/2),mc]
  const yTicksTok=[0,Math.round(mt/2),mt]
  return {reqPath,reqFill,tokPath,tokFill,circles:reqPts,tokCircles:tokPts,maxCount:mc,maxTokens:mt,total,totalTokens,totalCached,yTicks,yTicksTok}
})

const providerTokenMap = computed(() => {
  if (!stats.value || !stats.value.byProviderTokens) return {}
  const m = {}
  for (const t of stats.value.byProviderTokens) m[t.provider] = t.total
  return m
})

onMounted(() => {
  loadStats().catch(e => console.error('Load stats failed:', e))
})
</script>

<template>
  <div class="stats-page">
    <div class="page-header">
      <h2>{{ $t('nav.stats') }}</h2>
    </div>

    <div class="card" v-if="statsLoading && !stats">
      <div class="card-body stats-loading">{{ $t('settings.label.statsLoading') }}</div>
    </div>

    <template v-if="stats">
      <!-- Overview -->
      <div class="card">
        <div class="card-header">
          <h3>{{ $t('settings.section.statsOverview') }}</h3>
          <div class="header-actions">
            <button class="refresh-btn" @click="loadStats">{{ $t('settings.button.refresh') }}</button>
            <button class="clear-btn danger" @click="clearAllData">{{ $t('settings.button.clearStats') }}</button>
          </div>
        </div>
        <div class="card-body overview-body">
          <!-- 今日统计 -->
          <div class="today-stats" v-if="stats.today">
            <div class="today-title">{{ $t('settings.section.todayStats') }}</div>
            <div class="today-values">
              <div class="today-stat">
                <span class="today-number">{{ stats.today.count.toLocaleString() }}</span>
                <span class="today-label">{{ $t('settings.label.todayRequests') }}</span>
              </div>
              <div class="today-divider"></div>
              <div class="today-stat">
                <span class="today-number token">{{ fmtTok(stats.today.tokens) }}</span>
                <span class="today-label">{{ $t('settings.label.todayTokens') }}</span>
              </div>
            </div>
          </div>
          <div class="overview-stats">
            <div class="overview-stat">
              <div class="stat-number">{{ stats.totalRequests.toLocaleString() }}</div>
              <div class="stat-desc">{{ $t('settings.label.totalRequests') }}</div>
            </div>
            <div class="overview-divider"></div>
            <div class="overview-stat" v-if="stats.totalTokens">
              <div class="stat-number token">{{ fmtTok(stats.totalTokens) }}</div>
              <div class="stat-desc">{{ $t('settings.label.tokensUsed') }}</div>
            </div>
            <div class="overview-stat" v-else>
              <div class="stat-number muted">—</div>
              <div class="stat-desc">{{ $t('settings.label.tokensUsed') }}</div>
            </div>
            <div class="overview-divider"></div>
            <div class="overview-stat">
              <div class="stat-number">{{ Math.round(stats.totalRequests / Math.max(stats.trend.length, 1)).toLocaleString() }}</div>
              <div class="stat-desc">{{ $t('settings.label.avgPerDay') }}</div>
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

      <!-- Trend Tab -->
      <div class="card">
        <div class="card-tabs">
          <button :class="{ active: trendTab === 'year' }" @click="trendTab = 'year'">{{ $t('settings.button.heatmapYear') }}</button>
          <button :class="{ active: trendTab === 'month' }" @click="trendTab = 'month'">{{ $t('settings.button.trend30d') }}</button>
        </div>
        <div class="card-body" v-if="trendTab === 'year'">
          <div class="heat-mode-toggle">
            <button :class="{ active: heatMode === 'requests' }" @click="heatMode = 'requests'">{{ $t('settings.button.heatRequests') }}</button>
            <button :class="{ 'active-tok': heatMode === 'tokens' }" @click="heatMode = 'tokens'">Token</button>
          </div>
          <div class="heatmap-wrap" v-if="heatmapData.columns.length">
            <div class="heatmap-months" :style="{ gridTemplateColumns: 'repeat('+heatmapData.columns.length+', 1fr)' }">
              <span v-for="m in heatmapData.months" :key="m.col" :style="{ gridColumnStart: m.col + 1 }">{{ m.label }}</span>
            </div>
            <div class="heatmap-body" style="position:relative">
              <div class="heatmap-grid" :style="{ gridTemplateColumns: '20px repeat('+heatmapData.columns.length+', 1fr)' }">
                <span class="heat-wd" style="grid-row:1">{{ weekdayLabels[0] }}</span>
                <span class="heat-wd" style="grid-row:2"></span>
                <span class="heat-wd" style="grid-row:3">{{ weekdayLabels[1] }}</span>
                <span class="heat-wd" style="grid-row:4"></span>
                <span class="heat-wd" style="grid-row:5">{{ weekdayLabels[2] }}</span>
                <span class="heat-wd" style="grid-row:6"></span>
                <span class="heat-wd" style="grid-row:7">{{ weekdayLabels[3] }}</span>
                <template v-for="col in heatmapData.columns" :key="col[0].date">
                  <span v-for="day in col" :key="day.date"
                    class="heat-cell" :style="{ background: day.color }"
                    @mouseenter="setHeatHover(day, heatMode, $event.target.getBoundingClientRect())"
                    @mouseleave="heatHover = null"></span>
                </template>
              </div>
              <Teleport to="body">
                <Transition name="fade">
                  <div v-if="heatHover" ref="heatTipEl" class="heat-tooltip"
                    :style="{ left: heatHover.left + 'px', top: heatHover.top + 'px' }">
                    <div class="heat-tip-date">{{ heatHover.date }}</div>
                    <div class="heat-tip-val"><template v-if="heatHover.mode === 'tokens'">{{ $t('settings.chart.tokenCountWithUnit', { count: fmtTok(heatHover.count) }) }}<span v-if="heatHover.cached"> · 缓存 {{ fmtTok(heatHover.cached) }}</span></template><template v-else>{{ $t('settings.chart.requestCountWithUnit', { count: heatHover.count }) }}</template></div>
                  </div>
                </Transition>
              </Teleport>
            </div>
            <div class="heatmap-legend">
              <span>{{ $t('settings.chart.heatLevelLow') }}</span>
              <span v-for="(c, i) in getHeatColors(heatMode)" :key="i" class="legend-cell" :style="{ background: c }"></span>
              <span>{{ $t('settings.chart.heatLevelHigh') }}</span>
            </div>
          </div>
          <div class="card-empty" v-else>{{ $t('settings.label.empty') }}</div>
        </div>
        <div class="card-body trend-body" v-if="trendTab === 'month'">
          <template v-if="stats.trend.length">
            <div class="trend-header">
              <div class="trend-stat">
                <span class="trend-val">{{ trendData.total.toLocaleString() }}</span>
                <span class="trend-lbl">{{ $t('settings.label.requests30d') }}</span>
              </div>
              <div class="trend-stat">
                <span class="trend-val token-color">{{ fmtTok(trendData.totalTokens) }}</span>
                <span class="trend-lbl">{{ $t('settings.label.tokens30d') }}</span>
              </div>
              <div class="trend-stat" v-if="trendData.totalCached">
                <span class="trend-val cache-color">{{ fmtTok(trendData.totalCached) }}</span>
                <span class="trend-lbl">{{ $t('settings.label.cached30d') }}</span>
              </div>
              <div class="trend-stat">
                <span class="trend-val">{{ Math.round(trendData.total / Math.max(stats.trend.length, 1)) }}</span>
                <span class="trend-lbl">{{ $t('settings.label.avgPerDay') }}</span>
              </div>
            </div>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-dot req"></span>{{ $t('settings.chart.requestCountAxis') }}</span>
              <span class="legend-item"><span class="legend-dot tok"></span>Token</span>
            </div>
            <div class="chart-wrap">
              <svg :viewBox="'0 0 '+CHART_W+' '+CHART_H" class="trend-svg" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <linearGradient id="reqAreaGradStats" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#6366f1" stop-opacity="0.2"/>
                    <stop offset="100%" stop-color="#6366f1" stop-opacity="0.01"/>
                  </linearGradient>
                  <linearGradient id="tokAreaGradStats" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.2"/>
                    <stop offset="100%" stop-color="#f59e0b" stop-opacity="0.01"/>
                  </linearGradient>
                  <linearGradient id="reqLineGradStats" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stop-color="#6366f1"/>
                    <stop offset="100%" stop-color="#8b5cf6"/>
                  </linearGradient>
                  <linearGradient id="tokLineGradStats" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stop-color="#f59e0b"/>
                    <stop offset="100%" stop-color="#f97316"/>
                  </linearGradient>
                </defs>
                <line v-for="t in trendData.yTicks" :key="'g'+t"
                  :x1="PAD_L" :y1="PAD_T+(CHART_H-PAD_T-PAD_B)-(t/trendData.maxCount)*(CHART_H-PAD_T-PAD_B)"
                  :x2="CHART_W-PAD_R" :y2="PAD_T+(CHART_H-PAD_T-PAD_B)-(t/trendData.maxCount)*(CHART_H-PAD_T-PAD_B)"
                  stroke="var(--chart-grid)" stroke-width="1" stroke-dasharray="4,4"/>
                <text v-for="t in trendData.yTicks" :key="'yr'+t"
                  :x="PAD_L-8" :y="PAD_T+(CHART_H-PAD_T-PAD_B)-(t/trendData.maxCount)*(CHART_H-PAD_T-PAD_B)+4"
                  text-anchor="end" fill="var(--accent)" font-size="9" font-family="SF Mono, monospace">{{ t }}</text>
                <text v-for="t in trendData.yTicksTok" :key="'yt'+t"
                  :x="CHART_W-PAD_R+8" :y="PAD_T+(CHART_H-PAD_T-PAD_B)-(t/trendData.maxTokens)*(CHART_H-PAD_T-PAD_B)+4"
                  text-anchor="start" fill="#f59e0b" font-size="9" font-family="SF Mono, monospace">{{ fmtTok(t) }}</text>
                
                <path :d="trendData.tokFill" fill="url(#tokAreaGradStats)"/>
                <path :d="trendData.tokPath" fill="none" stroke="url(#tokLineGradStats)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                
                <path :d="trendData.reqFill" fill="url(#reqAreaGradStats)"/>
                <path :d="trendData.reqPath" fill="none" stroke="url(#reqLineGradStats)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                
                <line :x1="PAD_L" :y1="CHART_H-PAD_B" :x2="CHART_W-PAD_R" :y2="CHART_H-PAD_B" stroke="var(--chart-grid)" stroke-width="1"/>
                
                <circle v-for="(c,idx) in trendData.tokCircles" :key="'t'+idx" :cx="c.x" :cy="c.y" r="8" fill="transparent" stroke="none"
                  @mouseenter="trendHover = c" @mouseleave="trendHover = null"/>
                <circle v-for="(c,idx) in trendData.tokCircles" :key="'td'+idx" :cx="c.x" :cy="c.y" r="2.5" :fill="trendHover&&trendHover.date===c.date?'#f59e0b':'#fff'" :stroke="'#f59e0b'" stroke-width="1.5" style="pointer-events:none"/>
                
                <g v-for="(c,idx) in trendData.circles" :key="'r'+c.date">
                  <circle :cx="c.x" :cy="c.y" r="8" fill="transparent" stroke="none"
                    @mouseenter="trendHover = c" @mouseleave="trendHover = null"/>
                  <circle :cx="c.x" :cy="c.y" r="2.5" :fill="trendHover&&trendHover.date===c.date?'#6366f1':'#fff'" :stroke="'#6366f1'" stroke-width="1.5" style="pointer-events:none"/>
                  <text :x="c.x" :y="CHART_H-PAD_B+16" text-anchor="middle" fill="var(--chart-tooltip-muted)" font-size="9" font-family="SF Mono, monospace"
                    v-if="idx%Math.ceil(trendData.circles.length/7)===0||idx===trendData.circles.length-1">{{ c.date.slice(5) }}</text>
                </g>
                
                <g v-if="trendHover">
                  <line :x1="trendHover.x" :y1="PAD_T" :x2="trendHover.x" :y2="CHART_H-PAD_B" stroke="var(--chart-grid)" stroke-width="0.5" stroke-dasharray="3,3"/>
                  <rect :x="Math.min(trendHover.x+8, CHART_W-PAD_R-130)" :y="Math.max(PAD_T, trendHover.y-36)" width="130" height="30" rx="6" fill="var(--chart-tooltip-bg)"/>
                  <text :x="Math.min(trendHover.x+14, CHART_W-PAD_R-124)" :y="Math.max(PAD_T+10, trendHover.y-24)" fill="var(--chart-tooltip-text)" font-size="10" font-family="SF Mono, monospace">{{ trendHover.date.slice(5) }}</text>
                  <text :x="Math.min(trendHover.x+14, CHART_W-PAD_R-124)" :y="Math.max(PAD_T+22, trendHover.y-12)" fill="var(--chart-tooltip-muted)" font-size="9" font-family="SF Mono, monospace">{{ $t('settings.chart.trendCount', { count: trendHover.count }) }} / {{ fmtTok(trendHover.tokens) }}<tspan v-if="trendHover.cached"> / 缓存 {{ fmtTok(trendHover.cached) }}</tspan></text>
                </g>
              </svg>
            </div>
          </template>
          <div class="card-empty" v-else>{{ $t('settings.label.empty') }}</div>
        </div>
      </div>

      <!-- Breakdown Tab -->
      <div class="card">
        <div class="card-tabs">
          <button :class="{ active: statsTab === 'provider' }" @click="statsTab = 'provider'">{{ $t('settings.button.tabProvider') }}</button>
          <button :class="{ active: statsTab === 'model' }" @click="statsTab = 'model'">{{ $t('settings.button.tabModel') }}</button>
        </div>

        <div class="card-body" v-if="statsTab === 'provider'">
          <template v-if="stats.byProviderModel && stats.byProviderModel.length">
            <div v-for="pv in stats.byProviderModel" :key="pv.provider" class="provider-group">
              <div class="stat-row main">
                <span class="stat-name">{{ pv.provider }}</span>
                <div class="stat-vals">
                  <span class="stat-val token-val" v-if="providerTokenMap[pv.provider]">{{ fmtTok(providerTokenMap[pv.provider]) }}</span>
                  <span class="stat-val">{{ $t('settings.label.requestCount', { count: pv.count }) }}</span>
                </div>
              </div>
              <div class="sub-row" v-for="m in pv.models" :key="m.model">
                <span class="sub-name">{{ m.model }}</span>
                <span class="sub-val">{{ m.count }}</span>
              </div>
            </div>
          </template>
          <div class="card-empty" v-else>{{ $t('settings.label.empty') }}</div>
        </div>

        <div class="card-body" v-if="statsTab === 'model'">
          <template v-if="stats.byModel && stats.byModel.length">
            <div class="model-table-header">
              <span class="model-col-name">{{ $t('settings.label.colModel') }}</span>
              <span class="model-col-count">{{ $t('settings.label.colCount') }}</span>
              <span class="model-col-token">{{ $t('settings.label.colTokens') }}</span>
            </div>
            <div class="model-row" v-for="m in stats.byModel" :key="m.model">
              <span class="model-col-name">{{ m.model }}</span>
              <span class="model-col-count">{{ m.count }}</span>
              <span class="model-col-token" v-if="m.tokens">{{ fmtTok(m.tokens.total) }}</span>
              <span class="model-col-token" v-else>—</span>
            </div>
          </template>
          <div class="card-empty" v-else>{{ $t('settings.label.empty') }}</div>
        </div>
      </div>
    </template>
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
.stats-page { padding: 16px; max-width: 780px; margin: 0 auto; padding-bottom: 40px; }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.page-header h2 { font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 0; }
.card { margin-bottom: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); overflow: hidden; }
.card-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px 0; position: relative; z-index: 1; }
.card-header h3 { font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .8px; }
.card-body { padding: 12px 16px 16px; position: relative; z-index: 1; }
.card-empty { padding: 20px 16px; text-align: center; color: var(--text-muted); font-size: 13px; }
.stats-loading { color: var(--text-muted); font-size: 13px; text-align: center; }
.card-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--accent-soft); position: relative; z-index: 1; }
.card-tabs button { padding: 10px 16px; border: none; background: transparent; font-size: 13px; font-weight: 500; color: var(--text-muted); cursor: pointer; border-bottom: 2px solid transparent; transition: all .15s; margin-bottom: -1px; }
.card-tabs button:hover { color: var(--text-secondary); }
.card-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }

/* Today stats */
.today-stats { margin-bottom: 16px; padding: 14px 16px; border: 1px solid var(--accent-soft); border-radius: var(--radius-md, 10px); background: linear-gradient(135deg, var(--accent-soft), transparent); }
.today-title { font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .8px; margin-bottom: 10px; }
.today-values { display: flex; align-items: center; justify-content: center; gap: 0; }
.today-stat { text-align: center; padding: 0 24px; }
.today-number { font-size: 26px; font-weight: 800; color: var(--text-primary); line-height: 1; font-family: 'SF Mono','Fira Code',monospace; }
.today-number.token { background: linear-gradient(135deg, var(--accent), #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.today-label { font-size: 11px; color: var(--text-muted); margin-top: 4px; display: block; }
.today-divider { width: 1px; height: 36px; background: var(--border); }

/* Overview stats */
.overview-body { padding: 20px 20px 16px; }
.overview-stats { display: flex; align-items: center; justify-content: center; gap: 0; margin-bottom: 16px; }
.overview-stat { text-align: center; padding: 0 24px; }
.overview-divider { width: 1px; height: 40px; background: var(--border); }
.stat-number { font-size: 28px; font-weight: 800; color: var(--text-primary); line-height: 1; font-family: 'SF Mono','Fira Code',monospace; }
.stat-number.token { background: linear-gradient(135deg, var(--accent), #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.stat-number.muted { color: var(--text-muted); }
.stat-desc { font-size: 11px; color: var(--text-muted); margin-top: 4px; text-transform: uppercase; letter-spacing: .5px; }
.token-breakdown { display: flex; justify-content: center; gap: 20px; padding-top: 12px; border-top: 1px solid var(--border-subtle); }
.token-item { display: flex; align-items: center; gap: 6px; }
.token-label { font-size: 11px; color: var(--text-muted); }
.token-value { font-size: 12px; font-weight: 600; color: var(--accent); font-family: 'SF Mono',monospace; }

/* Trend chart */
.trend-body { padding: 16px 20px 20px; }
.trend-header { display: flex; justify-content: center; gap: 32px; margin-bottom: 16px; }
.trend-stat { text-align: center; }
.trend-val { font-size: 20px; font-weight: 700; color: var(--text-primary); font-family: 'SF Mono',monospace; }
.trend-val.token-color { background: linear-gradient(135deg, #f59e0b, #f97316); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.trend-val.cache-color { background: linear-gradient(135deg, #34d399, #10b981); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.trend-lbl { font-size: 11px; color: var(--text-muted); display: block; margin-top: 2px; }
.chart-legend { display: flex; justify-content: center; gap: 20px; margin-bottom: 12px; }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.legend-dot { width: 10px; height: 3px; border-radius: 2px; }
.legend-dot.req { background: linear-gradient(90deg, var(--accent), #8b5cf6); }
.legend-dot.tok { background: linear-gradient(90deg, #f59e0b, #f97316); }
.chart-wrap { background: var(--bg-input); border-radius: var(--radius-md); padding: 16px 12px 8px; border: 1px solid var(--border-subtle); }
.trend-svg { width: 100%; overflow: visible; }
.heat-mode-toggle { display: flex; gap: 4px; margin-bottom: 12px; }
.heat-mode-toggle button { padding: 4px 12px; border: 1px solid var(--border); border-radius: 6px; background: transparent; font-size: 12px; color: var(--text-secondary); cursor: pointer; transition: all .15s; }
.heat-mode-toggle button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.heat-mode-toggle button.active-tok { background: #f59e0b; color: #fff; border-color: #f59e0b; }
.heat-tooltip { position: fixed; transform: translate(-50%, -100%); background: var(--bg-card); color: var(--text-primary); padding: 6px 10px; border-radius: 6px; font-size: 11px; white-space: nowrap; pointer-events: none; z-index: 99999; box-shadow: var(--shadow-md); border: 1px solid var(--border); }
.heat-tip-date { color: var(--text-muted); font-size: 10px; margin-bottom: 2px; }
.heat-tip-val { font-weight: 600; font-family: 'SF Mono',monospace; }

.stat-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; }
.stat-row + .stat-row { border-top: 1px solid var(--border-subtle); }
.stat-row.main { padding: 10px 0; }
.stat-name { font-size: 13px; color: var(--text-secondary); font-weight: 600; }
.stat-vals { display: flex; align-items: center; gap: 12px; }
.stat-val { font-size: 14px; font-weight: 700; color: var(--accent); font-family: 'SF Mono',monospace; }
.token-val { font-size: 12px; color: #f59e0b; }
.provider-group + .provider-group { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--accent-soft); }
.sub-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0 4px 16px; }
.sub-name { font-size: 12px; color: var(--text-secondary); font-family: 'SF Mono',monospace; }
.sub-val { font-size: 12px; color: var(--text-muted); font-family: 'SF Mono',monospace; }
.model-table-header { display: flex; align-items: center; padding: 0 0 8px; border-bottom: 1px solid var(--accent-soft); margin-bottom: 4px; }
.model-table-header span { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: .3px; }
.model-row { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-subtle); }
.model-col-name { flex: 1; min-width: 0; font-size: 13px; color: var(--text-secondary); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-col-count { width: 80px; text-align: right; font-size: 14px; font-weight: 700; color: var(--accent); font-family: 'SF Mono',monospace; }
.model-col-token { width: 80px; text-align: right; font-size: 13px; font-weight: 600; color: #f59e0b; font-family: 'SF Mono',monospace; }

.header-actions { display: flex; gap: 6px; }
.refresh-btn { padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; font-size: 12px; color: var(--text-secondary); cursor: pointer; transition: all .15s; }
.refresh-btn:hover { background: var(--accent-soft); border-color: var(--border-hover); }
.clear-btn { padding: 3px 8px; border: 1px solid rgba(248,113,113,.2); border-radius: 6px; background: transparent; font-size: 12px; color: var(--danger); cursor: pointer; transition: all .15s; }
.clear-btn:hover { background: var(--danger-soft); }
.clear-btn.danger { border-color: rgba(248,113,113,.3); color: #fca5a5; }
.clear-btn.danger:hover { background: var(--danger-soft); }

.heatmap-wrap { width: 100%; }
.heatmap-months { display: grid; gap: 1px; margin-bottom: 4px; padding-left: 21px; font-size: 10px; color: var(--text-muted); width: calc(100% - 21px); }
.heatmap-months span { grid-row: 1; }
.heatmap-grid { display: grid; grid-template-rows: repeat(7, 1fr); grid-auto-flow: column; gap: 1px; aspect-ratio: 8/1; width: 100%; }
.heat-wd { font-size: 9px; color: var(--text-muted); display: flex; align-items: center; }
.heat-cell { border-radius: 2px; cursor: pointer; transition: outline .1s; }
.heat-cell:hover { outline: 1.5px solid var(--accent); outline-offset: -1px; }
.heatmap-legend { display: flex; align-items: center; justify-content: flex-end; gap: 3px; margin-top: 8px; font-size: 10px; color: var(--text-muted); }
.legend-cell { width: 10px; height: 10px; border-radius: 2px; }

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
