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
      const translated = t(key, params)
      // vue-i18n returns the key itself when translation is missing
      if (translated !== key) return translated
      return err.detail || err.code
    }
    if (err.message) return err.message
  }
  return String(err)
}
