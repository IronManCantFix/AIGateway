import { ref } from 'vue'

const theme = ref('dark') // current applied theme: 'dark' | 'light'
const themeSetting = ref('auto') // user setting: 'auto' | 'dark' | 'light'

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(value) {
  theme.value = value
  document.documentElement.dataset.theme = value
}

export function initTheme(setting) {
  themeSetting.value = setting || 'auto'
  const resolved = themeSetting.value === 'auto' ? getSystemTheme() : themeSetting.value
  applyTheme(resolved)

  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', () => {
    if (themeSetting.value === 'auto') {
      applyTheme(getSystemTheme())
    }
  })
}

export function setThemeSetting(setting) {
  themeSetting.value = setting
  const resolved = setting === 'auto' ? getSystemTheme() : setting
  applyTheme(resolved)
}

export function cycleTheme() {
  const next = theme.value === 'dark' ? 'light' : 'dark'
  setThemeSetting(next)
  return next
}

export { theme, themeSetting }
