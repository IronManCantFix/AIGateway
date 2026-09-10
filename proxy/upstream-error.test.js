// 上游报错透传 & Anthropic tool_choice 转换的端到端回归。
//
// 背景（真实故障）：CherryStudio 以 Anthropic 协议请求 /v1/messages，
// tool_choice 为 {"type":"auto"}。网关把 messages 转成 chat_completions 时
// tool_choice 原样透传，上游（OpenRouter 风格中转）只认 function 形式，
// 返回 400 {"code":"UNSUPPORTED_FIELD","message":"当前只支持 function tool_choice..."}。
// 由于该错误信封没有 error 字段，网关又把它当成正常响应做了协议转换，
// 结果客户端只拿到一个内容为空的假成功响应，错误原因彻底丢失。
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import http from 'node:http'

const PROXY_SCRIPT = fileURLToPath(new URL('./proxy-server.js', import.meta.url))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

// 本地 mock 上游：handler 自行决定响应
function startUpstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => handler(req, res, body))
    })
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
}

function okChatResponse(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'm1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }))
}

// tokenrhythm 风格错误信封：没有 error 字段
function nonStandardErrorResponse(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    code: 'UNSUPPORTED_FIELD',
    message,
    data: { field: 'tool_choice' },
    traceId: 'trace_test'
  }))
}

function profile(id, name, baseUrl, models) {
  return { id, name, providerType: 'openai-chat', baseUrl, apiKey: 'k', defaultModel: '', models }
}

function config(port, profiles) {
  return {
    profiles,
    models: [],
    modelStrategies: {},
    modelMappings: { enabled: false, rules: [] },
    settings: { port, logEnabled: false, httpProxy: null }
  }
}

function makeLineReader(child) {
  const queue = []
  const waiters = []
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    const parts = buf.split('\n')
    buf = parts.pop() || ''
    for (const p of parts) {
      if (!p.trim()) continue
      const wi = waiters.findIndex((w) => w.pred(p))
      if (wi >= 0) {
        const [w] = waiters.splice(wi, 1)
        w.resolve(p)
      } else {
        queue.push(p)
      }
    }
  })
  return {
    next(pred) {
      const idx = queue.findIndex(pred)
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0])
      return new Promise((resolve) => waiters.push({ pred, resolve }))
    }
  }
}

async function startProxy(port, profiles) {
  const child = spawn(process.execPath, [PROXY_SCRIPT])
  const lines = makeLineReader(child)
  child.stdin.write(JSON.stringify({ type: 'init', config: config(port, profiles) }) + '\n')
  await lines.next((l) => l.includes('"started"'))
  return { child, base: `http://127.0.0.1:${port}` }
}

async function stopProxy(child) {
  try { child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n') } catch {}
  await new Promise((r) => setTimeout(r, 150))
  try { child.kill() } catch {}
}

function postMessages(base, body) {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'test', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  })
}

function anthropicBody(extra = {}) {
  return {
    model: 'm1',
    max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'fs_read', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    ...extra
  }
}

test('Anthropic tool_choice 对象被转换成上游认识的字符串形式', async () => {
  const seen = []
  const up = await startUpstream((req, res, body) => { seen.push(JSON.parse(body)); okChatResponse(res) })
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Upstream', `http://127.0.0.1:${up.address().port}`, ['m1'])
  ])

  try {
    const res = await postMessages(base, anthropicBody({ tool_choice: { type: 'auto' }, stream: false }))
    assert.equal(res.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].tool_choice, 'auto', '上游应收到字符串 auto，而不是 {type:"auto"}')
  } finally {
    await stopProxy(child)
    up.close()
  }
})

test('Anthropic 客户端：上游 400 非标准错误信封不会被转换成空响应', async () => {
  const up = await startUpstream((req, res) =>
    nonStandardErrorResponse(res, 400, '当前只支持 function tool_choice，OpenRouter server tool_choice 暂不支持'))
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Upstream', `http://127.0.0.1:${up.address().port}`, ['m1'])
  ])

  try {
    const res = await postMessages(base, anthropicBody({ tool_choice: { type: 'auto' }, stream: false }))
    assert.equal(res.status, 400, '上游状态码必须保留')
    const data = await res.json()
    assert.equal(data.type, 'error', `应为 Anthropic 错误结构，实际: ${JSON.stringify(data)}`)
    assert.equal(data.error.type, 'invalid_request_error')
    assert.match(data.error.message, /function tool_choice/, '上游错误原文必须透出')
  } finally {
    await stopProxy(child)
    up.close()
  }
})

test('Anthropic 客户端：流式请求下上游 400 以 error 事件透出', async () => {
  const up = await startUpstream((req, res) =>
    nonStandardErrorResponse(res, 400, '当前只支持 function tool_choice，OpenRouter server tool_choice 暂不支持'))
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Upstream', `http://127.0.0.1:${up.address().port}`, ['m1'])
  ])

  try {
    const res = await postMessages(base, anthropicBody({ tool_choice: { type: 'auto' }, stream: true }))
    const text = await res.text()
    assert.equal(res.status, 400)
    assert.match(text, /event: error/, `应发出 Anthropic error 事件，实际: ${text.slice(0, 300)}`)
    assert.match(text, /function tool_choice/, '错误原文必须透出')
  } finally {
    await stopProxy(child)
    up.close()
  }
})

test('Chat 客户端：上游 400 标准错误信封原样保留', async () => {
  const up = await startUpstream((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad request from upstream', type: 'invalid_request_error' } }))
  })
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Upstream', `http://127.0.0.1:${up.address().port}`, ['m1'])
  ])

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.match(JSON.stringify(data), /bad request from upstream/)
  } finally {
    await stopProxy(child)
    up.close()
  }
})

test('Anthropic 客户端：上游正常响应仍然照常转换', async () => {
  const up = await startUpstream((req, res) => okChatResponse(res))
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Upstream', `http://127.0.0.1:${up.address().port}`, ['m1'])
  ])

  try {
    const res = await postMessages(base, anthropicBody({ stream: false }))
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.type, 'message')
    assert.equal(data.content[0].text, 'ok')
  } finally {
    await stopProxy(child)
    up.close()
  }
})
