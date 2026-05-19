// proxy/proxy-server.js
// 代理服务器 Sidecar 入口。通过 stdin/stdout JSON Lines IPC 接收配置。
// 对外暴露 /v1/chat/completions, /v1/responses, /v1/messages, /v1/models

import http from 'http'
import https from 'https'
import { URL } from 'url'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'

// --- State ---

let currentConfig = null // { profile: {...}, models: [...] }
let logEnabled = false
let initialized = false
let startupKeepAlive = null

// --- Path → source format mapping ---

const PATH_TO_SOURCE = {
  '/v1/chat/completions': 'chat_completions',
  '/v1/responses': 'responses',
  '/v1/messages': 'messages',
  '/chat/completions': 'chat_completions',
  '/responses': 'responses',
  '/messages': 'messages'
}

// --- Provider type → target format + upstream path ---

const PROVIDER_META = {
  'openai-chat':        { target: 'chat_completions', path: '/v1/chat/completions' },
  'openai-response':    { target: 'responses',        path: '/v1/responses' },
  'anthropic-message':  { target: 'messages',          path: '/v1/messages' },
  'newapi':             { target: 'chat_completions', path: '/v1/chat/completions' }
}

// --- Read request body ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// --- Clean malformed client body ---
// CherryStudio 等客户端会把未设置的字段发成 "[undefined]" 字符串值，需要过滤掉

function cleanBody(body) {
  if (!body || typeof body !== 'object') return body
  if (Array.isArray(body)) return body.map(cleanBody)

  const cleaned = {}
  for (const [key, value] of Object.entries(body)) {
    if (value === '[undefined]' || value === 'undefined') continue
    if (Array.isArray(value)) {
      cleaned[key] = value.map(item =>
        typeof item === 'object' && item !== null ? cleanBody(item) : item
      )
    } else if (typeof value === 'object' && value !== null) {
      cleaned[key] = cleanBody(value)
    } else {
      cleaned[key] = value
    }
  }
  return cleaned
}

// 将 content 数组格式 [{ type: 'input_text', text: '...' }] 展平为纯字符串
function flattenMessageContent(msg) {
  if (!msg || typeof msg.content === 'string') return msg
  if (Array.isArray(msg.content)) {
    const text = msg.content
      .filter(c => c.type === 'input_text' || c.type === 'text')
      .map(c => c.text || '')
      .join('')
    return { ...msg, content: text }
  }
  return msg
}

function flattenBodyMessages(body) {
  const msgArray = body.input || body.messages
  if (!msgArray || !Array.isArray(msgArray)) return body
  const flattened = msgArray.map(flattenMessageContent)
  if (body.input) return { ...body, input: flattened }
  return { ...body, messages: flattened }
}

// --- Forward request to upstream ---

function createProxyAgent(proxyConfig, isHttps, profileId) {
  if (!proxyConfig?.enabled || !proxyConfig?.url) {
    return undefined
  }

  // 检查当前 profile 是否在排除列表中
  if (proxyConfig.excludeProfiles?.includes(profileId)) {
    return undefined
  }

  try {
    const proxyUrl = new URL(proxyConfig.url)
    if (proxyConfig.username) {
      proxyUrl.username = proxyConfig.username
    }
    if (proxyConfig.password) {
      proxyUrl.password = proxyConfig.password
    }

    return isHttps
      ? new HttpsProxyAgent(proxyUrl.toString())
      : new HttpProxyAgent(proxyUrl.toString())
  } catch (e) {
    console.error('Failed to create proxy agent:', e.message)
    return undefined
  }
}

function forwardRequest(clientReq, clientRes, upstreamUrl, apiKey, body, sseConverter, onResponseBody, responseBodyConverter, sourceFormat, profileId) {
  const parsed = new URL(upstreamUrl)
  const isHttps = parsed.protocol === 'https:'
  const transport = isHttps ? https : http

  // 检查是否需要使用代理
  const proxyConfig = currentConfig?.settings?.httpProxy
  const agent = createProxyAgent(proxyConfig, isHttps, profileId)
  clientReq._usedProxy = !!agent

  const bodyStr = JSON.stringify(body)

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: clientReq.method,
    agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(bodyStr)
    }
  }

  const upstreamReq = transport.request(options, (upstreamRes) => {
    const isStreaming = upstreamRes.headers['content-type']?.includes('text/event-stream')

    if (isStreaming && sseConverter) {
      // SSE streaming with conversion
      clientRes.writeHead(upstreamRes.statusCode, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })

      let closed = false
      const keepAlive = setInterval(() => {
        if (!closed && !clientRes.writableEnded) clientRes.write(': keepalive\n\n')
      }, 15000)

      const cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(keepAlive)
        upstreamReq.destroy()
        if (!clientRes.writableEnded) clientRes.end()
      }

      clientRes.on('error', cleanup)
      clientRes.on('close', cleanup)

      upstreamRes.on('error', cleanup)

      let buffer = ''
      let rawBuffer = ''
      upstreamRes.on('data', (chunk) => {
        if (closed) return
        rawBuffer += chunk.toString()
        buffer += chunk.toString()
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''

        for (const line of lines) {
          const result = sseConverter(line)
          if (result) clientRes.write(result)
        }
      })

      upstreamRes.on('end', () => {
        if (closed) return
        closed = true
        clearInterval(keepAlive)
        if (buffer.trim()) {
          const result = sseConverter(buffer)
          if (result) clientRes.write(result)
        }
        // 上游连接断开但未发送 [DONE] 时，补发 response.completed 等收尾事件
        if (sseConverter.flush) {
          const flushed = sseConverter.flush()
          if (flushed) clientRes.write(flushed)
        }
        clientRes.end()
        if (onResponseBody) onResponseBody(rawBuffer || null)
      })
    } else if (isStreaming) {
      // SSE streaming without conversion — pipe through immediately
      clientRes.writeHead(upstreamRes.statusCode, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })

      let closed = false
      const keepAlive = setInterval(() => {
        if (!closed && !clientRes.writableEnded) clientRes.write(': keepalive\n\n')
      }, 15000)

      const cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(keepAlive)
        upstreamReq.destroy()
        if (!clientRes.writableEnded) clientRes.end()
      }

      clientRes.on('error', cleanup)
      clientRes.on('close', cleanup)

      upstreamRes.on('error', cleanup)

      let rawBuffer = ''
      upstreamRes.on('data', (chunk) => {
        if (closed) return
        rawBuffer += chunk.toString()
        clientRes.write(chunk)
      })
      upstreamRes.on('end', () => {
        if (closed) return
        closed = true
        clearInterval(keepAlive)
        if (onResponseBody) onResponseBody(rawBuffer || null)
        clientRes.end()
      })
    } else if (sseConverter) {
      // Client requested streaming but upstream returned non-streaming response.
      // Treat response body as a single SSE event: parse JSON, produce full SSE sequence.
      const chunks = []
      upstreamRes.on('data', c => chunks.push(c))
      upstreamRes.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString()
        clientRes.writeHead(upstreamRes.statusCode, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })

        try {
          const data = JSON.parse(rawBody)

          if (sourceFormat === 'responses') {
            // Upstream returned non-streaming Chat/Messages JSON, client expects Responses SSE
            let content
            if (data.type === 'message' && Array.isArray(data.content)) {
              content = data.content.filter(c => c.type === 'text').map(c => c.text).join('')
            } else {
              const choice = data.choices?.[0]
              content = choice?.message?.content || ''
            }
            const model = data.model || ''
            const inputTokens = data.usage?.input_tokens || data.usage?.prompt_tokens || 0
            const outputTokens = data.usage?.output_tokens || data.usage?.completion_tokens || 0
            const responseId = 'resp_' + Date.now()
            const itemId = 'msg_' + Date.now()

            function makeResp(overrides) {
              return Object.assign({ id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model, output: [], parallel_tool_calls: true, previous_response_id: null, reasoning: { effort: null, summary: null }, store: true, temperature: 1.0, text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], top_p: 1.0, truncation: 'disabled', usage: null, user: null, metadata: {} }, overrides)
            }

            clientRes.write(
              fmtResponsesSSE('response.created', { type: 'response.created', response: makeResp({ status: 'in_progress' }) }) +
              fmtResponsesSSE('response.in_progress', { type: 'response.in_progress', response: makeResp({ status: 'in_progress' }) }) +
              fmtResponsesSSE('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }) +
              fmtResponsesSSE('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }) +
              (content ? fmtResponsesSSE('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: content }) : '') +
              fmtResponsesSSE('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: content }) +
              fmtResponsesSSE('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: content, annotations: [] } }) +
              fmtResponsesSSE('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] } }) +
              fmtResponsesSSE('response.completed', { type: 'response.completed', response: makeResp({ status: 'completed', output: [{ id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] }], usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }) })
            )
          } else if (sourceFormat === 'chat_completions') {
            // Client expects Chat Completions SSE
            let content, model, finishReason
            if (data.type === 'message' && Array.isArray(data.content)) {
              content = data.content.filter(c => c.type === 'text').map(c => c.text).join('')
              model = data.model || ''
              const reverseStop = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls' }
              finishReason = reverseStop[data.stop_reason] || data.stop_reason || 'stop'
            } else {
              const choice = data.choices?.[0]
              const message = choice?.message || {}
              content = message.content || ''
              model = data.model || ''
              finishReason = choice?.finish_reason || 'stop'
            }
            const chatId = 'chatcmpl-' + Date.now()

            clientRes.write(
              fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) +
              (content ? fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { content: content }, finish_reason: null }] }) : '') +
              fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }) +
              'data: [DONE]\n\n'
            )
          } else {
            // Client expects Anthropic Messages SSE
            let role, model, content, reasoning, inputTokens, outputTokens, stopReason, contentBlocks

            if (data.type === 'message' && Array.isArray(data.content)) {
              // Upstream returned Anthropic Messages format — pass through
              role = data.role || 'assistant'
              model = data.model || ''
              contentBlocks = data.content
              reasoning = ''
              inputTokens = data.usage?.input_tokens || 0
              outputTokens = data.usage?.output_tokens || 0
              stopReason = data.stop_reason || 'end_turn'
            } else {
              // Upstream returned OpenAI Chat Completions format — convert
              const choice = data.choices?.[0]
              const message = choice?.message || {}
              role = message.role || 'assistant'
              model = data.model || ''
              const text = message.content || ''
              reasoning = message.reasoning_content || ''
              contentBlocks = []
              if (reasoning) contentBlocks.push({ type: 'thinking', thinking: reasoning })
              if (text) contentBlocks.push({ type: 'text', text })
              inputTokens = data.usage?.prompt_tokens || 0
              outputTokens = data.usage?.completion_tokens || 0
              stopReason = mapFinishReason(choice?.finish_reason || 'stop')
            }

            const msgId = 'msg_' + Date.now()
            let idx = 0

            let out = fmtAnthropicSSE('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role, model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } })

            for (const block of contentBlocks) {
              if (block.type === 'thinking') {
                out += fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } }) +
                       fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: block.thinking || '' } }) +
                       fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: idx })
                idx++
              } else if (block.type === 'text') {
                out += fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }) +
                       fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: block.text || '' } }) +
                       fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: idx })
                idx++
              }
            }

            // Ensure at least one text block exists
            if (idx === 0) {
              out += fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
                     fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } }) +
                     fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: 0 })
            }

            out += fmtAnthropicSSE('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } }) +
                   fmtAnthropicSSE('message_stop', { type: 'message_stop' })

            clientRes.write(out)
          }
          if (onResponseBody) onResponseBody(rawBody)
        } catch {
          clientRes.write(rawBody)
        }
        clientRes.end()
      })
    } else {
      // Non-streaming: collect full body, optionally convert
      const chunks = []
      upstreamRes.on('data', c => chunks.push(c))
      upstreamRes.on('end', () => {
        let responseBody = Buffer.concat(chunks).toString()

        if (responseBodyConverter) {
          try {
            const parsed = JSON.parse(responseBody)
            responseBody = JSON.stringify(responseBodyConverter(parsed))
          } catch {
            // If conversion fails, send raw body as-is
          }
        }

        clientRes.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json' })
        clientRes.end(responseBody)
        if (onResponseBody) onResponseBody(responseBody)
      })
    }
  })

  upstreamReq.setTimeout(300000, () => {
    upstreamReq.destroy(new Error('upstream request timeout'))
  })

  upstreamReq.on('error', (err) => {
    if (!clientRes.headersSent) {
      const errorBody = JSON.stringify({ error: 'Bad Gateway', message: err.message })
      clientRes.writeHead(502, { 'Content-Type': 'application/json' })
      clientRes.end(errorBody)
      if (onResponseBody) onResponseBody(errorBody)
    } else {
      clientRes.end()
    }
  })

  upstreamReq.write(bodyStr)
  upstreamReq.end()
}

// --- Route: /v1/models ---

function handleModels(_, res) {
  const globalModels = (currentConfig && currentConfig.models) ? currentConfig.models : []
  const providerModels = (currentConfig && currentConfig.profiles)
    ? currentConfig.profiles.flatMap(p => (Array.isArray(p.models) ? p.models : []))
    : []
  const allModels = [...new Set([...globalModels, ...providerModels])]
  const data = allModels.map(id => ({ id, object: 'model', owned_by: 'aigateway' }))
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ object: 'list', data }))
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

// === Body Converters ===

function extractSystemContent(msg) {
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content.filter(c => c.type === 'text' || c.type === 'input_text').map(c => c.text).join('\n')
  }
  return ''
}

function convertChatToMessages(body) {
  const { messages, ...rest } = body
  const systemMsg = messages.find(m => m.role === 'system')
  const nonSystem = messages.filter(m => m.role !== 'system')
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
  result.messages = messages.map(m => {
    if (typeof m.content === 'string') return m
    if (!Array.isArray(m.content)) return m
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
    return { ...m, content: text }
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
  result.input = messages
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
    messages = input.map(m => {
      // Map roles: developer → system for Chat Completions compatibility
      const role = m.role === 'developer' ? 'system' : m.role
      // Convert content arrays: input_text → text, keep string content as-is
      if (m.content && Array.isArray(m.content)) {
        const text = m.content
          .filter(c => c.type === 'input_text' || c.type === 'text')
          .map(c => c.text || '')
          .join('')
        return { role, content: text }
      }
      return { role, content: m.content }
    })
  }
  // Prepend instructions as system message
  if (instructions) {
    messages.unshift({ role: 'system', content: instructions })
  }
  result.messages = messages
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
  const input = messages.map(m => {
    if (typeof m.content === 'string') return m
    if (!Array.isArray(m.content)) return m
    // Flatten text content blocks to string
    const text = m.content.filter(c => c.type === 'text').map(c => c.text || '').join('')
    return { ...m, content: text }
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

function convertResponsesToMessages(body) {
  const { input, instructions, ...rest } = body
  // Convert input: can be a string or an array
  let msgs = []
  if (typeof input === 'string') {
    msgs = [{ role: 'user', content: input }]
  } else if (Array.isArray(input)) {
    msgs = input
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

  function ensureStarted(choice) {
    if (started) return ''
    started = true
    const role = choice?.delta?.role || choice?.message?.role || 'assistant'
    return fmtAnthropicSSE('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role, model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
  }

  function startThinking() {
    if (thinkingStarted) return ''
    thinkingStarted = true
    return fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
  }

  function closeThinking() {
    if (!thinkingStarted || thinkingClosed) return ''
    thinkingClosed = true
    return fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: 0 })
  }

  function startText() {
    if (textStarted) return ''
    textStarted = true
    return fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: thinkingStarted ? 1 : 0, content_block: { type: 'text', text: '' } })
  }

  return (line) => {
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

      // Handle text content → text block
      if (content != null && typeof content === 'string' && content !== '') {
        out += closeThinking()
        out += startText()
        out += fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: thinkingStarted ? 1 : 0, delta: { type: 'text_delta', text: content } })
      }

      // Handle finish
      if (finishReason) {
        out += closeThinking()
        if (!textStarted) out += startText()
        const textIdx = thinkingStarted ? 1 : 0
        out += fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: textIdx })
        out += fmtAnthropicSSE('message_delta', { type: 'message_delta', delta: { stop_reason: mapFinishReason(finishReason) }, usage: { output_tokens: outputTokens } })
        out += fmtAnthropicSSE('message_stop', { type: 'message_stop' })
        completed = true
      }

      return out
    } catch {
      return ''
    }
  }
}

function messagesToChatSSEFactory() {
  let chatId = 'chatcmpl-' + Date.now()
  let model = ''

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

      if (data.type === 'content_block_delta') {
        // Map thinking_delta to reasoning_content for clients that support it
        if (data.delta?.type === 'thinking_delta') {
          return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { reasoning_content: data.delta.thinking || '' }, finish_reason: null }] })
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
  let inputTokens = 0

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
    out += fmtResponsesSSE('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: fullText })
    out += fmtResponsesSSE('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } })
    out += fmtResponsesSSE('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } })
    out += fmtResponsesSSE('response.completed', { type: 'response.completed', response: makeResponse({ status: 'completed', output: [{ id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] }], usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }) })
    return out
  }

  const convert = (line) => {
    if (!line.startsWith('data: ')) return ''
    if (line.startsWith('data: [DONE]')) {
      if (started && !completed) {
        completed = true
        return finishResponses(inputTokens)
      }
      return ''
    }

    try {
      const data = JSON.parse(line.slice(6))
      const choice = data.choices?.[0]
      if (!choice) return ''
      if (data.model) model = data.model

      if (choice.usage) {
        inputTokens = choice.usage.prompt_tokens || data.usage?.prompt_tokens || 0
      }
      if (data.usage) {
        inputTokens = data.usage.prompt_tokens || inputTokens
      }

      const delta = choice.delta
      let out = ''

      if (!started) {
        started = true
        out += fmtResponsesSSE('response.created', { type: 'response.created', response: makeResponse({ status: 'in_progress' }) })
        out += fmtResponsesSSE('response.in_progress', { type: 'response.in_progress', response: makeResponse({ status: 'in_progress' }) })
        out += fmtResponsesSSE('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
        out += fmtResponsesSSE('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        if (delta?.content) {
          fullText += delta.content
          out += fmtResponsesSSE('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: delta.content })
        }
        if (choice.finish_reason) {
          completed = true
          out += finishResponses(inputTokens)
        }
        return out
      }

      if (delta?.content) {
        fullText += delta.content
        return fmtResponsesSSE('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: delta.content })
      }

      if (choice.finish_reason) {
        completed = true
        return finishResponses(inputTokens)
      }

      return ''
    } catch {
      return ''
    }
  }

  convert.flush = () => {
    if (started && !completed) {
      completed = true
      return finishResponses(inputTokens)
    }
    return ''
  }

  return convert
}

function responsesToChatSSEFactory() {
  let chatId = 'chatcmpl-' + Date.now()
  let model = ''

  return (line) => {
    if (!line.startsWith('data: ')) return ''
    if (line.startsWith('data: [DONE]')) return ''

    try {
      const data = JSON.parse(line.slice(6))

      if (data.type === 'response.created') {
        model = data.response?.model || model
        return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      }

      if (data.type === 'response.output_text.delta') {
        return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { content: data.delta }, finish_reason: null }] })
      }

      if (data.type === 'response.completed') {
        return fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
      }

      return ''
    } catch {
      return ''
    }
  }
}

function messagesToResponsesSSEFactory() {
  let responseId = 'resp_' + Date.now()
  let itemId = 'msg_' + Date.now()
  let model = ''
  let started = false
  let completed = false
  let fullText = ''
  let inputTokens = 0

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
    out += fmtResponsesSSE('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: fullText })
    out += fmtResponsesSSE('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } })
    out += fmtResponsesSSE('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } })
    out += fmtResponsesSSE('response.completed', { type: 'response.completed', response: makeResponse({ status: 'completed', output: [{ id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] }], usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }) })
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
        started = true
        let out = ''
        out += fmtResponsesSSE('response.created', { type: 'response.created', response: makeResponse({ status: 'in_progress' }) })
        out += fmtResponsesSSE('response.in_progress', { type: 'response.in_progress', response: makeResponse({ status: 'in_progress' }) })
        out += fmtResponsesSSE('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
        out += fmtResponsesSSE('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        return out
      }

      if (data.type === 'content_block_delta') {
        // Skip thinking blocks (Responses API doesn't have native thinking support)
        if (data.delta?.type === 'thinking_delta') return ''
        const text = data.delta?.text || ''
        if (text) fullText += text
        return fmtResponsesSSE('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: text })
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

  return (line) => {
    if (!line.startsWith('data: ')) return ''
    if (line.startsWith('data: [DONE]')) return ''

    try {
      const data = JSON.parse(line.slice(6))

      if (data.type === 'response.created') {
        model = data.response?.model || model
        return fmtAnthropicSSE('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }) +
               fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      }

      if (data.type === 'response.output_text.delta') {
        return fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: data.delta } })
      }

      if (data.type === 'response.completed') {
        return fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: 0 }) +
               fmtAnthropicSSE('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }) +
               fmtAnthropicSSE('message_stop', { type: 'message_stop' })
      }

      return ''
    } catch {
      return ''
    }
  }
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
  return {
    id: 'msg_' + (data.id || Date.now()),
    type: 'message',
    role: 'assistant',
    model: data.model || '',
    content: [{ type: 'text', text: textOutput }],
    stop_reason: data.status === 'completed' ? 'end_turn' : 'max_tokens',
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
  const msgId = 'msg_' + Date.now()
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
    output: [{
      type: 'message',
      id: msgId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textContent, annotations: [] }]
    }],
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
  const msgId = 'msg_' + Date.now()
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
    output: [{
      type: 'message',
      id: msgId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content || '', annotations: [] }]
    }],
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
  const textOutput = (data.output || []).flatMap(o => {
    if (o.type === 'message') {
      return (o.content || []).filter(c => c.type === 'output_text').map(c => c.text || '')
    }
    return []
  }).join('')
  return {
    id: data.id || ('resp_' + Date.now()),
    object: 'chat.completion',
    created: Math.floor(Date.now()),
    model: data.model || '',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: textOutput },
      finish_reason: data.status === 'completed' ? 'stop' : 'length'
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
  if (source === target) return null
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

// --- Handle API request ---

async function handleApiRequest(req, res) {
  // Check active profiles
  if (!currentConfig || !currentConfig.profiles || currentConfig.profiles.length === 0) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Service Unavailable: no active profile configured' }))
    return
  }

  const urlPath = req.url.split('?')[0]
  const source = PATH_TO_SOURCE[urlPath]

  if (!source) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not Found' }))
    return
  }

  let body = req._body
  if (!body) {
    try {
      body = await readBody(req)
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }
  }

  // Clean malformed body: strip "[undefined]" strings, flatten input_text content arrays
  body = cleanBody(body)
  body = flattenBodyMessages(body)

  // Apply model mapping if enabled
  let originalModel = body.model
  let modelMappingInfo = null
  if (currentConfig.modelMappings && currentConfig.modelMappings.enabled && body.model) {
    for (const rule of currentConfig.modelMappings.rules) {
      if (body.model.toLowerCase() === rule.from.toLowerCase()) {
        body.model = rule.to
        modelMappingInfo = rule.to
        console.log(`[Model Mapping] ${rule.from} → ${rule.to} (matched: ${body.model})`)
        break
      }
    }
  }

  // Route by model: find the first profile whose models include body.model
  const requestedModel = body.model
  let profile = null

  if (requestedModel) {
    for (const p of currentConfig.profiles) {
      if (Array.isArray(p.models) && p.models.length > 0 && p.models.includes(requestedModel)) {
        profile = p
        break
      }
    }
    if (!profile) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `AI 网关未匹配到模型: ${requestedModel}`, type: 'invalid_request_error', code: 'model_not_found' } }))
      return
    }
  } else {
    // No model specified — use the first profile with models
    for (const p of currentConfig.profiles) {
      if (Array.isArray(p.models) && p.models.length > 0) {
        profile = p
        break
      }
    }
    if (!profile) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'AI 网关无可用提供商配置' }))
      return
    }
  }

  req._providerName = profile.name

  const meta = PROVIDER_META[profile.providerType]
  if (!meta) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Unknown providerType: ${profile.providerType}` }))
    return
  }

  // Fill default model
  if (!body.model && profile.defaultModel) {
    body.model = profile.defaultModel
  }

  // Apply body converter
  const bodyConverter = getBodyConverter(source, meta.target)
  if (bodyConverter) {
    body = bodyConverter(body)
  }

  const baseUrl = profile.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const upstreamUrl = `${baseUrl}${meta.path}`
  req._upstreamUrl = upstreamUrl
  req._modelMapping = modelMappingInfo
  req._originalModel = originalModel
  const needStream = req.headers.accept?.includes('text/event-stream') || body.stream
  let sseConverter = needStream ? createSSEConverter(source, meta.target) : null
  // Same-format chat_completions: convert reasoning_details / <think> tags
  // to reasoning_content for client compatibility (e.g. CherryStudio).
  // Do NOT inject reasoning_split automatically — it's provider-specific
  // (MiniMax) and breaks other providers (Xiaomi, DeepSeek, etc.).
  // Clients that need reasoning_split should add it themselves.
  if (!sseConverter && source === 'chat_completions' && meta.target === 'chat_completions') {
    if (needStream) {
      sseConverter = reasoningSSEFactory()
    }
  }
  const responseBodyConverter = getResponseBodyConverter(source, meta.target)

  forwardRequest(req, res, upstreamUrl, profile.apiKey, body, sseConverter,
    req._onResponseBody || null,
    responseBodyConverter,
    source,
    profile.id
  )
}

// --- HTTP Server ---

function logRequest(endpoint, model, statusCode, duration, error, requestBody, responseBody, providerName, extra) {
  const data = {
    timestamp: Date.now(),
    endpoint,
    model: model || '-',
    provider: providerName || '-',
    statusCode,
    duration,
    error: error || null
  }
  if (extra) {
    if (extra.upstreamUrl) data.upstreamUrl = extra.upstreamUrl
    if (extra.usedProxy) data.proxy = true
    if (extra.modelMapping) data.modelMapping = extra.modelMapping
    if (extra.originalModel) data.originalModel = extra.originalModel
  }
  // 仅当开启详细日志时才记录请求/响应体
  if (logEnabled) {
    data.requestBody = requestBody ? JSON.stringify(requestBody) : null
    data.responseBody = responseBody || null
  }
  // 404 请求始终记录路径和请求体（用于排查问题）
  if (statusCode === 404 && requestBody) {
    data.requestBody = JSON.stringify(requestBody)
  }
  // 解析 token 使用量
  if (responseBody) {
    try {
      const parsed = JSON.parse(responseBody)
      const usage = parsed.usage || parsed.usage_total
      if (usage) {
        data.promptTokens = usage.prompt_tokens || usage.input_tokens || 0
        data.completionTokens = usage.completion_tokens || usage.output_tokens || 0
        data.totalTokens = usage.total_tokens || (data.promptTokens + data.completionTokens)
      }
    } catch {}
  }
  process.stdout.write(JSON.stringify({ type: 'log', data }) + '\n')
}

const server = http.createServer(async (req, res) => {
  // 防止长连接（SSE）被默认超时断开
  req.setTimeout(0)
  res.setTimeout(0)
  const startTime = Date.now()
  const endpoint = req.url
  const urlPath = endpoint.split('?')[0]
  let model = '-'
  let rawBody = null
  let responseBody = null

  try {
    if (urlPath === '/v1/models' && req.method === 'GET') {
      handleModels(req, res)
      res.on('finish', () => {
        logRequest(endpoint, '-', res.statusCode, Date.now() - startTime, null, null, null, '-')
      })
    } else if (urlPath === '/v1/messages/count_tokens') {
      // Anthropic token counting endpoint — return estimated count since upstream providers don't support it
      rawBody = await readBody(req)
      model = (rawBody && rawBody.model) || '-'
      // Rough estimate: ~4 chars per token for English, ~2 chars per token for CJK
      const bodyStr = JSON.stringify(rawBody.messages || [])
      const inputTokens = Math.ceil(bodyStr.length / 3)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: inputTokens }))
      logRequest(endpoint, model, 200, Date.now() - startTime, null, rawBody, null, '-')
    } else if (PATH_TO_SOURCE[urlPath]) {
      rawBody = await readBody(req)
      model = (rawBody && rawBody.model) || '-'
      req._body = rawBody
      if (logEnabled) {
        req._onResponseBody = (body) => { responseBody = body }
      }
      await handleApiRequest(req, res)
    } else {
      // 尝试读取请求体用于日志记录
      let bodyForLog = null
      try {
        bodyForLog = await readBody(req)
      } catch {}

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not Found' }))
      logRequest(endpoint, '-', 404, Date.now() - startTime, 'route_not_found', bodyForLog, null, '-')
    }
  } catch (err) {
    if (!res.headersSent) {
      const errorBody = JSON.stringify({ error: 'Internal Server Error', message: err.message })
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(errorBody)
      responseBody = errorBody
    }
    model = model || '-'
    const errExtra = { upstreamUrl: req._upstreamUrl, usedProxy: req._usedProxy, modelMapping: req._modelMapping, originalModel: req._originalModel }
    logRequest(endpoint, model, res.statusCode || 500, Date.now() - startTime, err.message, rawBody, responseBody, req._providerName, errExtra)
    return
  }

  res.on('finish', () => {
    const extra = { upstreamUrl: req._upstreamUrl, usedProxy: req._usedProxy, modelMapping: req._modelMapping, originalModel: req._originalModel }
    logRequest(endpoint, model, res.statusCode, Date.now() - startTime, null, rawBody, responseBody, req._providerName, extra)
  })
})

// --- IPC: receive config from parent (stdin JSON Lines) ---

let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  const lines = stdinBuffer.split('\n')
  stdinBuffer = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === 'init') {
      initialized = true
      currentConfig = msg.config
      const port = msg.config.settings?.port || 9999
      logEnabled = !!(msg.config.settings && msg.config.settings.logEnabled)
      // keepalive timer 防止 stdin 关闭后事件循环退出
      startupKeepAlive = setInterval(() => {}, 60000)
      server.listen(port, '127.0.0.1', () => {
        clearInterval(startupKeepAlive)
        startupKeepAlive = null
        process.stdout.write(JSON.stringify({ type: 'started', port }) + '\n')
      })
    } else if (msg.type === 'reload') {
      currentConfig = msg.config
      logEnabled = !!(msg.config.settings && msg.config.settings.logEnabled)
    } else if (msg.type === 'shutdown') {
      try { server.closeAllConnections() } catch {}
      server.close()
      process.exit(0)
    }
  }
})

// stdin 关闭时：未初始化则退出，已初始化则继续运行
process.stdin.on('end', () => {
  if (!initialized) {
    process.exit(1)
  }
})

// 防止 SSE 长连接被默认超时断开
server.keepAliveTimeout = 0
server.headersTimeout = 0

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stdout.write(JSON.stringify({ type: 'error', error: 'EADDRINUSE', message: err.message }) + '\n')
  }
})

// Tauri sidecar 生命周期由 Rust 端管理（SIGTERM + kill），
// stdin 关闭通常意味着父进程退出，此时服务器自动跟随退出。
