import { createApp } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import './main.css'
import App from './App.vue'
import { i18n } from './i18n'
import { bootstrap } from './bootstrap.js'

// Global shortcut: Cmd+Shift+D / Ctrl+Shift+D to toggle DevTools
// Registers immediately — works even when page is blank
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault()
    invoke('toggle_devtools').catch(() => {})
  }
})

bootstrap({
  App,
  mount: () => createApp(App).use(i18n).mount('#app')
})
