import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'

export const api = {
  // --- Proxy control ---
  startProxy: () => invoke('start_proxy'),
  stopProxy: () => invoke('stop_proxy'),
  getProxyStatus: () => invoke('get_proxy_status'),

  // --- Profile CRUD ---
  getProfiles: () => invoke('get_profiles'),
  addProfile: (profile) => invoke('add_profile', { profile }),
  updateProfile: (id, updates) => invoke('update_profile', { id, updates }),
  deleteProfile: (id) => invoke('delete_profile', { id }),

  // --- Active profiles ---
  getActiveProfiles: () => invoke('get_active_profiles'),
  setActiveProfiles: (ids) => invoke('set_active_profiles', { ids }),
  toggleProfile: (id, enabled) => invoke('toggle_profile', { id, enabled }),
  reorderProfiles: (orderedIds) => invoke('reorder_profiles', { orderedIds }),

  // --- Settings ---
  getSettings: () => invoke('get_settings'),
  setSettings: (settings) => invoke('set_settings', { settings }),

  // --- Models ---
  getModels: () => invoke('get_models'),
  addModel: (modelId) => invoke('add_model', { modelId }),
  removeModel: (modelId) => invoke('remove_model', { modelId }),

  // --- Model Mappings ---
  getModelMappings: () => invoke('get_model_mappings'),
  setModelMappings: (mappings) => invoke('set_model_mappings', { mappings }),

  // --- Stats & Logs ---
  getStats: () => invoke('get_stats'),
  getLogs: (limit) => invoke('get_logs', { limit }),
  clearLogs: () => invoke('clear_logs'),
  clearAllData: () => invoke('clear_all_data'),
  clearLogsBodies: () => invoke('clear_logs_bodies'),
  clearAggregatedStats: () => invoke('clear_aggregated_stats'),
  getLogEnabled: () => invoke('get_log_enabled'),
  setLogEnabled: (enabled) => invoke('set_log_enabled', { enabled }),

  // --- Clipboard (uses plugin directly) ---
  copyText: (text) => writeText(text),

  // --- Fetch provider models ---
  fetchProviderModels: (profile) => invoke('fetch_provider_models', { profile }),

  // --- Update check ---
  checkForUpdates: () => invoke('check_for_updates'),

  // --- Events ---
  onStatusChange: (fn) => {
    listen('proxy-status-changed', (event) => fn(event.payload))
  },
}
