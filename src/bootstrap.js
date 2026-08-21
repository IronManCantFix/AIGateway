// src/bootstrap.js — 两个窗口入口（主窗口 index.html / 面板 panel.html）共用的启动流程：
// 读设置 → 解析语言 → 初始化主题 → 挂载根组件。
import { i18n, applyLocaleFromSetting } from './i18n'
import { initTheme } from './theme.js'
import { api } from './api.js'

export async function bootstrap({ App, mount }) {
  let resolved = 'en-US'
  let setting = 'auto'
  try {
    const settings = await api.getSettings()
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
  mount(App)
}
