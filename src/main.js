import { createApp } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import './main.css'
import App from './App.vue'
import { i18n, applyLocaleFromSetting, resolveLocale } from './i18n'
import { api } from './api.js'
import { initTheme } from './theme.js'

// Global shortcut: Cmd+Shift+D / Ctrl+Shift+D to toggle DevTools
// Registers immediately — works even when page is blank
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault()
    invoke('toggle_devtools').catch(() => {})
  }
})

async function bootstrap() {
  let resolved = 'en-US'
  let setting = 'auto'
  try {
    const settings = await invoke('get_settings')
    setting = settings?.language ?? 'auto'
    resolved = await applyLocaleFromSetting(setting)
    initTheme(settings?.theme || 'auto')
  } catch (e) {
    console.error('i18n boot failed, falling back:', e)
    resolved = await applyLocaleFromSetting('auto')
    initTheme('auto')
  }
  if (setting === 'auto') {
    try {
      await api.setLanguage(resolved)
    } catch (e) {
      console.warn('Failed to sync resolved locale to Rust:', e)
    }
  }
  createApp(App).use(i18n).mount('#app')
}

bootstrap()
