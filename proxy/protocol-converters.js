// --- Reasoning Cache ---
// Cache reasoning_content by call_id so we can re-inject it when
// clients (like Codex) strip non-standard fields from function_call items.

let reasoningCache = null

function setReasoningCache(cache) {
  reasoningCache = cache
}

function getCachedReasoning(callId) {
  if (!reasoningCache || !callId) return null
  const val = reasoningCache.get(callId)
  if (val) {
    // Re-insert for LRU-like behavior (moves to end of Map iteration order)
    reasoningCache.delete(callId)
    reasoningCache.set(callId, val)
  }
  return val || null
}

// --- Converter Registry ---

const converters = {}

// 各目标格式接受的字段白名单。只透传白名单内的字段，
// 避免 CherryStudio 等客户端发出的 store/include/instructions 等
// 专有字段被透传到不认识它们的上游 API。

const TARGET_FIELDS = {
  chat_completions: ['model', 'stream', 'temperature', 'top_p', 'max_tokens', 'frequency_penalty', 'presence_penalty', 'stop', 'n', 'logprobs', 'top_logprobs', 'user', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls'],
  responses:        ['model', 'stream', 'temperature', 'top_p', 'max_output_tokens', 'store', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'text', 'previous_response_id', 'metadata', 'user'],
  messages:         ['model', 'stream', 'temperature', 'top_p', 'max_tokens', 'stop_sequences', 'top_k', 'system', 'messages', 'tools', 'tool_choice']
}

function pickFields(body, allowed) {
  const result = {}
  for (const f of allowed) {
    if (body[f] != null) result[f] = body[f]
  }
  return result
}

function parseMaybeJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function stringifyToolOutput(output) {
  if (typeof output === 'string') return output
  if (output == null) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function anthropicToolResultContent(output) {
  if (Array.isArray(output)) return output
  return stringifyToolOutput(output)
}

function extractReasoningText(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractReasoningText).filter(Boolean).join('')
  if (typeof value !== 'object') return ''

  const direct = value.reasoning_content || value.reasoning_text || value.thinking || value.text || value.content
  if (typeof direct === 'string') return direct
  if (Array.isArray(direct)) return extractReasoningText(direct)

  const summary = extractReasoningText(value.summary)
  if (summary) return summary

  const encrypted = value.encrypted_content
  if (typeof encrypted === 'string' && encrypted.startsWith('reasoning_content:')) {
    return encrypted.slice('reasoning_content:'.length)
  }

  return ''
}

function convertResponsesToResponses(body) {
  const result = pickFields(body, TARGET_FIELDS.responses)
  if (!Array.isArray(result.input)) return result

  let activeReasoning = ''
  result.input = result.input.map(item => {
    if (!item || typeof item !== 'object') return item

    if (item.type === 'reasoning') {
      activeReasoning = extractReasoningText(item)
      return null
    }

    if (!activeReasoning) return item

    if (item.type === 'message' || item.type === 'function_call') {
      const role = item.role || (item.type === 'function_call' ? 'assistant' : 'user')
      if (role === 'assistant') {
        return {
          ...item,
          reasoning_content: item.reasoning_content || activeReasoning,
          metadata: {
            ...(item.metadata || {}),
            _reasoning_content: item.metadata?._reasoning_content || activeReasoning
          }
        }
      }
    }

    if (item.type === 'message' && (item.role === 'user' || item.role === 'developer' || item.role === 'system')) {
      activeReasoning = ''
    }

    return item
  }).filter(Boolean)

  return result
}

// === Body Converters ===

function extractSystemContent(msg) {
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content.filter(c => c.type === 'text' || c.type === 'input_text').map(c => c.text).join('\n')
  }
  return ''
}

function extractThinkingContent(msg) {
  if (!msg) return ''
  if (typeof msg.reasoning_content === 'string') return msg.reasoning_content
  if (!Array.isArray(msg.content)) return ''
  return msg.content.filter(c => c.type === 'thinking').map(c => c.thinking || '').join('')
}

function convertChatToMessages(body) {
  const { messages, ...rest } = body
  const systemMsg = messages.find(m => m.role === 'system')
  const nonSystem = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const content = []
        if (m.content) {
          content.push({ type: 'text', text: typeof m.content === 'string' ? m.content : '' })
        }
        for (const toolCall of m.tool_calls) {
          if (toolCall.type === 'function') {
            content.push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.function?.name || '',
              input: parseMaybeJson(toolCall.function?.arguments, {})
            })
          }
        }
        return { role: 'assistant', content }
      }
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: anthropicToolResultContent(m.content)
          }]
        }
      }
      return m
    })
  const result = pickFields(rest, TARGET_FIELDS.messages)
  result.messages = nonSystem
  if (systemMsg) result.system = extractSystemContent(systemMsg)
  return result
}

function convertMessagesToChat(body) {
  const { messages, system, ...rest } = body
  const result = pickFields(rest, TARGET_FIELDS.chat_completions)
  // Convert message content: Anthropic content blocks → OpenAI string
  // Anthropic: content: [{type: "text", text: "..."}] or content: "..."
  // OpenAI:    content: "..." (string) or content: [{type: "text", text: "..."}] (for vision)
  result.messages = messages.flatMap(m => {
    if (typeof m.content === 'string') return m
    if (!Array.isArray(m.content)) return m
    const thinking = extractThinkingContent(m)
    const toolUseBlocks = m.content.filter(c => c.type === 'tool_use')
    if (toolUseBlocks.length > 0) {
      const text = m.content.filter(c => c.type === 'text').map(c => c.text || '').join('')
      const msg = {
        role: 'assistant',
        content: text || null,
        tool_calls: toolUseBlocks.map(c => ({
          id: c.id,
          type: 'function',
          function: {
            name: c.name || '',
            arguments: JSON.stringify(c.input || {})
          }
        }))
      }
      if (thinking) msg.reasoning_content = thinking
      return msg
    }
    const toolResultBlocks = m.content.filter(c => c.type === 'tool_result')
    if (toolResultBlocks.length > 0) {
      const toolMessages = toolResultBlocks.map(block => ({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: stringifyToolOutput(block.content)
      }))
      const text = m.content.filter(c => c.type === 'text').map(c => c.text || '').join('')
      return text ? [...toolMessages, { role: 'user', content: text }] : toolMessages
    }
    // Check if any non-text content blocks exist (images, etc.)
    const hasNonText = m.content.some(c => c.type === 'image' || c.type === 'image_url' || c.type === 'source')
    if (hasNonText) {
      // Convert to OpenAI vision format: [{type: "text", text: "..."}, {type: "image_url", ...}]
      const converted = m.content.map(c => {
        if (c.type === 'text') return { type: 'text', text: c.text || '' }
        if (c.type === 'image') {
          // Anthropic image: {type: "image", source: {type: "base64"|"url", ...}}
          if (c.source?.type === 'url') {
            return { type: 'image_url', image_url: { url: c.source.url } }
          }
          if (c.source?.type === 'base64') {
            return { type: 'image_url', image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } }
          }
        }
        return c
      })
      return { ...m, content: converted }
    }
    // Text-only: flatten to string
    const text = m.content.filter(c => c.type === 'text').map(c => c.text || '').join('')
    const msg = { ...m, content: text }
    if (thinking) msg.reasoning_content = thinking
    return msg
  })
  // Convert system field (can be string or content block array)
  if (system) {
    result.messages.unshift({ role: 'system', content: extractSystemContent({ content: system }) })
  }
  // Convert tools from Anthropic Messages format to Chat Completions format
  // Anthropic: { name, description, input_schema }
  // Chat:      { type: "function", function: { name, description, parameters } }
  if (Array.isArray(result.tools)) {
    result.tools = result.tools.map(t => {
      if (t.name && !t.type) {
        const func = { name: t.name }
        if (t.description) func.description = t.description
        if (t.input_schema) func.parameters = t.input_schema
        return { type: 'function', function: func }
      }
      return t
    })
  }
  return result
}

function convertChatToResponses(body) {
  const { messages, ...rest } = body
  const result = pickFields(rest, TARGET_FIELDS.responses)
  result.input = messages.flatMap(m => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const items = []
      if (m.content) {
        items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof m.content === 'string' ? m.content : '' }] })
      }
      for (const toolCall of m.tool_calls) {
        if (toolCall.type === 'function') {
          items.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.function?.name || '',
            arguments: toolCall.function?.arguments || ''
          })
        }
      }
      return items
    }
    if (m.role === 'tool') {
      return [{
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: m.content
      }]
    }
    return [m]
  })
  // Convert tools from Chat Completions format to Responses format
  // Chat: { type: "function", function: { name, parameters, ... } }
  // Responses: { type: "function", name, parameters, ... }
  if (Array.isArray(rest.tools)) {
    result.tools = rest.tools.map(t => {
      if (t.type === 'function' && t.function) {
        const func = t.function
        const res = { type: 'function', name: func.name }
        if (func.parameters) res.parameters = func.parameters
        if (func.description) res.description = func.description
        if (func.strict != null) res.strict = func.strict
        return res
      }
      return t
    })
  }
  return result
}

function convertResponsesToChat(body) {
  const { input, instructions, ...rest } = body
  const result = pickFields(rest, TARGET_FIELDS.chat_completions)
  if (rest.max_output_tokens != null) result.max_tokens = rest.max_output_tokens
  // Convert input: can be a string or an array
  let messages = []
  if (typeof input === 'string') {
    messages = [{ role: 'user', content: input }]
  } else if (Array.isArray(input)) {
    let activeReasoning = ''
    // Phase 1: map each input item to a Chat Completions message
    const raw = input.map(m => {
      if (m.type === 'reasoning') {
        activeReasoning = extractReasoningText(m)
        return null
      }
      if (m.type === 'function_call_output') {
        return {
          role: 'tool',
          tool_call_id: m.call_id,
          content: typeof m.output === 'string' ? m.output : JSON.stringify(m.output ?? '')
        }
      }
      if (m.type === 'function_call') {
        // Restore reasoning_content from multiple sources:
        // 1. Direct field on the item
        // 2. metadata._reasoning_content (set by chatToResponsesSSEFactory)
        // 3. activeReasoning (from preceding reasoning-type items)
        // 4. reasoningCache (proxy-side cache, handles clients that strip non-standard fields)
        const cached = getCachedReasoning(m.call_id)
        const reasoning = m.reasoning_content || m.metadata?._reasoning_content || activeReasoning || cached
        if (!reasoning) {
          // function_call item missing reasoning_content
        }
        const msg = {
          role: 'assistant',
          content: null,
          reasoning_content: reasoning || '',
          tool_calls: [{
            id: m.call_id || m.id,
            type: 'function',
            function: { name: m.name, arguments: m.arguments || '' }
          }]
        }
        return msg
      }
      if (m.type === 'message') {
        m = { ...m, role: m.role || 'user', content: m.content }
      }
      const role = m.role === 'developer' ? 'system' : m.role
      // Restore reasoning_content from multiple sources:
      // 1. Direct field on the message item
      // 2. Metadata._reasoning_content (set by chatToResponsesSSEFactory)
      // 3. activeReasoning (from preceding reasoning-type items)
      // 4. reasoningCache (proxy-side cache, handles clients that strip non-standard fields)
      const cached = getCachedReasoning(m.call_id)
      const reasoningFromMeta = m.reasoning_content || m.metadata?._reasoning_content || (role === 'assistant' ? activeReasoning : '') || cached
      if (role === 'assistant' && !reasoningFromMeta && (m.content || m.tool_calls)) {
        // assistant message missing reasoning_content
      }
      if (m.content && Array.isArray(m.content)) {
        const text = m.content
          .filter(c => c.type === 'input_text' || c.type === 'output_text' || c.type === 'text')
          .map(c => c.text || '')
          .join('')
        const msg = { role, content: text }
        if (role === 'assistant' && reasoningFromMeta) msg.reasoning_content = reasoningFromMeta
        if (role === 'user' || role === 'system') activeReasoning = ''
        return msg
      }
      const msg = { role, content: m.content }
      if (role === 'assistant' && reasoningFromMeta) msg.reasoning_content = reasoningFromMeta
      if (role === 'user' || role === 'system') activeReasoning = ''
      return msg
    }).filter(m => m?.role)

    // Phase 2: merge consecutive assistant messages (produced when a single Chat assistant
    // message with both reasoning+content and tool_calls was split into a message item
    // and function_call items during Responses conversion).
    messages = []
    for (const m of raw) {
      if (m.role === 'assistant' && messages.length > 0) {
        const prev = messages[messages.length - 1]
        if (prev.role === 'assistant') {
          // Merge tool_calls
          if (m.tool_calls) {
            prev.tool_calls = [...(prev.tool_calls || []), ...m.tool_calls]
          }
          // Preserve reasoning_content from whichever message has it
          if (m.reasoning_content && !prev.reasoning_content) {
            prev.reasoning_content = m.reasoning_content
          }
          // Preserve content if prev had none
          if (m.content != null && (prev.content == null || prev.content === '')) {
            prev.content = m.content
          }
          continue
        }
      }
      messages.push(m)
    }
  }
  // Log reasoning_content injection stats for debugging
  const reasoningMsgs = messages.filter(m => m.reasoning_content)

  // Extract system messages — some providers (e.g. MiniMax) don't support
  // system role in messages array and need it in the top-level 'system' field
  const systemMessages = messages.filter(m => m.role === 'system')
  const nonSystemMessages = messages.filter(m => m.role !== 'system')
  result.messages = nonSystemMessages

  // Combine instructions and system messages into a single system field
  const systemParts = []
  if (instructions) systemParts.push(instructions)
  for (const m of systemMessages) {
    if (m.content) systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
  }
  if (systemParts.length > 0) {
    result.system = systemParts.join('\n\n')
  }
  // Convert tools from Responses format to Chat Completions format
  // Responses: { type: "function", name, parameters, ... }
  // Chat: { type: "function", function: { name, parameters, ... } }
  // Skip tools with unsupported types (e.g. "custom")
  if (Array.isArray(rest.tools)) {
    result.tools = rest.tools
      .filter(t => t.type === 'function')
      .map(t => {
        const { name, parameters, strict, description, ...extra } = t
        const func = { name, parameters }
        if (strict != null) func.strict = strict
        if (description) func.description = description
        return { type: 'function', function: func }
      })
    if (result.tools.length === 0) delete result.tools
  }
  return result
}

function convertMessagesToResponses(body) {
  const { messages, system, ...rest } = body
  // Convert message content: Anthropic content blocks → Responses input format
  const input = messages.flatMap(m => {
    if (typeof m.content === 'string') return [m]
    if (!Array.isArray(m.content)) return [m]
    const toolUseBlocks = m.content.filter(c => c.type === 'tool_use')
    if (toolUseBlocks.length > 0) {
      const items = []
      const text = m.content.filter(c => c.type === 'text').map(c => c.text || '').join('')
      if (text) {
        items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      }
      for (const block of toolUseBlocks) {
        items.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name || '',
          arguments: JSON.stringify(block.input || {})
        })
      }
      return items
    }
    const toolResultBlocks = m.content.filter(c => c.type === 'tool_result')
    if (toolResultBlocks.length > 0) {
      return toolResultBlocks.map(block => ({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: block.content
      }))
    }
    // Flatten text content blocks to string
    const text = m.content.filter(c => c.type === 'text').map(c => c.text || '').join('')
    return [{ ...m, content: text }]
  })
  if (system) {
    input.unshift({ role: 'system', content: extractSystemContent({ content: system }) })
  }
  const result = pickFields(rest, TARGET_FIELDS.responses)
  result.input = input
  // Convert tools from Anthropic Messages format to Responses format
  // Anthropic:  { name, description, input_schema }
  // Responses:  { type: "function", name, parameters, description }
  if (Array.isArray(result.tools)) {
    result.tools = result.tools.map(t => {
      if (t.name && !t.type) {
        const res = { type: 'function', name: t.name }
        if (t.description) res.description = t.description
        if (t.input_schema) res.parameters = t.input_schema
        return res
      }
      return t
    })
  }
  return result
}

function flattenResponsesMessageContent(content) {
  if (!Array.isArray(content)) return content
  const flattenable = content.every(c =>
    c.type === 'input_text' ||
    c.type === 'output_text' ||
    c.type === 'text'
  )
  if (!flattenable) return content
  return content.map(c => c.text || '').join('')
}

function convertResponsesToMessages(body) {
  const { input, instructions, ...rest } = body
  // Convert input: can be a string or an array
  let msgs = []
  if (typeof input === 'string') {
    msgs = [{ role: 'user', content: input }]
  } else if (Array.isArray(input)) {
    msgs = input.map(m => {
      if (m.type === 'function_call_output') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.call_id, content: typeof m.output === 'string' ? m.output : JSON.stringify(m.output ?? '') }]
        }
      }
      if (m.type === 'function_call') {
        return {
          role: 'assistant',
          content: [{ type: 'tool_use', id: m.call_id || m.id, name: m.name, input: parseMaybeJson(m.arguments, {}) }]
        }
      }
      if (m.type === 'message') {
        return { role: m.role, content: flattenResponsesMessageContent(m.content) }
      }
      return m
    })
  }
  const systemMsg = msgs.find(m => m.role === 'system' || m.role === 'developer')
  const nonSystem = msgs.filter(m => m.role !== 'system' && m.role !== 'developer')
  const result = pickFields(rest, TARGET_FIELDS.messages)
  if (rest.max_output_tokens != null) result.max_tokens = rest.max_output_tokens
  result.messages = nonSystem
  if (systemMsg) result.system = extractSystemContent(systemMsg)
  else if (instructions) result.system = instructions
  return result
}



// Register body converters
converters['responses->responses']          = { body: convertResponsesToResponses }
converters['chat_completions->messages']   = { body: convertChatToMessages }
converters['chat_completions->responses']  = { body: convertChatToResponses }
converters['messages->chat_completions']   = { body: convertMessagesToChat }
converters['messages->responses']          = { body: convertMessagesToResponses }
converters['responses->chat_completions']  = { body: convertResponsesToChat }
converters['responses->messages']          = { body: convertResponsesToMessages }

// === SSE Helpers ===

function counter() {
  return () => {
    counter._id = (counter._id || 0) + 1
    return 'evt-' + Date.now() + '-' + counter._id
  }
}

function fmtAnthropicSSE(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function fmtOpenAISSE(data) {
  return `data: ${JSON.stringify(data)}\n\n`
}

function fmtResponsesSSE(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function fmtResponseEvent(event, responseId, data) {
  return fmtResponsesSSE(event, { type: event, response_id: responseId, ...data })
}

function mapFinishReason(reason) {
  const map = { 'stop': 'end_turn', 'length': 'max_tokens', 'tool_calls': 'tool_use' }
  return map[reason] || reason
}

// === SSE Converters (factory functions — each returns (line) => string) ===

function chatToMessagesSSEFactory() {
  let started = false
  let thinkingStarted = false
  let thinkingClosed = false
  let textStarted = false
  let completed = false
  let messageId = 'msg_' + Date.now()
  let model = ''
  let outputTokens = 0
  let lastReasoning = ''
  let isCumulativeReasoning = false
  const toolCalls = new Map()
  let contentBlockIndex = 0
  let textBlockIndex = 0

  function ensureStarted(choice) {
    if (started) return ''
    started = true
    const role = choice?.delta?.role || choice?.message?.role || 'assistant'
    return fmtAnthropicSSE('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role, model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
  }

  function startThinking() {
    if (thinkingStarted) return ''
    thinkingStarted = true
    const idx = contentBlockIndex++
    return fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } })
  }

  function closeThinking() {
    if (!thinkingStarted || thinkingClosed) return ''
    thinkingClosed = true
    return fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: 0 })
  }

  function startText() {
    if (textStarted) return ''
    textStarted = true
    textBlockIndex = contentBlockIndex++
    return fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } })
  }

  const convert = (line) => {
    if (!line.startsWith('data: ')) return ''
    if (line.startsWith('data: [DONE]')) return ''
    // Skip all chunks after message is complete (MiniMax sends duplicate finish chunks)
    if (completed) return ''

    try {
      const data = JSON.parse(line.slice(6))
      const choice = data.choices?.[0]
      if (!choice) return ''

      if (data.model) model = data.model

      // Support both delta (streaming) and message (non-streaming final chunk) formats
      const delta = choice.delta || choice.message || {}
      const content = delta.content
      const rawReasoning = delta.reasoning_content
      const finishReason = choice.finish_reason

      // reasoning_content: auto-detect cumulative vs incremental
      // MiniMax: incremental in delta chunks, cumulative in final message chunk
      // DeepSeek: always incremental
      // Also handle reasoning_details format (MiniMax reasoning_split=true)
      // Normalize: coerce non-string reasoning_content to string
      let normalizedReasoning = rawReasoning
      if (rawReasoning != null && typeof rawReasoning !== 'string') {
        normalizedReasoning = typeof rawReasoning === 'object' ? JSON.stringify(rawReasoning) : String(rawReasoning)
      }
      let reasoning = ''
      let hasReasoning = false
      if (normalizedReasoning != null && typeof normalizedReasoning === 'string' && normalizedReasoning.length > 0) {
        hasReasoning = true
        if (isCumulativeReasoning) {
          // Already detected cumulative mode: extract delta
          if (normalizedReasoning.length > lastReasoning.length && normalizedReasoning.startsWith(lastReasoning)) {
            reasoning = normalizedReasoning.substring(lastReasoning.length)
          }
          lastReasoning = normalizedReasoning
        } else if (lastReasoning.length > 0 && normalizedReasoning.length > lastReasoning.length && normalizedReasoning.startsWith(lastReasoning)) {
          // Cumulative detected (only when lastReasoning is non-empty to avoid false positive on first chunk)
          isCumulativeReasoning = true
          reasoning = normalizedReasoning.substring(lastReasoning.length)
          lastReasoning = normalizedReasoning
        } else if (normalizedReasoning !== lastReasoning) {
          // Incremental: use as-is
          reasoning = normalizedReasoning
          lastReasoning = normalizedReasoning
        }
      } else if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
        hasReasoning = true
        const cur = delta.reasoning_details.map(d => d.text || '').join('')
        if (isCumulativeReasoning) {
          if (cur.length > lastReasoning.length && cur.startsWith(lastReasoning)) {
            reasoning = cur.substring(lastReasoning.length)
          }
          lastReasoning = cur
        } else if (lastReasoning.length > 0 && cur.length > lastReasoning.length && cur.startsWith(lastReasoning)) {
          isCumulativeReasoning = true
          reasoning = cur.substring(lastReasoning.length)
          lastReasoning = cur
        } else if (cur !== lastReasoning) {
          reasoning = cur
          lastReasoning = cur
        }
      }

      // Update token counts if available
      if (data.usage?.completion_tokens) outputTokens = data.usage.completion_tokens

      let out = ''

      // Emit message_start on first chunk
      out += ensureStarted(choice)

      // Handle reasoning content → thinking block
      if (hasReasoning) {
        out += startThinking()
      }
      if (reasoning) {
        out += fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: reasoning } })
      }

      // Update output tokens if available
      if (data.usage?.completion_tokens) outputTokens = data.usage.completion_tokens

      // Handle tool_calls → tool_use content blocks
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const key = tc.index ?? tc.id ?? toolCalls.size
          let tool = toolCalls.get(key)
          if (!tool) {
            out += ensureStarted(choice)
            out += closeThinking()
            const idx = contentBlockIndex++
            tool = { name: tc.function?.name || '', partialJson: '', index: idx, done: false }
            toolCalls.set(key, tool)
            out += fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id || `toolu_${Date.now()}_${key}`, name: tool.name, input: {} } })
          }
          if (tc.function?.name) tool.name += tc.function.name
          if (tc.function?.arguments) tool.partialJson += tc.function.arguments
          if (tc.function?.arguments) {
            out += fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } })
          }
        }
      }

      // Handle text content → text block
      if (content != null && typeof content === 'string' && content !== '') {
        out += closeThinking()
        out += startText()
        out += fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: content } })
      }

      // Handle finish
      if (finishReason) {
        out += closeThinking()
        if (!textStarted && toolCalls.size === 0) out += startText()
        if (textStarted) {
          out += fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: textBlockIndex })
        }
        for (const tool of toolCalls.values()) {
          if (!tool.done) {
            tool.done = true
            out += fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: tool.index })
          }
        }
        out += fmtAnthropicSSE('message_delta', { type: 'message_delta', delta: { stop_reason: mapFinishReason(finishReason) }, usage: { output_tokens: outputTokens } })
        out += fmtAnthropicSSE('message_stop', { type: 'message_stop' })
        completed = true
      }

      return out
    } catch {
      return ''
    }
  }

  convert.flush = () => {
    if (!started || completed) return ''
    let out = ''
    out += closeThinking()
    if (!textStarted && toolCalls.size === 0) out += startText()
    if (textStarted) {
      out += fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: textBlockIndex })
    }
    for (const tool of toolCalls.values()) {
      if (!tool.done) {
        tool.done = true
        out += fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: tool.index })
      }
    }
    out += fmtAnthropicSSE('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })
    out += fmtAnthropicSSE('message_stop', { type: 'message_stop' })
    completed = true
    return out
  }

  return convert
}

function messagesToChatSSEFactory() {
  let chatId = 'chatcmpl-' + Date.now()
  let model = ''
  const toolCalls = new Map()

  return (line) => {
    if (!line.trim()) return ''

    try {
      if (line.startsWith('event: ')) return ''

      if (!line.startsWith('data: ')) return ''
      const data = JSON.parse(line.slice(6))

      if (data.type === 'message_start') {
        model = data.message?.model || model
        chatId = 'chatcmpl-' + Date.now()
        return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      }

      if (data.type === 'content_block_start') {
        if (data.content_block?.type === 'tool_use') {
          const tool = {
            index: toolCalls.size,
            id: data.content_block.id || `call_${Date.now()}_${data.index}`,
            name: data.content_block.name || '',
            arguments: '',
            done: false
          }
          toolCalls.set(data.index, tool)
          return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { tool_calls: [{ index: tool.index, id: tool.id, type: 'function', function: { name: tool.name, arguments: '' } }] }, finish_reason: null }] })
        }
        return ''
      }

      if (data.type === 'content_block_delta') {
        // Map thinking_delta to reasoning_content for clients that support it
        if (data.delta?.type === 'thinking_delta') {
          return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { reasoning_content: data.delta.thinking || '' }, finish_reason: null }] })
        }
        // Handle tool_use input_json_delta
        if (data.delta?.type === 'input_json_delta') {
          const tool = toolCalls.get(data.index)
          if (tool && data.delta.partial_json) {
            tool.arguments += data.delta.partial_json
            return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { tool_calls: [{ index: tool.index, function: { arguments: data.delta.partial_json } }] }, finish_reason: null }] })
          }
          return ''
        }
        const text = data.delta?.text || ''
        return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
      }

      if (data.type === 'content_block_stop') {
        return ''
      }

      if (data.type === 'message_delta') {
        const reason = data.delta?.stop_reason
        const reverseFinish = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop' }
        return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: {}, finish_reason: reverseFinish[reason] || reason }] })
      }

      if (data.type === 'message_stop') {
        return 'data: [DONE]\n\n'
      }

      return ''
    } catch {
      return ''
    }
  }
}

function chatToResponsesSSEFactory() {
  let responseId = 'resp_' + Date.now()
  let itemId = 'msg_' + Date.now()
  let model = ''
  let started = false
  let completed = false
  let fullText = ''
  let fullReasoning = ''
  let inputTokens = 0
  const toolCalls = new Map()
  const outputItems = []
  let textOutputIndex = null
  // State for stripping <think> tags from content
  let inThinking = false

  function makeResponse(overrides) {
    return Object.assign({
      id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress', error: null, incomplete_details: null,
      instructions: null, max_output_tokens: null, model,
      output: [], parallel_tool_calls: true, previous_response_id: null,
      reasoning: { effort: null, summary: null }, store: true, temperature: 1.0,
      text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [],
      top_p: 1.0, truncation: 'disabled', usage: null, user: null, metadata: {}
    }, overrides)
  }

  function finishResponses(inputTokens) {
    const outputTokens = 0
    let out = ''

    // Detect empty upstream response (model received input but produced no content)
    if (!fullText && toolCalls.size === 0 && inputTokens > 0) {
      fullText = `[Error] Upstream model returned empty response (input_tokens: ${inputTokens}, output_tokens: 0). This may indicate the prompt is too long, the model failed to generate content, or the request was rejected by the upstream provider.`
    }

    if (fullText || (textOutputIndex == null && toolCalls.size === 0)) {
      // Always ensure at least one message output item
      const text = fullText || ''
      const messageItem = {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
        ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
        ...(fullReasoning ? { metadata: { _reasoning_content: fullReasoning } } : {})
      }
      const outputIndex = textOutputIndex ?? outputItems.length
      if (textOutputIndex == null) {
        // No text was started — emit the full item lifecycle
        out += fmtResponsesSSE('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
        out += fmtResponsesSSE('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      }
      out += fmtResponsesSSE('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: outputIndex, content_index: 0, text })
      out += fmtResponsesSSE('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text, annotations: [] } })
      out += fmtResponsesSSE('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: messageItem })
      outputItems[outputIndex] = messageItem
    }
    for (const tool of toolCalls.values()) {
      if (tool.done) continue
      tool.done = true
      const item = {
        id: tool.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: tool.callId,
        name: tool.name || '',
        arguments: tool.arguments || '',
        ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
        ...(fullReasoning ? { metadata: { _reasoning_content: fullReasoning } } : {})
      }
      // Cache reasoning by call_id for re-injection when client echoes back stripped function_call items
      if (fullReasoning && tool.callId && reasoningCache) {
        reasoningCache.set(tool.callId, fullReasoning)
      }
      out += fmtResponseEvent('response.function_call_arguments.done', responseId, { item_id: tool.itemId, output_index: tool.outputIndex, call_id: tool.callId, name: tool.name || '', arguments: tool.arguments || '' })
      out += fmtResponsesSSE('response.output_item.done', { type: 'response.output_item.done', output_index: tool.outputIndex, item })
      outputItems[tool.outputIndex] = item
    }
    out += fmtResponsesSSE('response.completed', { type: 'response.completed', response: makeResponse({ status: 'completed', output: outputItems.filter(Boolean), usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }) })
    return out
  }

  function ensureStarted() {
    if (started) return ''
    started = true
    let out = ''
    out += fmtResponsesSSE('response.created', { type: 'response.created', response: makeResponse({ status: 'in_progress' }) })
    out += fmtResponsesSSE('response.in_progress', { type: 'response.in_progress', response: makeResponse({ status: 'in_progress' }) })
    return out
  }

  function ensureTextStarted() {
    let out = ensureStarted()
    if (textOutputIndex != null) return out
    textOutputIndex = outputItems.length
    outputItems[textOutputIndex] = { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    out += fmtResponsesSSE('response.output_item.added', { type: 'response.output_item.added', output_index: textOutputIndex, item: outputItems[textOutputIndex] })
    out += fmtResponsesSSE('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: textOutputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    return out
  }

  function handleToolCallDelta(toolDelta, fallbackIndex) {
    const key = toolDelta.index ?? fallbackIndex ?? toolDelta.id ?? toolCalls.size
    let tool = toolCalls.get(key)
    let out = ensureStarted()
    if (!tool) {
      const outputIndex = outputItems.length
      tool = {
        itemId: toolDelta.id || `fc_${Date.now()}_${key}`,
        callId: toolDelta.id || `call_${Date.now()}_${key}`,
        outputIndex,
        name: toolDelta.function?.name || '',
        arguments: toolDelta.function?.arguments || '',
        done: false
      }
      toolCalls.set(key, tool)
      const item = { id: tool.itemId, type: 'function_call', status: 'in_progress', call_id: tool.callId, name: tool.name, arguments: tool.arguments }
      outputItems[outputIndex] = item
      out += fmtResponsesSSE('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item })
    } else {
      if (toolDelta.function?.name) tool.name += toolDelta.function.name
      if (toolDelta.function?.arguments) tool.arguments += toolDelta.function.arguments
      const item = outputItems[tool.outputIndex]
      if (item) {
        item.name = tool.name
        item.arguments = tool.arguments
      }
    }
    if (toolDelta.function?.arguments) {
      out += fmtResponseEvent('response.function_call_arguments.delta', responseId, { item_id: tool.itemId, output_index: tool.outputIndex, delta: toolDelta.function.arguments })
    }
    return out
  }

  const convert = (line) => {
    if (!line.startsWith('data: ')) return ''
    if (line.startsWith('data: [DONE]')) {
      if (completed) return ''
      const out = started ? '' : ensureStarted()
      completed = true
      return out + finishResponses(inputTokens)
    }

    try {
      const data = JSON.parse(line.slice(6))
      const choice = data.choices?.[0]
      if (data.model) model = data.model

      // Extract usage from data-level or choice-level
      if (data.usage) {
        inputTokens = data.usage.prompt_tokens || inputTokens
      }
      if (choice?.usage) {
        inputTokens = choice.usage.prompt_tokens || data.usage?.prompt_tokens || 0
      }

      // Handle empty choices (metadata-only chunks from providers like MiniMax)
      if (!choice) {
        // If there's a finish_reason in an empty-choices chunk, treat as stream end
        if (data.choices && Array.isArray(data.choices) && data.choices.length === 0) {
          // Check if this is a terminal chunk (MiniMax sends usage in empty-choices chunk before [DONE])
          // Don't mark as completed yet — wait for [DONE] or flush
          return ''
        }
        return ''
      }

      const delta = choice.delta || choice.message || {}
      let out = ''

      if (typeof delta.reasoning_content === 'string') {
        fullReasoning += delta.reasoning_content
      }
      if (Array.isArray(delta.reasoning_details)) {
        fullReasoning += delta.reasoning_details.map(d => d.text || '').join('')
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (let i = 0; i < delta.tool_calls.length; i++) {
          out += handleToolCallDelta(delta.tool_calls[i], i)
        }
      }

      if (delta?.content) {
        // Strip <think> tags from content and convert to reasoning_content
        let content = delta.content
        var TO = '\x3Cthink\x3E'
        var TC = '\x3C/think\x3E'
        while (content) {
          if (!inThinking) {
            var oi = content.indexOf(TO)
            if (oi !== -1) {
              // Emit text before <think>
              if (oi > 0) {
                fullText += content.substring(0, oi)
                out += ensureTextStarted()
                out += fmtResponsesSSE('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: textOutputIndex, content_index: 0, delta: content.substring(0, oi) })
              }
              inThinking = true
              content = content.substring(oi + TO.length)
            } else {
              // No think tag, emit as normal content
              fullText += content
              out += ensureTextStarted()
              out += fmtResponsesSSE('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: textOutputIndex, content_index: 0, delta: content })
              break
            }
          } else {
            var ci = content.indexOf(TC)
            if (ci !== -1) {
              // Emit reasoning content before</think>              fullReasoning += content.substring(0, ci)
              inThinking = false
              content = content.substring(ci + TC.length)
            } else {
              // Still in thinking, emit as reasoning
              fullReasoning += content
              break
            }
          }
        }
      }

      if (choice.finish_reason) {
        completed = true
        out += finishResponses(inputTokens)
      }

      return out
    } catch {
      return ''
    }
  }

  convert.flush = () => {
    if (completed) return ''
    const out = started ? '' : ensureStarted()
    completed = true
    return out + finishResponses(inputTokens)
  }

  return convert
}

function responsesToChatSSEFactory() {
  let chatId = 'chatcmpl-' + Date.now()
  let model = ''
  let started = false
  let completed = false
  const toolCalls = new Map()

  const convert = (line) => {
    if (!line.startsWith('data: ')) return ''
    if (line.startsWith('data: [DONE]')) return ''

    try {
      const data = JSON.parse(line.slice(6))

      if (data.type === 'response.created') {
        model = data.response?.model || model
        started = true
        return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      }

      if (data.type === 'response.output_item.added' && data.item?.type === 'function_call') {
        const item = data.item
        const tool = {
          id: item.call_id || item.id || `call_${Date.now()}`,
          name: item.name || '',
          arguments: item.arguments || '',
          done: false
        }
        toolCalls.set(data.output_index ?? toolCalls.size, tool)
        return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolCalls.size - 1, id: tool.id, type: 'function', function: { name: tool.name, arguments: '' } }] }, finish_reason: null }] })
      }

      if (data.type === 'response.function_call_arguments.delta') {
        const idx = [...toolCalls.keys()].find(k => toolCalls.get(k).id === data.item_id) ?? data.output_index
        const tool = idx != null ? toolCalls.get(idx) : null
        if (tool && data.delta) {
          tool.arguments += data.delta
          const toolIndex = [...toolCalls.keys()].indexOf(idx)
          return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex >= 0 ? toolIndex : 0, function: { arguments: data.delta } }] }, finish_reason: null }] })
        }
        return ''
      }

      if (data.type === 'response.function_call_arguments.done') {
        const idx = [...toolCalls.keys()].find(k => toolCalls.get(k).id === data.item_id || toolCalls.get(k).id === data.call_id) ?? data.output_index
        const tool = idx != null ? toolCalls.get(idx) : null
        if (tool && data.arguments && !tool.arguments) {
          tool.arguments = data.arguments
          const toolIndex = [...toolCalls.keys()].indexOf(idx)
          return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex >= 0 ? toolIndex : 0, function: { arguments: data.arguments } }] }, finish_reason: null }] })
        }
        return ''
      }

      if (data.type === 'response.output_text.delta') {
        return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { content: data.delta }, finish_reason: null }] })
      }

      if (data.type === 'response.completed') {
        completed = true
        const reason = toolCalls.size > 0 ? 'tool_calls' : 'stop'
        return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: {}, finish_reason: reason }] }) + 'data: [DONE]\n\n'
      }

      return ''
    } catch {
      return ''
    }
  }

  convert.flush = () => {
    if (started && !completed) {
      completed = true
      return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
    }
    return ''
  }

  return convert
}

function messagesToResponsesSSEFactory() {
  let responseId = 'resp_' + Date.now()
  let itemId = 'msg_' + Date.now()
  let model = ''
  let started = false
  let completed = false
  let fullText = ''
  let inputTokens = 0
  let textOutputIndex = null
  const contentBlocks = new Map()
  const outputItems = []

  function makeResponse(overrides) {
    return Object.assign({
      id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress', error: null, incomplete_details: null,
      instructions: null, max_output_tokens: null, model,
      output: [], parallel_tool_calls: true, previous_response_id: null,
      reasoning: { effort: null, summary: null }, store: true, temperature: 1.0,
      text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [],
      top_p: 1.0, truncation: 'disabled', usage: null, user: null, metadata: {}
    }, overrides)
  }

  function finishResponses() {
    const outputTokens = 0
    let out = ''
    if (fullText) {
      const outputIndex = textOutputIndex ?? outputItems.length
      const messageItem = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] }
      out += fmtResponsesSSE('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: outputIndex, content_index: 0, text: fullText })
      out += fmtResponsesSSE('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } })
      out += fmtResponsesSSE('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: messageItem })
      outputItems[outputIndex] = messageItem
    }
    for (const block of contentBlocks.values()) {
      if (block.type !== 'tool_use' || block.done) continue
      block.done = true
      const args = block.partialJson || JSON.stringify(block.input || {})
      const item = { id: block.itemId, type: 'function_call', status: 'completed', call_id: block.callId, name: block.name || '', arguments: args }
      out += fmtResponseEvent('response.function_call_arguments.done', responseId, { item_id: block.itemId, output_index: block.outputIndex, call_id: block.callId, name: block.name || '', arguments: args })
      out += fmtResponsesSSE('response.output_item.done', { type: 'response.output_item.done', output_index: block.outputIndex, item })
      outputItems[block.outputIndex] = item
    }
    out += fmtResponsesSSE('response.completed', { type: 'response.completed', response: makeResponse({ status: 'completed', output: outputItems.filter(Boolean), usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }) })
    return out
  }

  function ensureStarted() {
    if (started) return ''
    started = true
    let out = ''
    out += fmtResponsesSSE('response.created', { type: 'response.created', response: makeResponse({ status: 'in_progress' }) })
    out += fmtResponsesSSE('response.in_progress', { type: 'response.in_progress', response: makeResponse({ status: 'in_progress' }) })
    return out
  }

  function ensureTextStarted() {
    let out = ensureStarted()
    if (textOutputIndex != null) return out
    textOutputIndex = outputItems.length
    outputItems[textOutputIndex] = { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    out += fmtResponsesSSE('response.output_item.added', { type: 'response.output_item.added', output_index: textOutputIndex, item: outputItems[textOutputIndex] })
    out += fmtResponsesSSE('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: textOutputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    return out
  }

  const convert = (line) => {
    if (!line.trim()) return ''

    if (line.startsWith('data: [DONE]')) {
      if (started && !completed) {
        completed = true
        return finishResponses()
      }
      return ''
    }

    try {
      if (line.startsWith('event: ')) return ''
      if (!line.startsWith('data: ')) return ''
      const data = JSON.parse(line.slice(6))

      if (data.type === 'message_start') {
        model = data.message?.model || model
        inputTokens = data.message?.usage?.input_tokens || 0
        return ensureStarted()
      }

      if (data.type === 'content_block_start') {
        const block = data.content_block || {}
        if (block.type === 'tool_use') {
          const outputIndex = outputItems.length
          const tool = {
            type: 'tool_use',
            itemId: block.id || `fc_${Date.now()}_${data.index}`,
            callId: block.id || `call_${Date.now()}_${data.index}`,
            outputIndex,
            name: block.name || '',
            input: block.input || {},
            partialJson: '',
            done: false
          }
          contentBlocks.set(data.index, tool)
          const item = { id: tool.itemId, type: 'function_call', status: 'in_progress', call_id: tool.callId, name: tool.name, arguments: '' }
          outputItems[outputIndex] = item
          return ensureStarted() + fmtResponsesSSE('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item })
        }
        contentBlocks.set(data.index, { type: block.type || 'text' })
        if (block.type === 'text') return ensureTextStarted()
        return ensureStarted()
      }

      if (data.type === 'content_block_delta') {
        // Skip thinking blocks (Responses API doesn't have native thinking support)
        if (data.delta?.type === 'thinking_delta') return ''
        const block = contentBlocks.get(data.index)
        if (block?.type === 'tool_use') {
          const delta = data.delta?.partial_json || ''
          block.partialJson += delta
          const item = outputItems[block.outputIndex]
          if (item) item.arguments = block.partialJson
          return delta
            ? fmtResponseEvent('response.function_call_arguments.delta', responseId, { item_id: block.itemId, output_index: block.outputIndex, delta })
            : ''
        }
        const text = data.delta?.text || ''
        if (text) fullText += text
        return ensureTextStarted() + fmtResponsesSSE('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: textOutputIndex, content_index: 0, delta: text })
      }

      if (data.type === 'message_delta') {
        inputTokens = data.usage?.output_tokens ? inputTokens : inputTokens
      }

      if (data.type === 'content_block_stop' || data.type === 'message_stop') {
        if (data.type === 'message_stop') {
          completed = true
          return finishResponses()
        }
        return ''
      }

      return ''
    } catch {
      return ''
    }
  }

  convert.flush = () => {
    if (started && !completed) {
      completed = true
      return finishResponses()
    }
    return ''
  }

  return convert
}

function responsesToMessagesSSEFactory() {
  let messageId = 'msg_' + Date.now()
  let model = ''
  let started = false
  let completed = false
  let fullText = ''
  let inputTokens = 0
  let textBlockIndex = null
  let contentBlockIndex = 0
  const toolBlocks = new Map()

  function ensureStarted() {
    if (started) return ''
    started = true
    return fmtAnthropicSSE('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } })
  }

  function ensureTextStarted() {
    let out = ensureStarted()
    if (textBlockIndex != null) return out
    textBlockIndex = contentBlockIndex++
    out += fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } })
    return out
  }

  function finishMessage() {
    let out = ''
    if (textBlockIndex != null) {
      out += fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: textBlockIndex })
    }
    for (const tool of toolBlocks.values()) {
      if (!tool.done) {
        tool.done = true
        out += fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: tool.index })
      }
    }
    const hasToolUse = toolBlocks.size > 0
    out += fmtAnthropicSSE('message_delta', { type: 'message_delta', delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 0 } })
    out += fmtAnthropicSSE('message_stop', { type: 'message_stop' })
    completed = true
    return out
  }

  const convert = (line) => {
    if (!line.startsWith('data: ')) return ''
    if (line.startsWith('data: [DONE]')) {
      if (started && !completed) return finishMessage()
      return ''
    }

    try {
      const data = JSON.parse(line.slice(6))

      if (data.type === 'response.created') {
        model = data.response?.model || model
        inputTokens = data.response?.usage?.input_tokens || 0
        return ensureStarted()
      }

      if (data.type === 'response.output_item.added' && data.item?.type === 'function_call') {
        const item = data.item
        const idx = contentBlockIndex++
        const tool = {
          index: idx,
          name: item.name || '',
          arguments: '',
          done: false
        }
        toolBlocks.set(data.output_index ?? idx, tool)
        return ensureStarted() + fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: item.call_id || item.id || `toolu_${Date.now()}_${idx}`, name: tool.name, input: {} } })
      }

      if (data.type === 'response.function_call_arguments.delta') {
        const tool = toolBlocks.get(data.output_index) || [...toolBlocks.values()].find(t => !t.done)
        if (tool && data.delta) {
          tool.arguments += data.delta
          return fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: data.delta } })
        }
        return ''
      }

      if (data.type === 'response.function_call_arguments.done') {
        const tool = toolBlocks.get(data.output_index) || [...toolBlocks.values()].find(t => !t.done)
        if (tool) {
          tool.done = true
          const missingArguments = data.arguments && !tool.arguments
          return (missingArguments ? fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: data.arguments } }) : '') +
            fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: tool.index })
        }
        return ''
      }

      if (data.type === 'response.output_text.delta') {
        if (data.delta) fullText += data.delta
        return ensureTextStarted() + fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: data.delta || '' } })
      }

      if (data.type === 'response.completed') {
        return finishMessage()
      }

      return ''
    } catch {
      return ''
    }
  }

  convert.flush = () => {
    if (started && !completed) return finishMessage()
    return ''
  }

  return convert
}



// Register SSE converters
converters['chat_completions->messages'].sseFactory   = chatToMessagesSSEFactory
converters['chat_completions->responses'].sseFactory   = chatToResponsesSSEFactory
converters['messages->chat_completions'].sseFactory    = messagesToChatSSEFactory
converters['messages->responses'].sseFactory           = messagesToResponsesSSEFactory
converters['responses->chat_completions'].sseFactory   = responsesToChatSSEFactory
converters['responses->messages'].sseFactory           = responsesToMessagesSSEFactory

// === Combined reasoning converter ===
// Handles two formats:
// 1. reasoning_details field (MiniMax with reasoning_split=true) — cumulative text
// 2. <think〉 tags in content (MiniMax without reasoning_split) — strip tags
// Both are converted to reasoning_content for client compatibility (e.g. CherryStudio).

function reasoningSSEFactory() {
  let inThinking = false
  let lastReasoning = ''
  let isCumulative = false
  var TO = '\x3Cthink\x3E'
  var TC = '\x3C/think\x3E'

  return (line) => {
    if (!line.startsWith('data: ')) return ''
    if (line.startsWith('data: [DONE]')) return 'data: [DONE]\n\n'

    try {
      var data = JSON.parse(line.slice(6))
      var choice = data.choices && data.choices[0]
      if (!choice) return 'data: ' + JSON.stringify(data) + '\n\n'

      // Case 1: reasoning_details (MiniMax reasoning_split=true)
      var details = choice.delta && choice.delta.reasoning_details
      if (details && details.length > 0) {
        var cur = details.map(function(d) { return d.text || '' }).join('')
        var inc = ''
        if (isCumulative) {
          // Cumulative mode: extract delta
          if (cur.length > lastReasoning.length && cur.startsWith(lastReasoning)) {
            inc = cur.substring(lastReasoning.length)
          }
          lastReasoning = cur
        } else if (lastReasoning.length > 0 && cur.length > lastReasoning.length && cur.startsWith(lastReasoning)) {
          // Cumulative detected (only when lastReasoning is non-empty)
          isCumulative = true
          inc = cur.substring(lastReasoning.length)
          lastReasoning = cur
        } else if (cur !== lastReasoning) {
          // Incremental: use as-is
          inc = cur
          lastReasoning = cur
        }
        if (inc) choice.delta.reasoning_content = inc
        delete choice.delta.reasoning_details
        return 'data: ' + JSON.stringify(data) + '\n\n'
      }

      // No content to process, pass through (preserves finish_reason, usage, etc.)
      if (!choice.delta || choice.delta.content == null) {
        return 'data: ' + JSON.stringify(data) + '\n\n'
      }

      // Case 2: <think〉 tags in content
      var content = choice.delta.content
      var result = ''

      while (content) {
        if (!inThinking) {
          var oi = content.indexOf(TO)
          if (oi !== -1) {
            if (oi > 0) {
              choice.delta.content = content.substring(0, oi)
              delete choice.delta.reasoning_content
              result += 'data: ' + JSON.stringify(data) + '\n\n'
            }
            inThinking = true
            content = content.substring(oi + TO.length)
          } else {
            choice.delta.content = content
            delete choice.delta.reasoning_content
            result += 'data: ' + JSON.stringify(data) + '\n\n'
            break
          }
        } else {
          var ci = content.indexOf(TC)
          if (ci !== -1) {
            if (ci > 0) {
              delete choice.delta.content
              choice.delta.reasoning_content = content.substring(0, ci)
              result += 'data: ' + JSON.stringify(data) + '\n\n'
            }
            inThinking = false
            content = content.substring(ci + TC.length)
          } else {
            delete choice.delta.content
            choice.delta.reasoning_content = content
            result += 'data: ' + JSON.stringify(data) + '\n\n'
            break
          }
        }
      }

      return result
    } catch (e) {
      return ''
    }
  }
}

// === Response Body Converters (non-streaming) ===

function convertChatResponseToMessages(data) {
  // If response is already in Anthropic Messages format, return as-is
  if (data.type === 'message' && Array.isArray(data.content)) {
    return data
  }
  // Otherwise convert from OpenAI Chat Completions format
  const choice = data.choices?.[0]
  const message = choice?.message || {}
  const reverseFinish = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' }
  const content = []
  const reasoning = message.reasoning_content
    || (Array.isArray(message.reasoning_details) ? message.reasoning_details.map(d => d.text || '').join('') : '')
  if (reasoning) {
    content.push({ type: 'thinking', thinking: reasoning })
  }
  content.push({ type: 'text', text: message.content || '' })
  for (const toolCall of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id || ('toolu_' + Date.now()),
      name: toolCall.function?.name || '',
      input: parseMaybeJson(toolCall.function?.arguments, {})
    })
  }
  return {
    id: 'msg_' + (data.id || Date.now()),
    type: 'message',
    role: message.role || 'assistant',
    model: data.model || '',
    content,
    stop_reason: reverseFinish[choice?.finish_reason] || choice?.finish_reason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0
    }
  }
}

function convertMessagesResponseToChat(data) {
  const textContent = (data.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text || '')
    .join('')
  const thinkingContent = (data.content || [])
    .filter(c => c.type === 'thinking')
    .map(c => c.thinking || '')
    .join('')
  const reverseFinish = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls' }
  const message = { role: data.role || 'assistant', content: textContent }
  if (thinkingContent) message.reasoning_content = thinkingContent
  const toolUseBlocks = (data.content || []).filter(c => c.type === 'tool_use')
  if (toolUseBlocks.length > 0) {
    message.tool_calls = toolUseBlocks.map(c => ({
      id: c.id || ('call_' + Date.now()),
      type: 'function',
      function: {
        name: c.name || '',
        arguments: JSON.stringify(c.input || {})
      }
    }))
  }
  return {
    id: data.id || ('msg_' + Date.now()),
    object: 'chat.completion',
    created: Math.floor(Date.now()),
    model: data.model || '',
    choices: [{
      index: 0,
      message,
      finish_reason: reverseFinish[data.stop_reason] || data.stop_reason || 'stop'
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    }
  }
}

function convertResponsesResponseToMessages(data) {
  const textOutput = (data.output || []).flatMap(o => {
    if (o.type === 'message') {
      return (o.content || []).filter(c => c.type === 'output_text').map(c => c.text || '')
    }
    return []
  }).join('')
  const reasoningOutput = (data.output || []).flatMap(o => {
    if (o.type === 'message') {
      if (typeof o.reasoning_content === 'string' && o.reasoning_content) return [o.reasoning_content]
      if (typeof o.metadata?._reasoning_content === 'string' && o.metadata._reasoning_content) return [o.metadata._reasoning_content]
    }
    return []
  }).join('')
  const content = []
  if (reasoningOutput) content.push({ type: 'thinking', thinking: reasoningOutput })
  if (textOutput) content.push({ type: 'text', text: textOutput })
  for (const item of data.output || []) {
    if (item.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: item.call_id || item.id || ('toolu_' + Date.now()),
        name: item.name || '',
        input: parseMaybeJson(item.arguments, {})
      })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  const hasToolUse = content.some(c => c.type === 'tool_use')
  return {
    id: 'msg_' + (data.id || Date.now()),
    type: 'message',
    role: 'assistant',
    model: data.model || '',
    content,
    stop_reason: hasToolUse ? 'tool_use' : (data.status === 'completed' ? 'end_turn' : 'max_tokens'),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0
    }
  }
}

function convertMessagesResponseToResponses(data) {
  const textContent = (data.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text || '')
    .join('')
  const thinkingContent = (data.content || [])
    .filter(c => c.type === 'thinking')
    .map(c => c.thinking || '')
    .join('')
  const reasoningFields = thinkingContent ? { reasoning_content: thinkingContent, metadata: { _reasoning_content: thinkingContent } } : {}
  const output = []
  if (textContent || thinkingContent) {
    output.push({
      type: 'message',
      id: 'msg_' + Date.now(),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textContent, annotations: [] }],
      ...reasoningFields
    })
  }
  for (const block of data.content || []) {
    if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: block.id || ('fc_' + Date.now()),
        status: 'completed',
        call_id: block.id || ('call_' + Date.now()),
        name: block.name || '',
        arguments: JSON.stringify(block.input || {}),
        ...reasoningFields
      })
    }
  }
  if (output.length === 0) {
    output.push({
      type: 'message',
      id: 'msg_' + Date.now(),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }]
    })
  }
  return {
    id: data.id || ('msg_' + Date.now()),
    object: 'response',
    created_at: Math.floor(Date.now()),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: data.model || '',
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1.0,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1.0,
    truncation: 'disabled',
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: data.usage?.output_tokens || 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    },
    user: null,
    metadata: {}
  }
}

function convertChatResponseToResponses(data) {
  const choice = data.choices?.[0]
  const message = choice?.message || {}
  const output = []
  {
    const msgId = 'msg_' + Date.now()
    const msgContent = []
    if (message.content) {
      msgContent.push({ type: 'output_text', text: message.content, annotations: [] })
    }
    output.push({
      type: 'message',
      id: msgId,
      status: 'completed',
      role: 'assistant',
      content: msgContent.length > 0 ? msgContent : [{ type: 'output_text', text: '', annotations: [] }],
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      // Preserve reasoning_content in metadata so it survives round-trip conversion.
      // Clients like Codex send previous output items back as input, and Mimo requires
      // reasoning_content to be present in assistant messages during thinking mode.
      metadata: { ...(message.reasoning_content ? { _reasoning_content: message.reasoning_content } : {}) }
    })
  }
  for (const toolCall of message.tool_calls || []) {
    output.push({
      type: 'function_call',
      id: toolCall.id || ('fc_' + Date.now()),
      status: 'completed',
      call_id: toolCall.id || ('call_' + Date.now()),
      name: toolCall.function?.name || '',
      arguments: toolCall.function?.arguments || '',
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      ...(message.reasoning_content ? { metadata: { _reasoning_content: message.reasoning_content } } : {})
    })
  }
  if (output.length === 0) {
    output.push({
      type: 'message',
      id: 'msg_' + Date.now(),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }]
    })
  }
  return {
    id: data.id || ('chatcmpl-' + Date.now()),
    object: 'response',
    created_at: Math.floor(Date.now()),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: data.model || '',
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1.0,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1.0,
    truncation: 'disabled',
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: data.usage?.completion_tokens || 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: data.usage?.total_tokens || 0
    },
    user: null,
    metadata: {}
  }
}

function convertResponsesResponseToChat(data) {
  const reasoningOutput = (data.output || []).flatMap(o => {
    if (o.type === 'message') {
      if (typeof o.reasoning_content === 'string' && o.reasoning_content) return [o.reasoning_content]
      if (typeof o.metadata?._reasoning_content === 'string' && o.metadata._reasoning_content) return [o.metadata._reasoning_content]
      return (o.content || []).filter(c => c.type === 'thinking').map(c => c.thinking || '')
    }
    return []
  }).join('')
  const textOutput = (data.output || []).flatMap(o => {
    if (o.type === 'message') {
      return (o.content || []).filter(c => c.type === 'output_text').map(c => c.text || '')
    }
    return []
  }).join('')
  const message = { role: 'assistant', content: textOutput }
  if (reasoningOutput) message.reasoning_content = reasoningOutput
  const toolCallOutputs = (data.output || []).filter(o => o.type === 'function_call')
  if (toolCallOutputs.length > 0) {
    message.tool_calls = toolCallOutputs.map(o => ({
      id: o.call_id || o.id || ('call_' + Date.now()),
      type: 'function',
      function: {
        name: o.name || '',
        arguments: o.arguments || ''
      }
    }))
  }
  const hasToolCalls = toolCallOutputs.length > 0
  return {
    id: data.id || ('resp_' + Date.now()),
    object: 'chat.completion',
    created: Math.floor(Date.now()),
    model: data.model || '',
    choices: [{
      index: 0,
      message,
      finish_reason: hasToolCalls ? 'tool_calls' : (data.status === 'completed' ? 'stop' : 'length')
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: data.usage?.total_tokens || 0
    }
  }
}



// Register response body converters
converters['chat_completions->messages'].responseBody   = convertChatResponseToMessages
converters['chat_completions->responses'].responseBody  = convertChatResponseToResponses
converters['messages->chat_completions'].responseBody   = convertMessagesResponseToChat
converters['messages->responses'].responseBody          = convertMessagesResponseToResponses
converters['responses->chat_completions'].responseBody  = convertResponsesResponseToChat
converters['responses->messages'].responseBody          = convertResponsesResponseToMessages

function getBodyConverter(source, target) {
  const key = `${source}->${target}`
  return converters[key] ? converters[key].body : null
}

function getResponseBodyConverter(source, target) {
  if (source === target) return null
  const key = `${target}->${source}`
  return converters[key] ? converters[key].responseBody : null
}

function createSSEConverter(source, target) {
  if (source === target) return null
  const key = `${target}->${source}`
  return converters[key] ? converters[key].sseFactory() : null
}

export {
  converters,
  getBodyConverter,
  getResponseBodyConverter,
  createSSEConverter,
  reasoningSSEFactory,
  fmtAnthropicSSE,
  fmtOpenAISSE,
  fmtResponsesSSE,
  fmtResponseEvent,
  mapFinishReason,
  parseMaybeJson,
  setReasoningCache,
  convertChatToMessages,
  convertMessagesToChat,
  convertChatToResponses,
  convertResponsesToChat,
  convertMessagesToResponses,
  convertResponsesToMessages,
  convertChatResponseToMessages,
  convertMessagesResponseToChat,
  convertResponsesResponseToMessages,
  convertMessagesResponseToResponses,
  convertChatResponseToResponses,
  convertResponsesResponseToChat
}
