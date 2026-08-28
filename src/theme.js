import { ref } from 'vue'

// 支持的外观。设置里出现未知值（例如旧版本遗留的 'glass'）时回落到 'auto'，
// 避免 data-theme 指向不存在的主题导致 CSS 变量缺失、界面背景失效变透明。
const VALID_SETTINGS = ['auto', 'dark', 'light']

const theme = ref('dark') // current applied theme: 'dark' | 'light'
const themeSetting = ref('auto') // user setting: 'auto' | 'dark' | 'light'
let cleanupMq = null

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function sanitizeSetting(setting) {
  return VALID_SETTINGS.includes(setting) ? setting : 'auto'
}

function applyTheme(value) {
  // 只接受 'dark' / 'light'，其余一律按系统主题处理，保证 body 永远有底色
  const resolved = value === 'dark' || value === 'light' ? value : getSystemTheme()
  theme.value = resolved
  document.documentElement.dataset.theme = resolved
}

export function initTheme(setting) {
  // Clean up previous listener if any
  if (cleanupMq) cleanupMq()

  themeSetting.value = sanitizeSetting(setting || 'auto')
  applyTheme(themeSetting.value)

  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    if (themeSetting.value === 'auto') {
      applyTheme(getSystemTheme())
    }
  }
  mq.addEventListener('change', handler)
  cleanupMq = () => mq.removeEventListener('change', handler)
}

export function setThemeSetting(setting) {
  themeSetting.value = sanitizeSetting(setting)
  applyTheme(themeSetting.value)
}

export function cycleTheme() {
  const order = ['auto', 'dark', 'light']
  const currentIndex = order.indexOf(themeSetting.value)
  const next = order[(currentIndex + 1) % order.length]
  setThemeSetting(next)
  return next
}

export { theme, themeSetting }