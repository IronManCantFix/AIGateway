import { ref } from 'vue'

const theme = ref('dark') // current applied theme: 'dark' | 'light'
const themeSetting = ref('auto') // user setting: 'auto' | 'dark' | 'light'
let cleanupMq = null

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(value) {
  theme.value = value
  document.documentElement.dataset.theme = value
}

export function initTheme(setting) {
  // Clean up previous listener if any
  if (cleanupMq) cleanupMq()

  themeSetting.value = setting || 'auto'
  const resolved = themeSetting.value === 'auto' ? getSystemTheme() : themeSetting.value
  applyTheme(resolved)

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
  themeSetting.value = setting
  applyTheme(resolveThemeSetting(setting))
}

// Helper function to resolve theme setting
function resolveThemeSetting(setting) {
  return setting === 'auto' ? getSystemTheme() : setting
}

export function cycleTheme() {
  const order = ['auto', 'dark', 'light']
  const currentIndex = order.indexOf(themeSetting.value)
  const next = order[(currentIndex + 1) % order.length]
  setThemeSetting(next)
  return next
}

export { theme, themeSetting }
