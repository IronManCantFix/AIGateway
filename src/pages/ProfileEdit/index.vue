<script setup>
import { ref, onMounted, computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '../../api.js'
import { translateError } from '../../i18n/errorCodes.js'
import SelectMenu from '../../components/SelectMenu.vue'

const { t } = useI18n()
const navigate = inject('navigate')
const pagePayload = inject('pagePayload')

const isEdit = ref(false)
const editId = ref(null)

const PROVIDER_TYPES = ['openai-chat', 'openai-response', 'anthropic-message', 'openai-image', 'google-gemini', 'google-nano-banana', 'newapi']

const form = ref({
  name: '',
  providerType: 'openai-chat',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
  models: []
})

const showKey = ref(false)
const copied = ref(false)
const saving = ref(false)
const error = ref('')

const fetchingModels = ref(false)
const fetchedModels = ref([])
const showModelDropdown = ref(false)

// Available models (multi-select)
const availFetchingModels = ref(false)
const availFetchedModels = ref([])
const availShowPicker = ref(false)
const availPickerSelected = ref({})
const availSearch = ref('')
const newAvailModel = ref('')

const filteredAvailModels = computed(() => {
  const q = availSearch.value.trim().toLowerCase()
  if (!q) return availFetchedModels.value
  return availFetchedModels.value.filter(m => m.id.toLowerCase().includes(q))
})

const title = computed(() => isEdit.value ? t('profileEdit.title.edit') : t('profileEdit.title.add'))

async function loadProfile(id) {
  const profiles = await api.getProfiles()
  const p = profiles.find(p => p.id === id)
  if (p) {
    editId.value = p.id
    isEdit.value = true
    form.value = { ...p, models: p.models || [] }
  }
}

async function save() {
  error.value = ''
  if (!form.value.name.trim()) { error.value = t('profileEdit.message.nameRequired'); return }
  if (!form.value.baseUrl.trim()) { error.value = t('profileEdit.message.baseUrlRequired'); return }
  form.value.baseUrl = form.value.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  saving.value = true
  try {
    if (isEdit.value) {
      await api.updateProfile(editId.value, { ...form.value, models: [...form.value.models] })
    } else {
      await api.addProfile({ ...form.value, models: [...form.value.models] })
    }
    navigate('gateway')
  } catch (e) {
    console.error('Save failed:', e)
    error.value = translateError(e)
  } finally {
    saving.value = false
  }
}

async function copyKey() {
  if (!form.value.apiKey) return
  await api.copyText(form.value.apiKey)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}

function canFetchModels() {
  return form.value.providerType && form.value.baseUrl.trim() && form.value.apiKey.trim()
}

async function fetchModels() {
  if (!canFetchModels()) {
    error.value = t('profileEdit.message.fillRequiredFields')
    return
  }
  fetchingModels.value = true
  error.value = ''
  fetchedModels.value = []
  showModelDropdown.value = false
  try {
    const cleanForm = { ...form.value, baseUrl: form.value.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') }
    const models = await api.fetchProviderModels(cleanForm)
    if (models.length === 0) {
      error.value = t('profileEdit.message.emptyModelList')
      return
    }
    fetchedModels.value = models
    showModelDropdown.value = true
  } catch (e) {
    error.value = translateError(e)
  } finally {
    fetchingModels.value = false
  }
}

function selectModel(modelId) {
  form.value.defaultModel = modelId
  showModelDropdown.value = false
}

// --- Available models multi-select ---

async function fetchAvailModels() {
  if (!canFetchModels()) {
    error.value = t('profileEdit.message.fillRequiredFields')
    return
  }
  availFetchingModels.value = true
  error.value = ''
  try {
    const cleanForm = { ...form.value, baseUrl: form.value.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') }
    const models = await api.fetchProviderModels(cleanForm)
    if (models.length === 0) {
      error.value = t('profileEdit.message.emptyModelList')
      return
    }
    const existing = form.value.models || []
    availFetchedModels.value = models.map(id => ({ id, exists: existing.includes(id) }))
    availPickerSelected.value = {}
    for (const m of availFetchedModels.value) {
      availPickerSelected.value[m.id] = !m.exists
    }
    availShowPicker.value = true
  } catch (e) {
    error.value = translateError(e)
  } finally {
    availFetchingModels.value = false
  }
}

function selectAllAvail() {
  for (const m of filteredAvailModels.value) {
    if (!m.exists) availPickerSelected.value[m.id] = true
  }
}

function invertAvailSelection() {
  for (const m of filteredAvailModels.value) {
    if (!m.exists) availPickerSelected.value[m.id] = !availPickerSelected.value[m.id]
  }
}

function confirmAvailModels() {
  let added = 0
  const current = new Set(form.value.models || [])
  for (const m of availFetchedModels.value) {
    if (availPickerSelected.value[m.id] && !current.has(m.id)) {
      current.add(m.id)
      added++
    }
  }
  form.value.models = [...current]
  availShowPicker.value = false
}

function removeAvailModel(id) {
  form.value.models = (form.value.models || []).filter(m => m !== id)
}

function addAvailModel() {
  const id = newAvailModel.value.trim()
  if (!id) return
  const current = form.value.models || []
  if (!current.includes(id)) {
    form.value.models = [...current, id]
  }
  newAvailModel.value = ''
}

onMounted(() => {
  if (pagePayload.value && pagePayload.value.editId) {
    loadProfile(pagePayload.value.editId)
  }
})
</script>

<template>
  <div class="editor">
    <div class="page-header">
      <h2>{{ title }}</h2>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="fields">
          <div class="field">
            <label>{{ $t('profileEdit.label.name') }} <span class="req">*</span></label>
            <input v-model="form.name" type="text" :placeholder="$t('profileEdit.placeholder.name')" />
          </div>

          <div class="field">
            <label>{{ $t('profileEdit.label.providerType') }} <span class="req">*</span></label>
            <SelectMenu
              v-model="form.providerType"
              :options="PROVIDER_TYPES.map(pt => ({ value: pt, label: $t('profileEdit.providerType.' + pt) }))"
              :min-width="300"
            />
          </div>

          <div class="field">
            <label>{{ $t('profileEdit.label.baseUrl') }} <span class="req">*</span></label>
            <input v-model="form.baseUrl" type="text" :placeholder="$t('profileEdit.placeholder.baseUrl')" />
            <span class="hint">{{ $t('profileEdit.label.baseUrlHint') }}</span>
          </div>

          <div class="field">
            <label>{{ $t('profileEdit.label.apiKey') }} <span class="opt">{{ $t('profileEdit.label.optional') }}</span></label>
            <div class="key-row">
              <input v-model="form.apiKey" :type="showKey ? 'text' : 'password'" :placeholder="$t('profileEdit.placeholder.apiKey')" />
              <button type="button" class="toggle-key" @click="showKey = !showKey">
                {{ showKey ? $t('profileEdit.button.hide') : $t('profileEdit.button.show') }}
              </button>
              <button type="button" class="toggle-key" @click="copyKey" :disabled="!form.apiKey">
                {{ copied ? $t('profileEdit.label.copied') : $t('common.copy') }}
              </button>
            </div>
          </div>

          <div class="field">
            <label>{{ $t('profileEdit.label.defaultModel') }} <span class="opt">{{ $t('profileEdit.label.optional') }}</span></label>
            <div class="model-row">
              <input v-model="form.defaultModel" type="text" :placeholder="$t('profileEdit.placeholder.defaultModel')" />
              <button type="button" class="btn-fetch" :disabled="fetchingModels || !canFetchModels()" @click="fetchModels">
                {{ fetchingModels ? $t('profileEdit.button.fetching') : $t('profileEdit.button.fetchModels') }}
              </button>
            </div>
            <div class="model-dropdown" v-if="showModelDropdown && fetchedModels.length">
              <div class="model-option" v-for="m in fetchedModels" :key="m" @click="selectModel(m)">{{ m }}</div>
            </div>
          </div>

          <div class="field">
            <label>{{ $t('profileEdit.label.availableModels') }} <span class="opt">{{ $t('profileEdit.label.availableHint') }}</span></label>
            <div class="avail-chips" v-if="form.models && form.models.length > 0">
              <span v-for="m in form.models" :key="m" class="chip">
                {{ m }}
                <button class="chip-x" @click="removeAvailModel(m)">&times;</button>
              </span>
            </div>
            <div class="model-row">
              <input v-model="newAvailModel" type="text" :placeholder="$t('profileEdit.placeholder.addModel')" @keyup.enter="addAvailModel" />
              <button type="button" class="btn-fetch" :disabled="availFetchingModels || !canFetchModels()" @click="fetchAvailModels">
                {{ availFetchingModels ? $t('profileEdit.button.fetching') : $t('profileEdit.button.fetchModels') }}
              </button>
            </div>
          </div>

          <div class="error" v-if="error">{{ error }}</div>

          <div class="actions">
            <button type="button" class="btn-cancel" @click="navigate('gateway')">{{ $t('common.cancel') }}</button>
            <button type="button" class="btn-save" :disabled="saving" @click="save">
              {{ saving ? $t('profileEdit.button.saving') : $t('common.save') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Available Models Picker Modal -->
    <Transition name="modal">
      <div class="modal-overlay" v-if="availShowPicker" @click.self="availShowPicker = false">
        <div class="modal-card">
          <div class="modal-header">
            <h3>{{ $t('profileEdit.section.pickerTitle') }}</h3>
            <button class="modal-close" @click="availShowPicker = false">&times;</button>
          </div>
          <div class="modal-body">
            <div class="modal-search">
              <input v-model="availSearch" type="text" :placeholder="$t('profileEdit.placeholder.searchModels')" class="search-input" />
            </div>
            <div class="modal-actions">
              <button class="link-btn" @click="selectAllAvail">{{ $t('profileEdit.button.selectAll') }}</button>
              <button class="link-btn" @click="invertAvailSelection">{{ $t('profileEdit.button.invertSelection') }}</button>
            </div>
            <label v-for="m in filteredAvailModels" :key="m.id" class="modal-row" :class="{ disabled: m.exists }">
              <input type="checkbox" :checked="availPickerSelected[m.id]" :disabled="m.exists" @change="availPickerSelected[m.id] = $event.target.checked" />
              <span class="modal-model-id">{{ m.id }}</span>
              <span class="modal-tag" v-if="m.exists">{{ $t('profileEdit.label.added') }}</span>
            </label>
            <div class="modal-empty" v-if="filteredAvailModels.length === 0">{{ $t('profileEdit.message.noMatchingModels') }}</div>
          </div>
          <div class="modal-footer">
            <button class="act-btn" @click="availShowPicker = false">{{ $t('common.cancel') }}</button>
            <button class="btn-save" @click="confirmAvailModels">{{ $t('profileEdit.button.confirmAdd') }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.editor {
  padding: 16px;
  max-width: 780px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.page-header h2 {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}

.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
}

.card-body { padding: 20px; }

.fields {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.req { color: var(--danger); font-weight: 700; }
.opt { font-weight: 400; color: var(--text-muted); font-size: 12px; }
.hint { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

.field input,
.field select {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: 14px;
  outline: none;
  transition: all .2s;
  background: var(--bg-input);
  color: var(--text-primary);
}
.field input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.field .select-trigger {
  padding: 10px 28px 10px 14px;
  font-size: 14px;
  border-radius: var(--radius-md);
}

.key-row {
  display: flex;
  gap: 8px;
}
.key-row input { flex: 1; }

.toggle-key {
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition: all .15s;
}
.toggle-key:hover { background: var(--accent-soft); border-color: var(--border-hover); }
.toggle-key:disabled { opacity: .4; cursor: not-allowed; }

.model-row {
  display: flex;
  gap: 8px;
}
.model-row input { flex: 1; }

.btn-fetch {
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  font-size: 13px;
  color: var(--accent);
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: all .15s;
}
.btn-fetch:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); }
.btn-fetch:disabled { opacity: .4; cursor: not-allowed; }

.model-dropdown {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  margin-top: 2px;
}

.model-option {
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background .1s;
}
.model-option:hover { background: var(--accent-soft); color: var(--text-primary); }
.model-option + .model-option { border-top: 1px solid var(--border); }

.error {
  color: var(--danger);
  font-size: 13px;
  font-weight: 500;
}

.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}

.btn-cancel {
  padding: 10px 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all .15s;
}
.btn-cancel:hover { background: var(--accent-soft); border-color: var(--border-hover); }

.btn-save {
  padding: 10px 24px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all .2s;
}
.btn-save:hover { background: var(--accent-hover); box-shadow: var(--shadow-sm); }
.btn-save:disabled { opacity: .5; cursor: not-allowed; }

.avail-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.chip-x {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 14px;
  cursor: pointer;
  line-height: 1;
  padding: 0;
  transition: all .12s;
}
.chip-x:hover { background: var(--danger-soft); color: var(--danger); }

.link-btn {
  padding: 0;
  border: none;
  background: transparent;
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  cursor: pointer;
  transition: color .15s;
}
.link-btn:hover { color: var(--accent-hover); }

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal-card {
  width: calc(100% - 48px);
  max-width: 400px;
  max-height: 70vh;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  position: relative;
  z-index: 1;
}
.modal-header h3 {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}
.modal-close {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: var(--radius-sm);
  background: transparent; font-size: 20px; color: var(--text-muted);
  cursor: pointer; transition: all .15s;
}
.modal-close:hover { background: var(--accent-soft); color: var(--text-primary); }

.modal-body {
  padding: 8px 20px;
  overflow-y: auto;
  flex: 1;
  position: relative;
  z-index: 1;
}
.modal-search { margin-bottom: 8px; }
.search-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  outline: none;
  background: var(--bg-input);
  color: var(--text-primary);
  transition: all .15s;
}
.search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.modal-actions {
  display: flex; gap: 12px; margin-bottom: 4px;
}
.modal-empty {
  text-align: center; color: var(--text-muted); font-size: 13px; padding: 24px 0;
}
.modal-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.modal-row.disabled { cursor: not-allowed; opacity: .5; }
.modal-row input[type="checkbox"] {
  width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; flex-shrink: 0;
}
.modal-row.disabled input[type="checkbox"] { cursor: not-allowed; }
.modal-model-id {
  font-size: 13px; font-family: 'SF Mono', 'Fira Code', monospace; color: var(--text-secondary); flex: 1;
  word-break: break-all;
}
.modal-tag {
  font-size: 10px; padding: 2px 6px; border-radius: 4px;
  background: var(--warning-soft); color: var(--warning); font-weight: 600; flex-shrink: 0;
}
.modal-footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 14px 20px; border-top: 1px solid var(--border);
  position: relative; z-index: 1;
}
.modal-footer .btn-save {
  padding: 8px 18px;
  border: none; border-radius: var(--radius-sm);
  background: var(--accent); color: #fff;
  font-size: 13px; font-weight: 600; cursor: pointer;
  transition: all .2s;
}
.modal-footer .btn-save:hover { background: var(--accent-hover); box-shadow: var(--shadow-sm); }
.modal-footer .act-btn {
  padding: 8px 18px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary);
  font-size: 13px; cursor: pointer; transition: all .15s;
}
.modal-footer .act-btn:hover { background: var(--accent-soft); border-color: var(--border-hover); }

.modal-enter-active,
.modal-leave-active { transition: all .25s cubic-bezier(.4,0,.2,1); }
.modal-enter-from,
.modal-leave-to { opacity: 0; }
.modal-enter-from .modal-card { transform: scale(.95) translateY(8px); }
</style>
