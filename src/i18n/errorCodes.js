import { i18n } from './index'

/**
 * Translate a Rust AppError (or any thrown value) into a user-visible string.
 * AppError shape: { code: string, params?: object, detail?: string }
 * Falls back gracefully if input isn't an AppError.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function translateError(err) {
  const t = i18n.global.t

  if (typeof err === 'string') return err

  if (err && typeof err === 'object') {
    if (typeof err.code === 'string') {
      const key = `errors.${err.code}`
      const params = err.params || {}
      // Use te() to check key existence — more reliable than string comparison
      if (i18n.global.te(key)) {
        return t(key, params)
      }
      // Missing key fallback: log detail to console (devtools-visible) but DON'T surface
      // it to the user (detail is English-only and may include sensitive debug info).
      // User sees the raw code as a last resort — better than leaking English/internal data.
      if (err.detail) {
        console.warn('[i18n] Missing translation for', key, '— detail:', err.detail)
      }
      return err.code
    }
    if (err.message) return err.message
  }
  return String(err)
}
