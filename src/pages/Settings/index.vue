<script setup>
import { ref, onMounted, onUnmounted, inject, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { listen } from '@tauri-apps/api/event'
import { api } from '../../api.js'
import { openUrl } from '@tauri-apps/plugin-opener'
import { translateError } from '../../i18n/errorCodes.js'
import { setLocale, resolveLocale } from '../../i18n'
import iconUrl from '../../assets/icon.png'

const { t } = useI18n()

const navigate = inject('navigate')
const themeSetting = inject('themeSetting')
const setThemeSetting = inject('setThemeSetting')
let unlistenProxySettings = null

const port = ref(9999)
const autoStart = ref(false)
const logEnabled = ref(false)
const languageSetting = ref('auto')
const saved = ref(false)
const portChecking = ref(false)
const portConflict = ref(null)

const httpProxyEnabled = ref(false)
const httpProxyUrl = ref('')
const httpProxyUsername = ref('')
const httpProxyPassword = ref('')
const httpProxyExcludeProfiles = ref([])
const showProxyAuth = ref(false)

const profiles = ref([])

let copyTimer = 0
const copyMsg = ref('')

const confirmState = ref({ visible: false, message: '', resolve: null })
function showConfirm(message) {
  return new Promise(resolve => {
    confirmState.value = { visible: true, message, resolve }
  })
}
function confirmOk() { confirmState.value.resolve(true); confirmState.value.visible = false }
function confirmCancel() { confirmState.value.resolve(false); confirmState.value.visible = false }

async function loadSettings() {
  const s = await api.getSettings()
  port.value = s.port || 9999
  autoStart.value = s.autoStart || false
  logEnabled.value = await api.getLogEnabled()
  languageSetting.value = s.language || 'auto'

  if (s.httpProxy) {
    httpProxyEnabled.value = s.httpProxy.enabled || false
    httpProxyUrl.value = s.httpProxy.url || ''
    httpProxyUsername.value = s.httpProxy.username || ''
    httpProxyPassword.value = s.httpProxy.password || ''
    httpProxyExcludeProfiles.value = s.httpProxy.excludeProfiles || []
  }
}

async function loadProfiles() {
  profiles.value = await api.getProfiles()
}

async function saveSettings() {
  const n = parseInt(port.value, 10)
  if (isNaN(n) || n < 1 || n > 65535) { port.value = 9999; return }
  await api.setSettings({
    port: n,
    autoStart: autoStart.value,
    logEnabled: logEnabled.value,
    httpProxy: {
      enabled: httpProxyEnabled.value,
      url: httpProxyUrl.value,
      username: httpProxyUsername.value || null,
      password: httpProxyPassword.value || null,
      excludeProfiles: httpProxyExcludeProfiles.value
    }
  })
  saved.value = true; setTimeout(() => saved.value = false, 1500)
}

async function saveProxySettings() {
  await saveSettings()
}

async function toggleLogging() {
  await api.setLogEnabled(logEnabled.value)
}

async function checkPortConflict() {
  const n = parseInt(port.value, 10)
  if (isNaN(n) || n < 1 || n > 65535) return
  portChecking.value = true
  try {
    const result = await api.checkPort(n)
    if (!result.available) {
      portConflict.value = { pid: result.pid, processName: result.process_name }
    } else {
      portConflict.value = null
    }
  } catch {
    portConflict.value = null
  } finally {
    portChecking.value = false
  }
}

async function killPortProcess() {
  if (!portConflict.value?.pid) {
    portConflict.value = null
    return
  }
  try {
    await api.killProcess(portConflict.value.pid)
    const n = parseInt(port.value, 10)
    const result = await api.checkPort(n)
    if (result.available) {
      portConflict.value = null
      copyMsg.value = t('settings.toast.portFreed', { port: n })
    } else {
      portConflict.value = null
    }
  } catch (e) {
    copyMsg.value = t('settings.toast.processKillFailed', { msg: String(e) })
    portConflict.value = null
  }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copyMsg.value = '' }, 2500)
}

function dismissPortConflict() {
  portConflict.value = null
}

async function onThemeChange() {
  setThemeSetting(themeSetting.value)
  try {
    const current = await api.getSettings()
    await api.setSettings({ ...current, theme: themeSetting.value })
  } catch (e) {
    console.error('Failed to save theme:', e)
  }
}

async function onLanguageChange() {
  const userChoice = languageSetting.value
  const resolved = resolveLocale(userChoice)
  try {
    await setLocale(resolved, { persist: true })
    if (userChoice === 'auto') {
      const current = await api.getSettings()
      await api.setSettings({ ...current, language: 'auto' })
    }
    copyMsg.value = t('settings.language.changed')
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copyMsg.value = '' }, 1500)
  } catch (e) {
    console.error('Failed to change language:', e)
    copyMsg.value = t('settings.language.changeFailed')
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copyMsg.value = '' }, 2500)
  }
}

const updateInfo = ref(null)
const checkingUpdate = ref(false)
const currentVersion = ref('')
const isDev = import.meta.env.DEV

async function checkForUpdates() {
  checkingUpdate.value = true
  try {
    const info = await api.checkForUpdates()
    updateInfo.value = info
    if (!isDev && info.has_update) {
      const ok = await showConfirm(t('settings.confirm.downloadUpdate', { version: info.latest_version }))
      if (ok) openUrl(info.download_url).catch(e => console.error('openUrl failed:', e))
    }
  } catch (e) {
    console.error('check_for_updates failed:', translateError(e))
  } finally {
    checkingUpdate.value = false
  }
}

function openDownloadPage() {
  if (updateInfo.value?.download_url) {
    openUrl(updateInfo.value.download_url).catch(e => console.error('openUrl failed:', e))
  }
}

function openGithub() {
  openUrl('https://github.com/IronManCantFix/AIGateway').catch(e => console.error('openUrl failed:', e))
}

onMounted(async () => {
  const [ , , version ] = await Promise.all([
    loadSettings(),
    loadProfiles(),
    api.getAppVersion()
  ])
  currentVersion.value = version

  unlistenProxySettings = await listen('proxy-settings-changed', async () => {
    await loadSettings()
  })
})

onUnmounted(() => {
  unlistenProxySettings?.()
})
</script>

<template>
  <div class="settings">
    <Transition name="fade">
      <div class="copy-toast" v-if="copyMsg">{{ copyMsg }}</div>
    </Transition>
    <div class="page-header">
      <h2>{{ $t('settings.title') }}</h2>
    </div>

    <!-- 通用设置 -->
    <div class="card">
      <div class="card-header"><h3>{{ $t('settings.section.general') }}</h3></div>
      <div class="card-body">
        <!-- 界面语言 -->
        <div class="setting-row">
          <div class="setting-label">{{ $t('settings.language.title') }}</div>
          <div class="setting-control">
            <select v-model="languageSetting" @change="onLanguageChange" class="lang-select">
              <option value="auto">{{ $t('settings.language.auto') }}</option>
              <option value="zh-CN">{{ $t('settings.language.zh-CN') }}</option>
              <option value="en-US">{{ $t('settings.language.en-US') }}</option>
            </select>
          </div>
        </div>

        <!-- 外观主题 -->
        <div class="setting-row">
          <div class="setting-label">外观</div>
          <div class="setting-control">
            <select v-model="themeSetting" @change="onThemeChange" class="lang-select">
              <option value="auto">跟随系统</option>
              <option value="dark">{{ $t('theme.dark') }}</option>
              <option value="light">{{ $t('theme.light') }}</option>
            </select>
          </div>
        </div>

        <!-- 代理端口 -->
        <div class="setting-row">
          <div class="setting-label">{{ $t('settings.section.proxyPort') }}</div>
          <div class="setting-control">
            <input class="port-input" v-model.number="port" type="number" min="1" max="65535" @change="saveSettings" />
            <button class="port-check-btn" @click="checkPortConflict" :disabled="portChecking">
              {{ portChecking ? '...' : '🔍' }}
            </button>
            <span class="saved" v-if="saved">&check; {{ $t('settings.label.saved') }}</span>
          </div>
        </div>
        <!-- 端口冲突提示 -->
        <div class="port-conflict-bar" v-if="portConflict">
          <span class="port-conflict-icon">⚠</span>
          <span class="port-conflict-text">
            {{ portConflict.processName
              ? $t('settings.confirm.portConflict', { port: port, process: portConflict.processName, pid: portConflict.pid })
              : $t('settings.confirm.portConflictUnknown', { port: port })
            }}
          </span>
          <button class="port-conflict-btn kill" @click="killPortProcess">{{ $t('common.ok') }}</button>
          <button class="port-conflict-btn cancel" @click="dismissPortConflict">{{ $t('common.cancel') }}</button>
        </div>

        <!-- HTTP 代理 -->
        <label class="setting-row toggle-row" @change="saveProxySettings">
          <div class="setting-label">{{ $t('settings.section.httpProxy') }}</div>
          <div class="setting-control">
            <input type="checkbox" v-model="httpProxyEnabled" />
          </div>
        </label>

        <div class="setting-nested" v-if="httpProxyEnabled">
          <div class="proxy-field">
            <label>{{ $t('settings.label.proxyAddress') }}</label>
            <input v-model="httpProxyUrl" placeholder="http://127.0.0.1:7890" @change="saveProxySettings" />
          </div>

          <div class="proxy-auth-toggle" @click="showProxyAuth = !showProxyAuth">
            {{ showProxyAuth ? $t('settings.label.hideAuth') : $t('settings.label.showAuth') }}
          </div>

          <div class="proxy-auth" v-if="showProxyAuth">
            <div class="proxy-field">
              <label>{{ $t('settings.label.username') }}</label>
              <input v-model="httpProxyUsername" :placeholder="$t('settings.placeholder.optional')" @change="saveProxySettings" />
            </div>
            <div class="proxy-field">
              <label>{{ $t('settings.label.password') }}</label>
              <input v-model="httpProxyPassword" type="password" :placeholder="$t('settings.placeholder.optional')" @change="saveProxySettings" />
            </div>
          </div>

          <div class="proxy-exclude" v-if="profiles.length > 0">
            <label>{{ $t('settings.label.excludeProviders') }}</label>
            <div class="exclude-list">
              <label v-for="p in profiles" :key="p.id" class="check-field exclude-item">
                <input type="checkbox"
                  :value="p.name"
                  v-model="httpProxyExcludeProfiles"
                  @change="saveProxySettings" />
                <span>{{ p.name }}</span>
              </label>
            </div>
          </div>
        </div>

        <!-- 自动启动 -->
        <label class="setting-row toggle-row" @change="saveSettings">
          <div class="setting-label">{{ $t('settings.label.autoStart') }}</div>
          <div class="setting-control">
            <input type="checkbox" v-model="autoStart" />
          </div>
        </label>

        <!-- 日志开关 -->
        <label class="setting-row toggle-row" @change="toggleLogging">
          <div class="setting-label">
            {{ $t('settings.label.logEnabled') }}
            <p class="field-hint">{{ $t('settings.label.logHint') }}</p>
          </div>
          <div class="setting-control">
            <input type="checkbox" v-model="logEnabled" />
          </div>
        </label>
      </div>
    </div>

    <!-- 关于 -->
    <div class="about">
      <img :src="iconUrl" class="about-logo" alt="AIGateway" />
      <p><strong>AIGateway</strong></p>
      <p class="about-version">
        {{ isDev ? $t('settings.label.devVersion') : (currentVersion || '...') }}
        <button class="check-update-btn" @click="checkForUpdates" :disabled="checkingUpdate">
          {{ checkingUpdate ? $t('settings.button.checking') : $t('settings.button.checkUpdate') }}
        </button>
        <button class="download-btn" v-if="updateInfo?.has_update && !isDev" @click="openDownloadPage">{{ $t('settings.button.download') }}</button>
      </p>
      <p class="about-update-hint" v-if="isDev && updateInfo">{{ $t('settings.label.latestRelease', { version: updateInfo.latest_version }) }}</p>
      <p class="about-update-hint" v-else-if="updateInfo?.has_update">{{ $t('settings.label.updateAvailable', { version: updateInfo.latest_version }) }}</p>
      <p class="about-update-hint up-to-date" v-else-if="updateInfo">{{ $t('settings.label.upToDate') }}</p>
      <p>{{ $t('settings.label.authors') }}</p>
      <p><span class="github-link" @click="openGithub"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg> GitHub</span></p>
    </div>
  </div>

  <!-- 确认弹窗 -->
  <Teleport to="body">
    <div class="confirm-overlay" v-if="confirmState.visible" @click.self="confirmCancel">
      <div class="confirm-dialog">
        <p class="confirm-msg">{{ confirmState.message }}</p>
        <div class="confirm-actions">
          <button class="confirm-cancel" @click="confirmCancel">{{ $t('common.cancel') }}</button>
          <button class="confirm-ok" @click="confirmOk">{{ $t('common.ok') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings { padding: 16px; max-width: 780px; margin: 0 auto; padding-bottom: 40px; }
.page-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.page-header h2 { font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 0; }
.card { margin-bottom: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); overflow: hidden; }
.card-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px 0; position: relative; z-index: 1; }
.card-header h3 { font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .8px; }
.card-body { padding: 12px 16px 16px; position: relative; z-index: 1; }
.field-row { display: flex; align-items: center; gap: 12px; }
.field-row input[type=number] { padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 15px; font-weight: 500; font-family: 'SF Mono','Fira Code',monospace; outline: none; width: 130px; transition: all .2s; background: var(--bg-input); color: var(--text-primary); }
.field-row input[type=number]:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.saved { font-size: 13px; color: var(--success); font-weight: 500; }
.lang-select { padding: 10px 36px 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 14px; color: var(--text-primary); background: var(--bg-input); outline: none; min-width: 180px; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%238b95b0' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; cursor: pointer; transition: all .2s; }
.lang-select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.check-field { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 14px; color: var(--text-secondary); }
.check-field input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); cursor: pointer; }
.field-hint { font-size: 12px; color: var(--text-muted); margin: 6px 0 0; }

.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--border-subtle); }
.setting-row:last-child { border-bottom: none; padding-bottom: 0; }
.setting-row:first-child { padding-top: 0; }
.setting-label { flex: 1; min-width: 0; font-size: 14px; color: var(--text-primary); font-weight: 500; }
.setting-label .field-hint { margin: 4px 0 0; font-weight: 400; }
.setting-control { flex-shrink: 0; display: flex; align-items: center; gap: 10px; }
.setting-control input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); cursor: pointer; }
label.toggle-row { cursor: pointer; margin: 0; }
.setting-nested { padding: 12px 0 14px; border-bottom: 1px solid var(--border-subtle); margin-top: -2px; }
.setting-nested:last-child { border-bottom: none; }
.port-input { padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; font-weight: 500; font-family: 'SF Mono','Fira Code',monospace; outline: none; width: 110px; background: var(--bg-input); color: var(--text-primary); transition: all .2s; }
.port-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.port-check-btn { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; font-size: 13px; cursor: pointer; transition: all .15s; line-height: 1; }
.port-check-btn:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--border-hover); }
.port-check-btn:disabled { opacity: .5; cursor: default; }
.port-conflict-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; margin-top: -2px; background: var(--warning-soft); border-bottom: 1px solid var(--border-subtle); border-radius: 0; font-size: 13px; }
.port-conflict-icon { font-size: 14px; color: var(--warning); flex-shrink: 0; }
.port-conflict-text { flex: 1; min-width: 0; color: var(--warning); font-size: 12px; }
.port-conflict-btn { padding: 4px 12px; border: none; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; transition: all .15s; }
.port-conflict-btn.kill { background: var(--danger); color: #fff; }
.port-conflict-btn.kill:hover { background: #ef4444; }
.port-conflict-btn.cancel { background: transparent; color: var(--text-secondary); border: 1px solid var(--border); }
.port-conflict-btn.cancel:hover { background: var(--accent-soft); }
.setting-control .lang-select { min-width: 160px; padding-top: 8px; padding-bottom: 8px; }

/* HTTP Proxy */
.proxy-field { margin-bottom: 12px; }
.proxy-field label { display: block; font-size: 13px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
.proxy-field input { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 14px; outline: none; transition: all .2s; background: var(--bg-input); color: var(--text-primary); }
.proxy-field input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.proxy-auth-toggle { font-size: 13px; color: var(--accent); cursor: pointer; margin-bottom: 12px; user-select: none; }
.proxy-auth-toggle:hover { text-decoration: underline; }
.proxy-exclude { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border-subtle); }
.proxy-exclude > label { display: block; font-size: 13px; font-weight: 600; color: var(--text-secondary); margin-bottom: 10px; }
.exclude-list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px 12px; }
.exclude-item { font-size: 13px; min-width: 0; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-input); transition: all .15s; }
.exclude-item:hover { border-color: var(--border-hover); background: var(--border-subtle); }
.exclude-item > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }

.about-version { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 13px; color: var(--text-muted); font-family: 'SF Mono',monospace; }
.about-update-hint { font-size: 12px; color: var(--accent); margin: -4px 0 0; }
.about-update-hint.up-to-date { color: var(--success); }
.check-update-btn { padding: 3px 10px; border: 1px solid var(--border); border-radius: 6px; background: transparent; font-size: 12px; color: var(--text-secondary); cursor: pointer; transition: all .15s; }
.check-update-btn:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--border-hover); }
.check-update-btn:disabled { opacity: .6; cursor: default; }
.download-btn { padding: 3px 10px; border: none; border-radius: 6px; background: var(--accent); font-size: 12px; color: #fff; font-weight: 500; cursor: pointer; transition: all .2s; }
.download-btn:hover { background: var(--accent-hover); box-shadow: var(--shadow-sm); }
.about { text-align: center; padding: 32px 16px; color: var(--text-muted); font-size: 13px; line-height: 1.8; }
.about-logo { width: 64px; height: 64px; margin-bottom: 8px; border-radius: 14px; }
.about strong { color: var(--text-secondary); }
.github-link { display: inline-flex; align-items: center; gap: 5px; color: var(--accent); text-decoration: none; vertical-align: middle; cursor: pointer; }
.github-link:hover { text-decoration: underline; }

.copy-toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 999; padding: 8px 20px; border-radius: var(--radius-md); font-size: 13px; font-weight: 500; color: var(--success); background: var(--success-soft); border: 1px solid rgba(52,211,153,.2); box-shadow: var(--shadow-md); pointer-events: none; }
.fade-enter-active { transition: all .25s cubic-bezier(.4,0,.2,1); }
.fade-leave-active { transition: all .2s cubic-bezier(.4,0,.2,1); }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* Confirm dialog */
.confirm-overlay { position: fixed; inset: 0; z-index: 9999; background: var(--bg-overlay); display: flex; align-items: center; justify-content: center; }
.confirm-dialog { background: var(--bg-card); border-radius: var(--radius-lg); border: 1px solid var(--border); padding: 28px 32px 20px; min-width: 320px; max-width: 420px; box-shadow: var(--shadow-lg); }
.confirm-msg { font-size: 15px; color: var(--text-primary); line-height: 1.6; margin: 0 0 24px; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
.confirm-cancel { padding: 8px 20px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; font-size: 14px; color: var(--text-secondary); cursor: pointer; transition: all .15s; }
.confirm-cancel:hover { background: var(--accent-soft); border-color: var(--border-hover); }
.confirm-ok { padding: 8px 20px; border: none; border-radius: var(--radius-sm); background: var(--danger); font-size: 14px; color: #fff; font-weight: 500; cursor: pointer; transition: all .15s; }
.confirm-ok:hover { background: #ef4444; box-shadow: 0 0 12px rgba(248,113,113,.3); }
</style>
