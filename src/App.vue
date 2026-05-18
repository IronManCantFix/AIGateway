<script setup>
import { onMounted, ref, provide } from 'vue'
import { api } from './api.js'
import Home from './pages/Home/index.vue'
import ProfileEdit from './pages/ProfileEdit/index.vue'
import Settings from './pages/Settings/index.vue'

const route = ref('')
const pagePayload = ref(null)

function navigate(page, payload) {
  route.value = page
  pagePayload.value = payload ?? null
}

provide('navigate', navigate)
provide('pagePayload', pagePayload)

onMounted(async () => {
  navigate('gateway')

  try {
    const settings = await api.getSettings()
    const status = await api.getProxyStatus()
    if (settings.autoStart && status.status !== 'running') {
      await api.startProxy()
    }
  } catch (e) {
    console.error('Auto-start failed:', e)
  }
})
</script>

<template>
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
