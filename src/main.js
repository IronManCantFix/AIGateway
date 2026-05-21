import { createApp } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import './main.css'
import App from './App.vue'
import { i18n, applyLocaleFromSetting } from './i18n'

async function bootstrap() {
  try {
    const settings = await invoke('get_settings')
    applyLocaleFromSetting(settings?.language)
  } catch (e) {
    console.error('i18n boot failed, falling back:', e)
    applyLocaleFromSetting('auto')
  }
  createApp(App).use(i18n).mount('#app')
}

bootstrap()
