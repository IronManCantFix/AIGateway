<script setup>
import { computed, onMounted, ref, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from './api.js'
import Home from './pages/Home/index.vue'
import ProfileEdit from './pages/ProfileEdit/index.vue'
import Settings from './pages/Settings/index.vue'
import Stats from './pages/Stats/index.vue'
import Logs from './pages/Logs/index.vue'
import { theme, themeSetting, setThemeSetting, cycleTheme } from './theme.js'
import iconUrl from './assets/icon.png'

const { t } = useI18n()
const route = ref('')
const pagePayload = ref(null)
const bootToast = ref('')
let bootToastTimer = 0

function navigate(page, payload) {
  route.value = page
  pagePayload.value = payload ?? null
}

provide('navigate', navigate)
provide('pagePayload', pagePayload)
provide('theme', theme)
provide('themeSetting', themeSetting)
provide('setThemeSetting', setThemeSetting)
provide('cycleTheme', cycleTheme)

function showBootToast(msg) {
  bootToast.value = msg
  clearTimeout(bootToastTimer)
  bootToastTimer = setTimeout(() => { bootToast.value = '' }, 5000)
}
function dismissBootToast() {
  clearTimeout(bootToastTimer)
  bootToast.value = ''
}

onMounted(async () => {
  navigate('gateway')

  try {
    const settings = await api.getSettings()
    const status = await api.getProxyStatus()
    if (settings.autoStart && status.status !== 'running') {
      await api.startProxy()
    }
  } catch (e) {
    const msg = typeof e === 'string' ? e : (e?.message || JSON.stringify(e))
    showBootToast(t('app.bootError', { msg }))
    console.error('Auto-start failed:', e)
  }
})
</script>

<template>
  <!-- Top Navigation Bar -->
  <nav class="topbar">
    <div class="topbar-left">
      <template v-if="route === 'gw-add'">
        <button class="topbar-back" @click="navigate('gateway')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <span class="topbar-title">{{ $t('profileEdit.title.' + (pagePayload?.editId ? 'edit' : 'add')) }}</span>
      </template>
      <template v-else>
        <img :src="iconUrl" class="topbar-logo" alt="" />
        <span class="topbar-brand">AIGateway</span>
      </template>
    </div>
    <div class="topbar-tabs" v-if="route !== 'gw-add'">
      <button
        class="topbar-tab"
        :class="{ active: route === 'gateway' }"
        @click="navigate('gateway')"
      >{{ $t('nav.gateway') }}</button>
      <button
        class="topbar-tab"
        :class="{ active: route === 'gw-set' }"
        @click="navigate('gw-set')"
      >{{ $t('nav.settings') }}</button>
      <button
        class="topbar-tab"
        :class="{ active: route === 'gw-stats' }"
        @click="navigate('gw-stats')"
      >{{ $t('nav.stats') }}</button>
      <button
        class="topbar-tab"
        :class="{ active: route === 'gw-logs' }"
        @click="navigate('gw-logs')"
      >{{ $t('nav.logs') }}</button>
    </div>
    <div class="topbar-right">
      <button class="topbar-icon-btn" @click="cycleTheme" :title="theme === 'dark' ? $t('theme.light') : $t('theme.dark')">
        <svg v-if="theme === 'dark'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
    </div>
  </nav>

  <!-- Page Content (same structure as before, with top padding for fixed topbar) -->
  <Home v-if="route === 'gateway'" />
  <ProfileEdit v-else-if="route === 'gw-add'" />
  <Stats v-else-if="route === 'gw-stats'" />
  <Logs v-else-if="route === 'gw-logs'" />
  <Settings v-else-if="route === 'gw-set'" />
  <Home v-else />

  <!-- Boot Toast -->
  <Transition name="boot-fade">
    <div class="boot-toast" v-if="bootToast" @click="dismissBootToast" :title="$t('app.dismissTip')">{{ bootToast }}</div>
  </Transition>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  height: 44px;
  padding: 0 16px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 100;
  gap: 12px;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.topbar-logo {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  flex-shrink: 0;
}

.topbar-brand {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.topbar-back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.topbar-back:hover {
  background: var(--accent-soft);
  color: var(--text-accent);
}

.topbar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.topbar-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 12px;
}

.topbar-tab {
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-muted);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.topbar-tab:hover {
  color: var(--text-secondary);
  background: var(--tab-hover-bg);
}
.topbar-tab.active {
  color: var(--text-primary);
  background: var(--tab-active-bg);
  font-weight: 600;
}

.topbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

.topbar-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}
.topbar-icon-btn:hover {
  color: var(--text-secondary);
  background: var(--tab-hover-bg);
}

.boot-toast {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 22px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius-md);
  border: 1px solid var(--danger-soft);
  white-space: pre-line;
  text-align: center;
  max-width: 420px;
  z-index: 9999;
  box-shadow: var(--shadow-md);
  cursor: pointer;
  user-select: none;
}
.boot-fade-enter-active { transition: all .25s cubic-bezier(.4,0,.2,1); }
.boot-fade-leave-active { transition: all .2s cubic-bezier(.4,0,.2,1); }
.boot-fade-enter-from,
.boot-fade-leave-to { opacity: 0; transform: translateX(-50%) translateY(-8px); }
</style>
