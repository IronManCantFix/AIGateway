import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

const SUPPORTED = ['zh-CN', 'en-US']
const FALLBACK = 'en-US'

export function detectSystemLocale() {
  const raw = (navigator.language || navigator.userLanguage || '').toLowerCase()
  if (raw.startsWith('zh')) return 'zh-CN'
  return FALLBACK
}

export function resolveLocale(setting) {
  if (setting === 'auto' || !setting) return detectSystemLocale()
  return SUPPORTED.includes(setting) ? setting : FALLBACK
}

export const i18n = createI18n({
  legacy: false,
  locale: FALLBACK,
  fallbackLocale: FALLBACK,
  messages: { 'zh-CN': zhCN, 'en-US': enUS },
  warnHtmlMessage: false
})

export function setLocale(lang) {
  i18n.global.locale.value = lang
  document.documentElement.lang = lang
}

export function applyLocaleFromSetting(settingValue) {
  const lang = resolveLocale(settingValue)
  setLocale(lang)
  return lang
}
