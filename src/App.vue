<script setup>
import { onMounted, ref, provide } from 'vue'
import { api } from './api.js'
import Home from './pages/Home/index.vue'
import ProfileEdit from './pages/ProfileEdit/index.vue'
import Settings from './pages/Settings/index.vue'

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
    showBootToast('代理自动启动失败：' + msg)
    console.error('Auto-start failed:', e)
  }
})
</script>

<template>
  <Transition name="boot-fade">
    <div class="boot-toast" v-if="bootToast" @click="dismissBootToast" title="点击关闭">{{ bootToast }}</div>
  </Transition>
  <template v-if="route === 'gateway'">
    <Home />
  </template>
  <template v-else-if="route === 'gw-add'">
    <ProfileEdit />
  </template>
  <template v-else-if="route === 'gw-set'">
    <Settings />
  </template>
</template>

<style scoped>
.boot-toast {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 22px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 13px;
  font-weight: 500;
  border-radius: 10px;
  border: 1px solid #fecaca;
  white-space: pre-line;
  text-align: center;
  max-width: 420px;
  z-index: 9999;
  box-shadow: 0 8px 24px rgba(0,0,0,.12);
  cursor: pointer;
  user-select: none;
}
.boot-fade-enter-active { transition: all .2s ease-out; }
.boot-fade-leave-active { transition: all .25s ease-in; }
.boot-fade-enter-from,
.boot-fade-leave-to { opacity: 0; transform: translateX(-50%) translateY(-6px); }
</style>
