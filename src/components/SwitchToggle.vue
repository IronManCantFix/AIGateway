<script setup>
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'change'])

function toggle() {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
  emit('change', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    class="switch-toggle"
    role="switch"
    :aria-checked="modelValue"
    :class="{ on: modelValue }"
    :disabled="disabled"
    @click.stop="toggle"
  >
    <span class="switch-knob"></span>
  </button>
</template>

<style scoped>
.switch-toggle {
  position: relative;
  width: 34px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-input);
  cursor: pointer;
  flex-shrink: 0;
  transition: background .18s ease-out, border-color .18s ease-out;
}
.switch-toggle:hover:not(:disabled) { border-color: var(--border-hover); }

.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: transform .18s ease-out, background .18s ease-out;
}

.switch-toggle.on {
  background: var(--accent);
  border-color: var(--accent);
}
.switch-toggle.on .switch-knob {
  transform: translateX(14px);
  background: #fff;
}

.switch-toggle:disabled {
  opacity: .4;
  cursor: not-allowed;
}
</style>
