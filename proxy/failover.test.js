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

// 获取一个当前无人监听的端口（先占用再释放），用于模拟连接拒绝（ECONNREFUSED）
async function closedPort() {
  const port = await freePort()
  // freePort 已保证释放，直接返回即可
  return port
}

// 本地 mock 上游：由 handler 决定响应内容
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

function okResponse(res, content = 'ok') {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'm1',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }))
}

function errorResponse(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message, type: 'upstream_error' } }))
}

function profile(id, name, baseUrl, models) {
  return {
    id, name, providerType: 'openai-chat', baseUrl,
    apiKey: 'k', defaultModel: '', models
  }
}

function config(port, profiles, modelStrategies) {
  return {
    profiles,
    models: [],
    modelStrategies,
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

function postChat(base, model) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
  })
}

// 启动代理子进程并等待 ready；返回 { child, base }
async function startProxy(port, profiles, modelStrategies) {
  const child = spawn(process.execPath, [PROXY_SCRIPT])
  const lines = makeLineReader(child)
  child.stdin.write(JSON.stringify({ type: 'init', config: config(port, profiles, modelStrategies) }) + '\n')
  await lines.next((l) => l.includes('"started"'))
  return { child, lines, base: `http://127.0.0.1:${port}` }
}

async function stopProxy(child) {
  try { child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n') } catch {}
  await new Promise((r) => setTimeout(r, 150))
  try { child.kill() } catch {}
}

test('failover：第一个上游返回 500 时自动切换到下一个提供商', async () => {
  const hitsA = []
  const hitsB = []
  const upA = await startUpstream((req, res) => { hitsA.push(1); errorResponse(res, 500, 'A exploded') })
  const upB = await startUpstream((req, res, body) => { hitsB.push(body); okResponse(res) })
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Provider A', `http://127.0.0.1:${upA.address().port}`, ['m1']),
    profile('b', 'Provider B', `http://127.0.0.1:${upB.address().port}`, ['m1'])
  ], { m1: 'failover' })

  try {
    const res = await postChat(base, 'm1')
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.choices[0].message.content, 'ok')
    assert.equal(hitsA.length, 1, '应命中 Provider A')
    assert.equal(hitsB.length, 1, '应自动切到 Provider B')
  } finally {
    await stopProxy(child)
    upA.close()
    upB.close()
  }
})

test('failover：第一个上游正常时不重试其他提供商', async () => {
  const hitsA = []
  const hitsB = []
  const upA = await startUpstream((req, res) => { hitsA.push(1); okResponse(res) })
  const upB = await startUpstream((req, res) => { hitsB.push(1); okResponse(res) })
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Provider A', `http://127.0.0.1:${upA.address().port}`, ['m1']),
    profile('b', 'Provider B', `http://127.0.0.1:${upB.address().port}`, ['m1'])
  ], { m1: 'failover' })

  try {
    const res = await postChat(base, 'm1')
    assert.equal(res.status, 200)
    assert.equal(hitsA.length, 1)
    assert.equal(hitsB.length, 0, '不应命中 Provider B')
  } finally {
    await stopProxy(child)
    upA.close()
    upB.close()
  }
})

test('failover：连接被拒绝时切换到下一个提供商', async () => {
  const hitsB = []
  const dead = await closedPort()
  const upB = await startUpstream((req, res) => { hitsB.push(1); okResponse(res) })
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Dead Provider', `http://127.0.0.1:${dead}`, ['m1']),
    profile('b', 'Provider B', `http://127.0.0.1:${upB.address().port}`, ['m1'])
  ], { m1: 'failover' })

  try {
    const res = await postChat(base, 'm1')
    assert.equal(res.status, 200)
    assert.equal(hitsB.length, 1, '应跳过死掉的提供商命中 Provider B')
  } finally {
    await stopProxy(child)
    upB.close()
  }
})

test('failover：所有提供商都失败时把最后一个错误状态透传给客户端', async () => {
  const hitsA = []
  const hitsB = []
  const upA = await startUpstream((req, res) => { hitsA.push(1); errorResponse(res, 500, 'A exploded') })
  const upB = await startUpstream((req, res) => { hitsB.push(1); errorResponse(res, 429, 'rate limited') })
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Provider A', `http://127.0.0.1:${upA.address().port}`, ['m1']),
    profile('b', 'Provider B', `http://127.0.0.1:${upB.address().port}`, ['m1'])
  ], { m1: 'failover' })

  try {
    const res = await postChat(base, 'm1')
    assert.equal(res.status, 429, '最后一个提供商的错误状态应透传')
    assert.equal(hitsA.length, 1)
    assert.equal(hitsB.length, 1)
  } finally {
    await stopProxy(child)
    upA.close()
    upB.close()
  }
})

test('非 failover 策略：单一提供商错误直接透传，不挂起也不重试', async () => {
  const hitsA = []
  const upA = await startUpstream((req, res) => { hitsA.push(1); errorResponse(res, 500, 'A exploded') })
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Provider A', `http://127.0.0.1:${upA.address().port}`, ['m1'])
  ], {})

  try {
    const res = await postChat(base, 'm1')
    assert.equal(res.status, 500)
    const data = await res.json()
    assert.equal(data.error.message, 'A exploded')
    assert.equal(hitsA.length, 1)
  } finally {
    await stopProxy(child)
    upA.close()
  }
})

test('failover：流式请求在上游出错时同样能切换到下一个提供商', async () => {
  const hitsA = []
  const hitsB = []
  const upA = await startUpstream((req, res) => { hitsA.push(1); errorResponse(res, 502, 'A bad gateway') })
  const upB = await startUpstream((req, res, body) => {
    hitsB.push(body)
    // 返回非流式 JSON，代理负责转换成 SSE（客户端请求了 stream）
    okResponse(res)
  })
  const port = await freePort()
  const { child, base } = await startProxy(port, [
    profile('a', 'Provider A', `http://127.0.0.1:${upA.address().port}`, ['m1']),
    profile('b', 'Provider B', `http://127.0.0.1:${upB.address().port}`, ['m1'])
  ], { m1: 'failover' })

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm1', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.ok(text.includes('"ok"'), `SSE 应包含模型输出，实际: ${text.slice(0, 400)}`)
    assert.ok(text.includes('[DONE]'), 'SSE 应以 [DONE] 结束')
    assert.equal(hitsA.length, 1)
    assert.equal(hitsB.length, 1)
  } finally {
    await stopProxy(child)
    upA.close()
    upB.close()
  }
})
