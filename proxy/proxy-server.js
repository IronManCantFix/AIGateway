// proxy/proxy-server.js
// 代理服务器 Sidecar 入口。通过 stdin/stdout JSON Lines IPC 接收配置。
// 对外暴露 /v1/chat/completions, /v1/responses, /v1/messages, /v1/models

import http from 'http'
import https from 'https'
import zlib from 'zlib'
import { StringDecoder } from 'string_decoder'
import { URL } from 'url'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import {
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
  setReasoningCache
} from './protocol-converters.js'
import { parseMultipartFields } from './multipart-scanner.js'
import { normalizeUsage, parseUsageFromResponse, estimateRequestTokens } from './token-usage.js'


// --- State ---

let currentConfig = null // { profile: {...}, models: [...] }
let logEnabled = false
let initialized = false
let startupKeepAlive = null
const rrCounters = {} // modelName → counter (round-robin load balancing)
const reasoningCache = new Map() // call_id → reasoning_content, for re-injection when clients strip non-standard fields
const REASONING_CACHE_MAX = 500
setReasoningCache(reasoningCache)

function cacheReasoning(callId, reasoning) {
  if (!callId || !reasoning) return
  if (reasoningCache.size >= REASONING_CACHE_MAX) {
    // Evict oldest 20% to avoid thrashing
    const evict = Math.floor(REASONING_CACHE_MAX * 0.2)
    const keys = reasoningCache.keys()
    for (let i = 0; i < evict; i++) reasoningCache.delete(keys.next().value)
  }
  reasoningCache.set(callId, reasoning)
}

// --- Path → source format mapping ---

const MAX_IMAGE_BODY = 200 * 1024 * 1024  // 200 MiB
const MAX_JSON_BODY = 200 * 1024 * 1024  // 200 MiB

const PATH_TO_SOURCE = {
  '/v1/chat/completions': 'chat_completions',
  '/v1/responses': 'responses',
  '/v1/messages': 'messages',
  '/chat/completions': 'chat_completions',
  '/responses': 'responses',
  '/messages': 'messages',
  '/v1/images/generations': 'image',
  '/v1/images/edits': 'image',
  '/v1beta/interactions': 'interactions'
}

// --- Provider type → target format + upstream path ---

const PROVIDER_META = {
  'openai-chat':        { target: 'chat_completions', path: '/v1/chat/completions' },
  'openai-response':    { target: 'responses',        path: '/v1/responses' },
  'anthropic-message':  { target: 'messages',         path: '/v1/messages', authType: 'x-api-key' },
  'newapi':             { target: 'chat_completions', path: '/v1/chat/completions' },
  'openai-image':       { target: 'image',            paths: {
                            '/v1/images/generations': '/v1/images/generations',
                            '/v1/images/edits':       '/v1/images/edits'
                          } },
  'google-gemini':      { target: 'chat_completions', path: '/v1beta/openai/chat/completions' },
  'google-nano-banana': { target: 'interactions', path: '/v1beta/interactions', authType: 'x-goog-api-key', paths: {
                            '/v1/images/generations': '/v1beta/interactions'
                          } }
}

const IMAGE_PROVIDERS = new Set(['openai-image', 'google-nano-banana'])
const INTERACTIONS_PROVIDERS = new Set(['google-nano-banana'])

// --- OpenAI → Nano Banana conversion helpers ---

const OPENAI_SIZE_TO_NANOBANANA = {
  '1024x1024': { aspect_ratio: '1:1', image_size: '1K' },
  '1792x1024': { aspect_ratio: '16:9', image_size: '2K' },
  '1024x1792': { aspect_ratio: '9:16', image_size: '2K' },
  '512x512':   { aspect_ratio: '1:1', image_size: '0.5K' },
  '256x256':   { aspect_ratio: '1:1', image_size: '0.5K' }
}

const NANOBANANA_RATIOS = [
  { ratio: '1:1', w: 1, h: 1 },
  { ratio: '16:9', w: 16, h: 9 },
  { ratio: '9:16', w: 9, h: 16 },
  { ratio: '4:3', w: 4, h: 3 },
  { ratio: '3:4', w: 3, h: 4 },
  { ratio: '3:2', w: 3, h: 2 },
  { ratio: '2:3', w: 2, h: 3 },
  { ratio: '5:4', w: 5, h: 4 },
  { ratio: '4:5', w: 4, h: 5 },
  { ratio: '21:9', w: 21, h: 9 }
]

function convertOpenAISizeToNanoBanana(size) {
  if (!size) return {}
  const direct = OPENAI_SIZE_TO_NANOBANANA[size]
  if (direct) return direct
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match) return {}
  const w = parseInt(match[1])
  const h = parseInt(match[2])
  const targetRatio = w / h
  let best = NANOBANANA_RATIOS[0]
  let bestDiff = Infinity
  for (const r of NANOBANANA_RATIOS) {
    const diff = Math.abs((r.w / r.h) - targetRatio)
    if (diff < bestDiff) { bestDiff = diff; best = r }
  }
  const maxDim = Math.max(w, h)
  const image_size = maxDim <= 512 ? '0.5K' : maxDim <= 1024 ? '1K' : '2K'
  return { aspect_ratio: best.ratio, image_size }
}

function convertOpenAIToNanoBanana(body, defaultModel) {
  const input = []
  if (body.prompt) {
    input.push({ type: 'text', text: body.prompt })
  }
  const result = {
    model: body.model || defaultModel,
    input: input.length === 1 ? input[0] : input
  }
  const format = convertOpenAISizeToNanoBanana(body.size)
  if (format.aspect_ratio || format.image_size) {
    result.response_format = { type: 'image', ...format }
  }
  return result
}

function convertNanoBananaResponseToOpenAI(interaction, responseFormat) {
  let base64Data = null
  let mimeType = 'image/png'
  let revisedPrompt = null
  if (interaction.output_image && interaction.output_image.data) {
    base64Data = interaction.output_image.data
    if (interaction.output_image.mime_type) mimeType = interaction.output_image.mime_type
  }
  if (!base64Data && Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      if (step.type === 'model_output' && Array.isArray(step.content)) {
        for (const block of step.content) {
          if (block.type === 'image' && block.data) {
            base64Data = block.data
            if (block.mime_type) mimeType = block.mime_type
          }
          if (block.type === 'text' && block.text) revisedPrompt = block.text
        }
      }
    }
  }
  if (!base64Data) return { created: Math.floor(Date.now() / 1000), data: [] }
  const item = {}
  if (responseFormat === 'url') {
    item.url = `data:${mimeType};base64,${base64Data}`
  } else {
    item.b64_json = base64Data
  }
  if (revisedPrompt) item.revised_prompt = revisedPrompt
  return { created: Math.floor(Date.now() / 1000), data: [item] }
}

// --- Read request body ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    req.on('data', c => {
      received += c.length
      if (received > MAX_JSON_BODY) {
        req.destroy()
        reject(new Error('JSON body too large (max 50 MiB)'))
        return
      }
      chunks.push(c)
    })
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

// Read entire body as a Buffer, enforcing a hard size limit (used for multipart).
function readBodyAsBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    let aborted = false
    req.on('data', c => {
      if (aborted) return
      received += c.length
      if (received > maxBytes) {
        aborted = true
        const err = new Error('payload too large')
        err.code = 'PAYLOAD_TOO_LARGE'
        reject(err)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)) })
    req.on('error', err => { if (!aborted) reject(err) })
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
    const flattenable = msg.content.every(c => c.type === 'input_text' || c.type === 'text')
    if (!flattenable) return msg
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

// --- Gemini thought_signature injection ---
// Gemini 3.x requires thought_signature on functionCall parts in conversation
// history. When acting as a protocol gateway the original signatures are lost,
// so we inject the official dummy value that bypasses validation.

const GEMINI_DUMMY_THOUGHT_SIG = 'skip_thought_signature_validator'

function injectGeminiThoughtSignatures(messages) {
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
    for (const tc of msg.tool_calls) {
      // Only inject if no thought_signature already present
      if (tc.extra_content?.google?.thought_signature) continue
      if (!tc.extra_content) tc.extra_content = {}
      if (!tc.extra_content.google) tc.extra_content.google = {}
      tc.extra_content.google.thought_signature = GEMINI_DUMMY_THOUGHT_SIG
    }
  }
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
    // Failed to create proxy agent
    return undefined
  }
}

function forwardRequest(clientReq, clientRes, upstreamUrl, apiKey, body, sseConverter, onResponseBody, responseBodyConverter, sourceFormat, profileId, contentType, onUpstreamResponse, authType) {
  const parsed = new URL(upstreamUrl)
  const isHttps = parsed.protocol === 'https:'
  const transport = isHttps ? https : http

  // 检查是否需要使用代理
  const proxyConfig = currentConfig?.settings?.httpProxy
  const agent = createProxyAgent(proxyConfig, isHttps, profileId)
  clientReq._usedProxy = !!agent

  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const effectiveContentType = contentType || 'application/json'

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: clientReq.method,
    agent,
    headers: (() => {
      // 透传客户端所有请求头，然后用代理自己的值覆盖需要控制的头
      const h = {}
      const skip = new Set(['host', 'connection', 'content-length', 'content-type', 'authorization', 'x-api-key', 'x-goog-api-key'])
      for (const [k, v] of Object.entries(clientReq.headers)) {
        if (!skip.has(k.toLowerCase())) h[k] = v
      }
      h['Content-Type'] = effectiveContentType
      h['Content-Length'] = bodyBuf.length
      // 认证头最后设置，确保不被客户端透传覆盖
      if (authType === 'x-goog-api-key') h['x-goog-api-key'] = apiKey
      else if (authType === 'x-api-key') h['x-api-key'] = apiKey
      else h['Authorization'] = `Bearer ${apiKey}`
      return h
    })()
  }

  const upstreamReq = transport.request(options, (upstreamRes) => {
    const isStreaming = upstreamRes.headers['content-type']?.includes('text/event-stream')

    // Failover callback: if it returns false, don't write to client (allow retry)
    if (onUpstreamResponse) {
      const shouldContinue = onUpstreamResponse(upstreamRes)
      if (!shouldContinue) {
        // Clean up the upstream request to prevent resource leaks
        upstreamReq.destroy()
        return
      }
    }

    // Decompress upstream response if content-encoded (gzip/deflate/br)
    const encoding = upstreamRes.headers['content-encoding']
    const decompressor = encoding === 'gzip' ? zlib.createGunzip()
      : encoding === 'deflate' ? zlib.createInflate()
      : encoding === 'br' ? zlib.createBrotliDecompress()
      : null
    if (decompressor) {
      upstreamRes.pipe(decompressor)
      upstreamRes.on('error', (e) => decompressor.destroy(e))
      decompressor.headers = upstreamRes.headers
      decompressor.statusCode = upstreamRes.statusCode
      upstreamRes = decompressor
    }

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
        // 客户端提前断开（如 Codex 收到 response.completed 后立即关闭连接）时，
        // 也要把已收到的响应体回传给日志记录，避免 token 统计缺失。
        if (onResponseBody) {
          const rawBuffer = Buffer.concat(rawChunks)
          if (rawBuffer.length > 0) onResponseBody(rawBuffer.toString('utf8'))
        }
        // bun 运行时下 res 的 close/finish 事件在客户端提前断开时可能不触发，
        // 直接调用主处理器的日志兜底回调，确保请求被记录。
        if (clientReq._finalizeLog) clientReq._finalizeLog()
        if (!clientRes.writableEnded) clientRes.end()
      }

      clientRes.on('error', cleanup)
      clientRes.on('close', cleanup)

      upstreamRes.on('error', cleanup)

      const decoder = new StringDecoder('utf8')
      let lineBuffer = ''
      const rawChunks = []
      let lineCount = 0
      let convertedCount = 0
      upstreamRes.on('data', (chunk) => {
        if (closed) return
        rawChunks.push(chunk)
        // StringDecoder 会正确处理多字节 UTF-8 字符在 chunk 边界被截断的情况，
        // 不完整的字节会被缓存到下一个 chunk 一起解码，避免中文乱码。
        lineBuffer += decoder.write(chunk)
        const lines = lineBuffer.split(/\r?\n/)
        lineBuffer = lines.pop() || ''

        for (const line of lines) {
          lineCount++
          const result = sseConverter(line)
          if (result) {
            convertedCount++
            clientRes.write(result)
          }
        }
      })

      upstreamRes.on('end', () => {
        if (closed) return
        closed = true
        clearInterval(keepAlive)
        // 刷出 StringDecoder 中可能缓存的最后几个字节
        const remaining = lineBuffer + decoder.end()
        if (remaining.trim()) {
          const result = sseConverter(remaining)
          if (result) clientRes.write(result)
        }
        // 上游连接断开但未发送 [DONE] 时，补发 response.completed 等收尾事件
        if (sseConverter.flush) {
          const flushed = sseConverter.flush()
          if (flushed) clientRes.write(flushed)
        }
        // Stream ended
        clientRes.end()
        const rawBuffer = Buffer.concat(rawChunks)
        if (onResponseBody) onResponseBody(rawBuffer.length > 0 ? rawBuffer.toString('utf8') : null)
        // bun 运行时下客户端提前断开（如 Codex 收到 response.completed 后立即关闭
        // 连接）时 finish/close 事件可能都不触发，SSE 流完整结束时直接记录日志。
        if (clientReq._finalizeLog) clientReq._finalizeLog()
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
        // 客户端提前断开时同样捕获已收到的响应体，保证 token 统计不丢失。
        if (onResponseBody) {
          const rawBuffer = Buffer.concat(rawChunks)
          if (rawBuffer.length > 0) onResponseBody(rawBuffer.toString('utf8'))
        }
        // bun 运行时兜底：直接触发日志记录，不依赖 res close/finish 事件。
        if (clientReq._finalizeLog) clientReq._finalizeLog()
        if (!clientRes.writableEnded) clientRes.end()
      }

      clientRes.on('error', cleanup)
      clientRes.on('close', cleanup)

      upstreamRes.on('error', cleanup)

      const rawChunks = []
      upstreamRes.on('data', (chunk) => {
        if (closed) return
        rawChunks.push(chunk)
        clientRes.write(chunk)
      })
      upstreamRes.on('end', () => {
        if (closed) return
        closed = true
        clearInterval(keepAlive)
        const rawBuffer = Buffer.concat(rawChunks)
        if (onResponseBody) onResponseBody(rawBuffer.length > 0 ? rawBuffer.toString('utf8') : null)
        // bun 运行时兜底：SSE 流完整结束时直接记录日志。
        if (clientReq._finalizeLog) clientReq._finalizeLog()
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

          // If upstream returned an error (4xx/5xx), forward it to the client
          // instead of trying to convert the error body into a valid response.
          if (data.error && upstreamRes.statusCode >= 400) {
            const errMsg = typeof data.error === 'object'
              ? (data.error.message || data.error.msg || JSON.stringify(data.error))
              : String(data.error)
            if (sourceFormat === 'responses') {
              const respId = 'resp_' + Date.now()
              clientRes.write(
                fmtResponsesSSE('response.created', { type: 'response.created', response: { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', error: null, output: [] } }) +
                fmtResponsesSSE('response.failed', { type: 'response.failed', response: { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'failed', error: { type: 'upstream_error', code: String(upstreamRes.statusCode), message: errMsg }, output: [] } })
              )
            } else if (sourceFormat === 'chat_completions') {
              clientRes.write(fmtOpenAISSE({ id: 'error', object: 'chat.completion', created: Math.floor(Date.now()), model: '', choices: [{ index: 0, message: { role: 'assistant', content: 'Upstream error ' + upstreamRes.statusCode + ': ' + errMsg }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }))
              clientRes.write('data: [DONE]\n\n')
            } else {
              // Anthropic Messages or unknown — just return JSON error
            }
            clientRes.end()
            if (onResponseBody) onResponseBody(rawBody)
            return
          }

          if (sourceFormat === 'responses') {
            // Upstream returned non-streaming Chat/Messages JSON, client expects Responses SSE
            let content, toolCallItems, fullReasoning = ''
            if (data.type === 'message' && Array.isArray(data.content)) {
              content = data.content.filter(c => c.type === 'text').map(c => c.text).join('')
              fullReasoning = data.content.filter(c => c.type === 'thinking').map(c => c.thinking || '').join('')
              toolCallItems = (data.content || []).filter(c => c.type === 'tool_use').map(c => ({
                type: 'function_call', id: c.id || ('fc_' + Date.now()), status: 'completed', call_id: c.id || ('call_' + Date.now()), name: c.name || '', arguments: JSON.stringify(c.input || {})
              }))
            } else {
              const choice = data.choices?.[0]
              const message = choice?.message || {}
              content = message.content || ''
              fullReasoning = message.reasoning_content || ''
              toolCallItems = (message.tool_calls || []).map(tc => ({
                type: 'function_call', id: tc.id || ('fc_' + Date.now()), status: 'completed', call_id: tc.id || ('call_' + Date.now()), name: tc.function?.name || '', arguments: tc.function?.arguments || ''
              }))
            }
            const model = data.model || ''
            const inputTokens = data.usage?.input_tokens || data.usage?.prompt_tokens || 0
            const outputTokens = data.usage?.output_tokens || data.usage?.completion_tokens || 0
            const responseId = 'resp_' + Date.now()
            const itemId = 'msg_' + Date.now()

            function makeResp(overrides) {
              return Object.assign({ id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model, output: [], parallel_tool_calls: true, previous_response_id: null, reasoning: { effort: null, summary: null }, store: true, temperature: 1.0, text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], top_p: 1.0, truncation: 'disabled', usage: null, user: null, metadata: {} }, overrides)
            }

            const outputItems = []
            let out = fmtResponsesSSE('response.created', { type: 'response.created', response: makeResp({ status: 'in_progress' }) }) +
              fmtResponsesSSE('response.in_progress', { type: 'response.in_progress', response: makeResp({ status: 'in_progress' }) })

            // Detect empty upstream response (model received input but produced no content)
            if (!content && toolCallItems.length === 0 && inputTokens > 0) {
              content = `[Error] Upstream model returned empty response (input_tokens: ${inputTokens}, output_tokens: ${outputTokens}). This may indicate the prompt is too long, the model failed to generate content, or the request was rejected by the upstream provider.`
            }

            // Always emit a message output item (even if content is empty/null)
            // to satisfy clients like Codex that require non-empty output
            {
              const text = content || ''
              out += fmtResponsesSSE('response.output_item.added', { type: 'response.output_item.added', output_index: outputItems.length, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }) +
                fmtResponsesSSE('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: outputItems.length, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
              if (text) {
                out += fmtResponsesSSE('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: outputItems.length, content_index: 0, delta: text })
              }
              const reasoningFields = fullReasoning ? { reasoning_content: fullReasoning, metadata: { _reasoning_content: fullReasoning } } : {}
              out += fmtResponsesSSE('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: outputItems.length, content_index: 0, text: text }) +
                fmtResponsesSSE('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: outputItems.length, content_index: 0, part: { type: 'output_text', text: text, annotations: [] } }) +
                fmtResponsesSSE('response.output_item.done', { type: 'response.output_item.done', output_index: outputItems.length, item: { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: text, annotations: [] }], ...reasoningFields } })
              outputItems.push({ id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: text, annotations: [] }], ...reasoningFields })
            }

            const toolReasoningFields = fullReasoning ? { reasoning_content: fullReasoning, metadata: { _reasoning_content: fullReasoning } } : {}
            for (const toolItem of toolCallItems) {
              const oi = outputItems.length
              out += fmtResponsesSSE('response.output_item.added', { type: 'response.output_item.added', output_index: oi, item: { ...toolItem, status: 'in_progress' } }) +
                fmtResponseEvent('response.function_call_arguments.done', responseId, { item_id: toolItem.call_id, output_index: oi, call_id: toolItem.call_id, name: toolItem.name, arguments: toolItem.arguments }) +
                fmtResponsesSSE('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item: { ...toolItem, ...toolReasoningFields } })
              outputItems.push({ ...toolItem, ...toolReasoningFields })
              // Cache reasoning by call_id for re-injection when client echoes back stripped function_call items
              cacheReasoning(toolItem.call_id, fullReasoning)
            }

            out += fmtResponsesSSE('response.completed', { type: 'response.completed', response: makeResp({ status: 'completed', output: outputItems, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }) })

            clientRes.write(out)
          } else if (sourceFormat === 'chat_completions') {
            // Client expects Chat Completions SSE
            let content, model, finishReason, toolCalls, fullReasoning = ''
            if (data.type === 'message' && Array.isArray(data.content)) {
              content = data.content.filter(c => c.type === 'text').map(c => c.text).join('')
              fullReasoning = data.content.filter(c => c.type === 'thinking').map(c => c.thinking || '').join('')
              model = data.model || ''
              const reverseStop = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls' }
              finishReason = reverseStop[data.stop_reason] || data.stop_reason || 'stop'
              const toolUseBlocks = (data.content || []).filter(c => c.type === 'tool_use')
              toolCalls = toolUseBlocks.map(c => ({
                id: c.id || ('call_' + Date.now()),
                type: 'function',
                function: { name: c.name || '', arguments: JSON.stringify(c.input || {}) }
              }))
            } else {
              const choice = data.choices?.[0]
              const message = choice?.message || {}
              content = message.content || ''
              fullReasoning = message.reasoning_content || ''
              model = data.model || ''
              finishReason = choice?.finish_reason || 'stop'
              toolCalls = message.tool_calls || []
            }
            const chatId = 'chatcmpl-' + Date.now()

            let out = fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
            if (fullReasoning) {
              out += fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { reasoning_content: fullReasoning }, finish_reason: null }] })
            }
            if (toolCalls && toolCalls.length > 0) {
              for (let i = 0; i < toolCalls.length; i++) {
                const tc = toolCalls[i]
                out += fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }] })
                if (tc.function.arguments) {
                  out += fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }, finish_reason: null }] })
                }
              }
            }
            if (content) {
              out += fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: { content: content }, finish_reason: null }] })
            }
            out += fmtOpenAISSE({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()), model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }) +
              'data: [DONE]\n\n'

            clientRes.write(out)
          } else {
            // Client expects Anthropic Messages SSE
            let role, model, reasoning, inputTokens, outputTokens, stopReason, contentBlocks

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
              for (const tc of message.tool_calls || []) {
                contentBlocks.push({
                  type: 'tool_use',
                  id: tc.id || ('toolu_' + Date.now()),
                  name: tc.function?.name || '',
                  input: parseMaybeJson(tc.function?.arguments, {})
                })
              }
              inputTokens = data.usage?.prompt_tokens || 0
              outputTokens = data.usage?.completion_tokens || 0
              stopReason = mapFinishReason(choice?.finish_reason || 'stop')
            }

            const msgId = 'msg_' + Date.now()
            let idx = 0

            let out = fmtAnthropicSSE('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role, model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } })

            let hasTextBlock = false
            for (const block of contentBlocks) {
              if (block.type === 'thinking') {
                out += fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } }) +
                       fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: block.thinking || '' } }) +
                       fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: idx })
                idx++
              } else if (block.type === 'text') {
                hasTextBlock = true
                out += fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }) +
                       fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: block.text || '' } }) +
                       fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: idx })
                idx++
              } else if (block.type === 'tool_use') {
                out += fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: block.id || ('toolu_' + Date.now()), name: block.name || '', input: {} } }) +
                       fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } }) +
                       fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: idx })
                idx++
              }
            }

            // Ensure at least one text block exists
            if (!hasTextBlock) {
              out += fmtAnthropicSSE('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }) +
                     fmtAnthropicSSE('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: '' } }) +
                     fmtAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: idx })
            }

            out += fmtAnthropicSSE('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } }) +
                   fmtAnthropicSSE('message_stop', { type: 'message_stop' })

            clientRes.write(out)
          }
          if (onResponseBody) onResponseBody(rawBody)
        } catch (e) {
          // Non-streaming SSE conversion failed
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
            const converted = responseBodyConverter(parsed)
            // Cache reasoning_content by call_id for re-injection when clients strip non-standard fields
            if (converted?.output) {
              let reasoning = ''
              for (const item of converted.output) {
                if (item.reasoning_content) reasoning = item.reasoning_content
                if (item.type === 'function_call' && item.call_id) {
                  cacheReasoning(item.call_id, reasoning)
                }
              }
            }
            responseBody = JSON.stringify(converted)
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

  upstreamReq.setTimeout(600000, () => {
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

  upstreamReq.write(bodyBuf)
  upstreamReq.end()
}

// --- Model strategy helpers ---

function getModelStrategy(requestedModel) {
  if (!requestedModel) return 'none'
  // Strategies are stored per model name in currentConfig.modelStrategies
  if (currentConfig?.modelStrategies && currentConfig.modelStrategies[requestedModel]) {
    return currentConfig.modelStrategies[requestedModel]
  }
  // Fallback: read from the models array entries ({ name, strategy })
  if (currentConfig?.models) {
    for (const m of currentConfig.models) {
      if (typeof m === 'object' && m.name === requestedModel && m.strategy) {
        return m.strategy
      }
    }
  }
  return 'none'
}

function getProfilesForModel(requestedModel, source) {
  return currentConfig.profiles.filter(p => {
    if (source === 'image' && !IMAGE_PROVIDERS.has(p.providerType)) return false
    if (source !== 'image' && !INTERACTIONS_PROVIDERS.has(p.providerType) && IMAGE_PROVIDERS.has(p.providerType)) return false
    return Array.isArray(p.models) && p.models.includes(requestedModel)
  })
}

function selectRoundRobinForModel(requestedModel, profiles) {
  const idx = (rrCounters[requestedModel] || 0) % profiles.length
  rrCounters[requestedModel] = idx + 1
  return profiles[idx]
}

// 调用 Anthropic 原生上游的 /v1/messages/count_tokens 获取精确计数。
// 仅当 profile 上游为 Anthropic Messages 协议时可用，失败时由调用方回退本地估算。
function countTokensUpstream(profile, body) {
  return new Promise((resolve, reject) => {
    const meta = PROVIDER_META[profile.providerType]
    const baseUrl = (profile.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')
    const parsed = new URL(`${baseUrl}/v1/messages/count_tokens`)
    const isHttps = parsed.protocol === 'https:'
    const transport = isHttps ? https : http
    const proxyConfig = currentConfig?.settings?.httpProxy
    const agent = createProxyAgent(proxyConfig, isHttps, profile.id)
    const bodyBuf = Buffer.from(JSON.stringify(body))
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      agent,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        'anthropic-version': '2023-06-01',
        ...(meta.authType === 'x-api-key'
          ? { 'x-api-key': profile.apiKey }
          : { 'Authorization': `Bearer ${profile.apiKey}` })
      }
    }
    const upstreamReq = transport.request(options, (upstreamRes) => {
      const chunks = []
      upstreamRes.on('data', (c) => chunks.push(c))
      upstreamRes.on('end', () => {
        if (upstreamRes.statusCode !== 200) {
          reject(new Error(`upstream count_tokens status ${upstreamRes.statusCode}`))
          return
        }
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString())
          if (typeof data.input_tokens === 'number') resolve(data.input_tokens)
          else reject(new Error('upstream count_tokens missing input_tokens'))
        } catch (e) {
          reject(e)
        }
      })
    })
    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('count_tokens timeout')))
    upstreamReq.on('error', reject)
    upstreamReq.write(bodyBuf)
    upstreamReq.end()
  })
}

// --- Route: /v1/models ---

// In-flight "please give me the freshest config" requests to the parent
// process. Each request carries an id; the parent answers with a
// config_update message carrying the same id.
let configRequestSeq = 0
const pendingConfigRequests = new Map() // id → { resolve, timer }

function requestLatestConfig() {
  return new Promise((resolve) => {
    const id = ++configRequestSeq
    const timer = setTimeout(() => {
      pendingConfigRequests.delete(id)
      resolve(null) // parent did not answer in time; fall back to currentConfig
    }, 1000)
    pendingConfigRequests.set(id, { resolve, timer })
    process.stdout.write(JSON.stringify({ type: 'config_request', id }) + '\n')
  })
}

async function handleModels(_, res) {
  // 配置可能随时变动（增删 profile、启用/停用等），每次请求都向父进程拉取
  // 最新配置，保证与首页"可用模型"（已启用 profile 的模型并集）一致。
  const freshConfig = await requestLatestConfig()
  if (freshConfig && Array.isArray(freshConfig.profiles)) {
    currentConfig = freshConfig
  }
  const providerModels = (currentConfig && currentConfig.profiles)
    ? currentConfig.profiles.flatMap(p => (Array.isArray(p.models) ? p.models : []))
    : []
  const allModels = [...new Set(providerModels)]
  const data = allModels.map(id => ({ id, object: 'model', owned_by: 'aigateway' }))
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ object: 'list', data }))
}

// --- Handle API request ---

async function handleApiRequest(req, res) {
  const urlPath = req.url.split('?')[0]
  const isModelsEndpoint = urlPath === '/v1/models' && req.method === 'GET'
  // Check active profiles. /v1/models 例外：它每次都会向父进程拉取最新配置，
  // 不应因为本地快照为空而直接返回 503。
  if (!isModelsEndpoint && (!currentConfig || !currentConfig.profiles || currentConfig.profiles.length === 0)) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Service Unavailable: no active profile configured' }))
    return
  }

  const source = PATH_TO_SOURCE[urlPath]

  if (!source) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not Found' }))
    return
  }

  let body = req._body
  let multipartFields = null
  let multipartFiles = null

  if (source === 'image' && req._rawBuffer) {
    // multipart path
    const boundaryMatch = /boundary=("?)([^";]+)\1/i.exec(req._contentType || '')
    if (!boundaryMatch) {
      const errBody = JSON.stringify({ error: 'Bad multipart: missing boundary' })
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(errBody)
      if (req._onResponseBody) req._onResponseBody(errBody)
      return
    }
    try {
      const parsed = parseMultipartFields(req._rawBuffer, boundaryMatch[2])
      multipartFields = parsed.fields
      multipartFiles = parsed.files
    } catch (e) {
      const errBody = JSON.stringify({ error: 'Bad multipart: ' + e.message })
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(errBody)
      if (req._onResponseBody) req._onResponseBody(errBody)
      return
    }
    body = { model: multipartFields.model }  // placeholder used only for routing
    req._loggedRequestBody = { fields: multipartFields, files: multipartFiles }
    req._resolvedModel = multipartFields.model || '-'
  } else if (!body) {
    try {
      body = await readBody(req)
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }
  }

  if (source !== 'image') {
    // Clean malformed body: strip "[undefined]" strings, flatten input_text content arrays
    body = cleanBody(body)
    body = flattenBodyMessages(body)
  }

  // Apply model mapping if enabled
  let originalModel = body.model
  let modelMappingInfo = null
  if (currentConfig.modelMappings && currentConfig.modelMappings.enabled && body.model) {
    for (const rule of currentConfig.modelMappings.rules) {
      if (body.model.toLowerCase() === rule.from.toLowerCase()) {
        body.model = rule.to
        modelMappingInfo = rule.to
        req._originalModel = originalModel
        req._modelMapping = modelMappingInfo
        // Model mapping applied
        break
      }
    }
  }

  // Route by model: find profile based on per-model strategy
  const requestedModel = body.model
  let profile = null
  let modelStrategy = 'none'

  if (requestedModel) {
    modelStrategy = getModelStrategy(requestedModel)
    const candidates = getProfilesForModel(requestedModel, source)

    if (modelStrategy === 'round-robin') {
      if (candidates.length > 0) {
        profile = selectRoundRobinForModel(requestedModel, candidates)
      }
    } else if (modelStrategy === 'failover') {
      // Failover: pick the first matching profile; retry logic is handled later
      if (candidates.length > 0) {
        profile = candidates[0]
      }
    } else {
      // 'none': use first matching profile (profile list order = priority)
      if (candidates.length > 0) {
        profile = candidates[0]
      }
    }

    if (!profile) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `No matching provider for model: ${requestedModel}`, type: 'invalid_request_error', code: 'model_not_found' } }))
      return
    }
  } else {
    // No model specified — use the first profile with models (matching source family)
    for (const p of currentConfig.profiles) {
      if (source === 'image' && !IMAGE_PROVIDERS.has(p.providerType)) continue
      if (source !== 'image' && !INTERACTIONS_PROVIDERS.has(p.providerType) && IMAGE_PROVIDERS.has(p.providerType)) continue
      if (Array.isArray(p.models) && p.models.length > 0) {
        profile = p
        break
      }
    }
    if (!profile) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Service Unavailable: no available provider configured' }))
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
  if (source !== 'image') {
    const bodyConverter = getBodyConverter(source, meta.target)
    let bodySizeBefore = JSON.stringify(body).length
    if (bodyConverter) {
      body = bodyConverter(body)
    }
    let bodySizeAfter = JSON.stringify(body).length
    req._bodySizeBefore = bodySizeBefore
    req._bodySizeAfter = bodySizeAfter
  } else {
    const size = req._rawBuffer ? req._rawBuffer.length : JSON.stringify(body).length
    req._bodySizeBefore = size
    req._bodySizeAfter = size
  }

  // OpenAI Chat-compatible providers expect system instructions inside
  // messages[]. Anthropic Messages-compatible providers require the top-level
  // system field, so leave it untouched for meta.target === 'messages'.
  if (source !== 'image' && body.system && meta.target === 'chat_completions' && profile.providerType !== 'newapi' && Array.isArray(body.messages)) {
    body.messages.unshift({ role: 'system', content: body.system })
    delete body.system
  }

  // Gemini 3.x models require thought_signature on functionCall parts in
  // conversation history. When protocol conversion strips these (e.g.
  // Anthropic Messages → Chat Completions), we inject the official dummy
  // value "skip_thought_signature_validator" so the request is accepted.
  // See: https://ai.google.dev/gemini-api/docs/thought-signatures
  if (profile.providerType === 'google-gemini' && Array.isArray(body.messages)) {
    injectGeminiThoughtSignatures(body.messages)
  }

  const baseUrl = profile.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  let upstreamPath
  if (source === 'image') {
    upstreamPath = meta.paths[urlPath]
    if (!upstreamPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not Found' }))
      return
    }
  } else {
    upstreamPath = meta.path
  }
  const upstreamUrl = `${baseUrl}${upstreamPath}`
  req._upstreamUrl = upstreamUrl

  if (source === 'image') {
    // OpenAI → Nano Banana conversion
    if (profile.providerType === 'google-nano-banana' && urlPath === '/v1/images/generations') {
      const nanoBody = convertOpenAIToNanoBanana(body, profile.defaultModel)
      req._upstreamUrl = upstreamUrl

      const parsed = new URL(upstreamUrl)
      const proxyConfig = currentConfig?.settings?.httpProxy
      const agent = createProxyAgent(proxyConfig, true, profile.id)
      const bodyBuf = Buffer.from(JSON.stringify(nanoBody))

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length,
          'x-goog-api-key': profile.apiKey
        }
      }

      const upstreamReq = https.request(options, (upstreamRes) => {
        const encoding = upstreamRes.headers['content-encoding']
        const decompressor = encoding === 'gzip' ? zlib.createGunzip()
          : encoding === 'deflate' ? zlib.createInflate()
          : encoding === 'br' ? zlib.createBrotliDecompress()
          : null
        if (decompressor) {
          upstreamRes.pipe(decompressor)
          upstreamRes.on('error', (e) => decompressor.destroy(e))
          decompressor.headers = upstreamRes.headers
          decompressor.statusCode = upstreamRes.statusCode
          upstreamRes = decompressor
        }

        const chunks = []
        upstreamRes.on('data', c => chunks.push(c))
        upstreamRes.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString()
          if (upstreamRes.statusCode >= 400) {
            res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json' })
            res.end(rawBody)
            if (req._onResponseBody) req._onResponseBody(rawBody)
            return
          }
          try {
            const interaction = JSON.parse(rawBody)
            const openaiResponse = convertNanoBananaResponseToOpenAI(interaction, body.response_format)
            const responseBody = JSON.stringify(openaiResponse)
            res.writeHead(upstreamRes.statusCode || 200, { 'Content-Type': 'application/json' })
            res.end(responseBody)
            if (req._onResponseBody) req._onResponseBody(responseBody)
          } catch (e) {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Bad Gateway', message: 'Failed to convert Nano Banana response: ' + e.message }))
          }
        })
      })

      upstreamReq.setTimeout(600000, () => {
        upstreamReq.destroy(new Error('upstream request timeout'))
      })

      upstreamReq.on('error', (err) => {
        if (!res.headersSent) {
          const errorBody = JSON.stringify({ error: 'Bad Gateway', message: err.message })
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(errorBody)
          if (req._onResponseBody) req._onResponseBody(errorBody)
        }
      })

      upstreamReq.write(bodyBuf)
      upstreamReq.end()
      return
    }

    // No SSE, no body conversion — pass through.
    const rawBuffer = req._rawBuffer  // null for JSON path
    forwardRequest(req, res, upstreamUrl, profile.apiKey,
      rawBuffer || body,
      null,
      req._onResponseBody || null,
      null,
      source,
      profile.id,
      rawBuffer ? req._contentType : 'application/json'
    )
    return
  }

  if (source === 'interactions') {
    // Native pass-through: forward request body as-is to Google Interactions API
    forwardRequest(req, res, upstreamUrl, profile.apiKey, body,
      null, req._onResponseBody || null, null, source, profile.id, 'application/json',
      null, meta.authType)
    return
  }

  const needStream = req.headers.accept?.includes('text/event-stream') || body.stream
  // 仅当客户端为 Anthropic、上游为 Chat 时需要估算输入 token，
  // 用于 message_start 的 usage（OpenAI 上游流式末尾才返回真实 usage）
  const estimatedInputTokens = source === 'messages' && meta.target === 'chat_completions' ? estimateRequestTokens(body) : 0
  let sseConverter = needStream ? createSSEConverter(source, meta.target, estimatedInputTokens) : null
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

  // Failover: try providers in order, retry on HTTP error before data is sent
  if (modelStrategy === 'failover') {
    const candidates = getProfilesForModel(requestedModel, source)
    const triedIds = new Set()
    let currentProfile = profile
    let lastError = null

    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const pid = currentProfile.id
      triedIds.add(pid)

      const curMeta = PROVIDER_META[currentProfile.providerType]
      if (!curMeta) break

      let curBody = { ...body }
      if (!curBody.model && currentProfile.defaultModel) {
        curBody.model = currentProfile.defaultModel
      }
      if (source !== 'image') {
        const bc = getBodyConverter(source, curMeta.target)
        if (bc) curBody = bc(curBody)
        if (curBody.system && curMeta.target === 'chat_completions' && currentProfile.providerType !== 'newapi' && Array.isArray(curBody.messages)) {
          curBody.messages.unshift({ role: 'system', content: curBody.system })
          delete curBody.system
        }
        if (currentProfile.providerType === 'google-gemini' && Array.isArray(curBody.messages)) {
          injectGeminiThoughtSignatures(curBody.messages)
        }
      }

      const curBaseUrl = currentProfile.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
      const curUpstreamPath = curMeta.path
      const curUpstreamUrl = `${curBaseUrl}${curUpstreamPath}`
      req._upstreamUrl = curUpstreamUrl
      req._providerName = currentProfile.name

      const curSseConverter = needStream ? createSSEConverter(source, curMeta.target) : null
      const curResponseBodyConverter = getResponseBodyConverter(source, curMeta.target)

      let failed = false
      forwardRequest(req, res, curUpstreamUrl, currentProfile.apiKey, curBody,
        curSseConverter, req._onResponseBody || null, curResponseBodyConverter,
        source, currentProfile.id, null,
        (upstreamRes) => {
          if (upstreamRes.statusCode >= 400 && !res.headersSent) {
            failed = true
            lastError = upstreamRes.statusCode
            upstreamRes.resume()
            return false
          }
          return true
        },
        curMeta.authType
      )

      if (!failed) return

      // Find next profile that we haven't tried
      const nextProfile = candidates.find(p => !triedIds.has(p.id))
      if (!nextProfile) break
      currentProfile = nextProfile
    }

    // All providers failed
    if (!res.headersSent) {
      res.writeHead(lastError || 502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Bad Gateway', message: 'All upstream providers failed' }))
    }
    return
  }

  // Normal forwarding (non-failover)
  forwardRequest(req, res, upstreamUrl, profile.apiKey, body, sseConverter,
    req._onResponseBody || null,
    responseBodyConverter,
    source,
    profile.id,
    null,
    null,
    meta.authType
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
    if (extra.method) data.method = extra.method
    if (extra.upstreamUrl) data.upstreamUrl = extra.upstreamUrl
    if (extra.usedProxy) data.proxy = true
    if (extra.modelMapping) data.modelMapping = extra.modelMapping
    if (extra.originalModel) data.originalModel = extra.originalModel
    if (extra.bodySizeBefore != null) data.bodySizeBefore = extra.bodySizeBefore
    if (extra.bodySizeAfter != null) data.bodySizeAfter = extra.bodySizeAfter
  }
  // 解析 token 使用量（无论 logEnabled 状态，优先解析）
  if (responseBody) {
    try {
      const usage = parseUsageFromResponse(responseBody)
      if (usage) {
        data.promptTokens = usage.prompt_tokens
        data.completionTokens = usage.completion_tokens
        data.totalTokens = usage.total_tokens
      }
    } catch {}
  }
  // 仅当开启详细日志时才记录请求/响应体
  if (logEnabled) {
    data.requestBody = requestBody ? JSON.stringify(requestBody) : null
    data.responseBody = responseBody || null
  }
  // 404 请求始终记录请求体和响应体（用于排查问题）
  if (statusCode === 404) {
    if (requestBody) data.requestBody = JSON.stringify(requestBody)
    if (responseBody) data.responseBody = responseBody
  }
  process.stdout.write(JSON.stringify({ type: 'log', data }) + '\n')
}

const server = http.createServer(async (req, res) => {
  // 请求级超时：20 分钟，防止僵尸连接无限存活
  const REQUEST_TIMEOUT = 1200000
  req.setTimeout(REQUEST_TIMEOUT, () => {
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Gateway Timeout', message: 'request timeout (20min)' }))
    } else {
      res.end()
    }
  })
  res.setTimeout(0)
  const startTime = Date.now()
  const endpoint = req.url
  const urlPath = endpoint.split('?')[0]
  let model = '-'
  let rawBody = null
  let responseBody = null

  try {
    if (urlPath === '/v1/models' && req.method === 'GET') {
      await handleModels(req, res)
      res.on('finish', () => {
        logRequest(endpoint, '-', res.statusCode, Date.now() - startTime, null, null, null, '-', { method: req.method })
      })
      return
    } else if (urlPath === '/v1/messages/count_tokens') {
      // Anthropic token counting endpoint
      rawBody = await readBody(req)
      model = (rawBody && rawBody.model) || '-'
      // 优先使用上游真实计数：Anthropic 原生上游支持 count_tokens 端点；
      // 非 Anthropic 上游或调用失败时，回退到本地估算（接口返回为空才函数计算）
      let inputTokens = null
      if (rawBody && currentConfig && Array.isArray(currentConfig.profiles)) {
        const candidates = model ? getProfilesForModel(model, 'messages') : []
        const profile = candidates[0]
        if (profile && PROVIDER_META[profile.providerType]?.target === 'messages') {
          try {
            inputTokens = await countTokensUpstream(profile, rawBody)
          } catch {}
        }
      }
      if (inputTokens == null) {
        // 按语言加权估算：CJK 约 1 token/字，其余约 1 token/4 字符
        inputTokens = estimateRequestTokens(rawBody)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: inputTokens }))
      logRequest(endpoint, model, 200, Date.now() - startTime, null, rawBody, null, '-', { method: req.method })
      return
    } else if (PATH_TO_SOURCE[urlPath]) {
      const ct = req.headers['content-type'] || ''
      const isMultipart = PATH_TO_SOURCE[urlPath] === 'image' && ct.startsWith('multipart/form-data')
      if (isMultipart) {
        try {
          req._rawBuffer = await readBodyAsBuffer(req, MAX_IMAGE_BODY)
        } catch (e) {
          if (e.code === 'PAYLOAD_TOO_LARGE') {
            const errBody = JSON.stringify({ error: 'Payload Too Large', maxBytes: MAX_IMAGE_BODY })
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(errBody)
            req.resume()  // drain remaining upload bytes; socket closes after res.end flushes
            logRequest(endpoint, '-', 413, Date.now() - startTime, 'payload_too_large', null, errBody, '-', { method: req.method })
            return
          }
          throw e
        }
        req._contentType = ct
        // model resolved later inside handleApiRequest
      } else {
        rawBody = await readBody(req)
        model = (rawBody && rawBody.model) || '-'
        req._body = rawBody
      }
      // 始终捕获响应体用于 token 统计，无论 logEnabled 状态
      req._onResponseBody = (body) => {
        responseBody = (PATH_TO_SOURCE[urlPath] === 'image') ? sanitizeImageResponseBody(body) : body
      }
      await handleApiRequest(req, res)
      // multipart 路径 handleApiRequest 会回写以下两个字段供日志使用
      if (req._loggedRequestBody) rawBody = req._loggedRequestBody
      if (req._resolvedModel) model = req._resolvedModel
      // handleApiRequest may have mapped the model — use mapped name for log
      if (req._modelMapping) {
        model = req._modelMapping
      }
    } else {
      // 尝试读取请求体用于日志记录
      let bodyForLog = null
      try {
        bodyForLog = await readBody(req)
      } catch {}

      const notFoundBody = JSON.stringify({ error: 'Not Found' })
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(notFoundBody)
      // 尝试从请求体中提取 model，便于排查
      const modelFromBody = (bodyForLog && bodyForLog.model) || '-'
      logRequest(endpoint, modelFromBody, 404, Date.now() - startTime, 'route_not_found', bodyForLog, notFoundBody, '-', { method: req.method })
      return
    }
  } catch (err) {
    if (!res.headersSent) {
      const errorBody = JSON.stringify({ error: 'Internal Server Error', message: err.message })
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(errorBody)
      responseBody = errorBody
    }
    model = model || '-'
    const errExtra = { method: req.method, upstreamUrl: req._upstreamUrl, usedProxy: req._usedProxy, modelMapping: req._modelMapping, originalModel: req._originalModel, bodySizeBefore: req._bodySizeBefore, bodySizeAfter: req._bodySizeAfter }
    logRequest(endpoint, model, res.statusCode || 500, Date.now() - startTime, err.message, rawBody, responseBody, req._providerName, errExtra)
    return
  }

  // 仅监听 finish 时，客户端提前断开（如 Codex 收到 response.completed 后立即关闭连接）
  // 会导致 finish 永不触发，请求完全丢失日志与统计。因此同时监听 finish 和 close，
  // 并用 logged 守卫保证同一请求只记录一次。
  let logged = false
  const finalizeLog = () => {
    if (logged) return
    logged = true
    const extra = { method: req.method, upstreamUrl: req._upstreamUrl, usedProxy: req._usedProxy, modelMapping: req._modelMapping, originalModel: req._originalModel, bodySizeBefore: req._bodySizeBefore, bodySizeAfter: req._bodySizeAfter }
    logRequest(endpoint, model, res.statusCode, Date.now() - startTime, null, rawBody, responseBody, req._providerName, extra)
  }
  // bun 运行时下 res 的 close 事件在客户端提前断开时可能不触发，
  // 因此把 finalizeLog 挂到 req 上供 forwardRequest 直接调用，并监听
  // req 的 close/aborted 作为额外兜底。logged 守卫保证只记录一次。
  req._finalizeLog = finalizeLog
  res.on('finish', finalizeLog)
  res.on('close', finalizeLog)
  req.on('close', finalizeLog)
  req.on('aborted', finalizeLog)
})

function sanitizeImageResponseBody(rawText) {
  if (!rawText) return rawText
  try {
    const obj = JSON.parse(rawText)
    if (obj && Array.isArray(obj.data)) {
      obj.data = obj.data.map(item => {
        if (item && typeof item.b64_json === 'string') {
          return { ...item, b64_json: `<base64 stripped, length=${item.b64_json.length}>` }
        }
        return item
      })
    }
    return JSON.stringify(obj)
  } catch {
    return rawText
  }
}

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
      // keepalive timer: bun compile 会优化掉空回调的 timer
      // 使用有 I/O 副作用的回调防止被优化
      startupKeepAlive = setInterval(() => {
        // noop with side-effect: touch a global to prevent dead-code elimination
        globalThis.__proxy_keepalive = Date.now()
      }, 60000)
      server.listen(port, '127.0.0.1', () => {
        clearInterval(startupKeepAlive)
        startupKeepAlive = null
        process.stdout.write(JSON.stringify({ type: 'started', port }) + '\n')
      })
    } else if (msg.type === 'reload') {
      currentConfig = msg.config
      logEnabled = !!(msg.config.settings && msg.config.settings.logEnabled)
    } else if (msg.type === 'config_update') {
      if (msg.config && Array.isArray(msg.config.profiles)) {
        currentConfig = msg.config
        logEnabled = !!(msg.config.settings && msg.config.settings.logEnabled)
      }
      if (msg.id !== undefined && msg.id !== null && pendingConfigRequests.has(msg.id)) {
        const pending = pendingConfigRequests.get(msg.id)
        clearTimeout(pending.timer)
        pendingConfigRequests.delete(msg.id)
        pending.resolve(msg.config || null)
      }
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
