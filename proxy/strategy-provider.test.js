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

// 逐行读取子进程 stdout，支持等待满足条件的消息行
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

// 本地 mock 上游，记录收到的请求体
function startUpstream(hits) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        hits.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'm1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }))
      })
    })
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
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

function postChat(base, model) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
  })
}

test('指定提供商策略：请求固定路由到指定 provider', async () => {
  const hitsA = []
  const hitsB = []
  const upA = await startUpstream(hitsA)
  const upB = await startUpstream(hitsB)
  const port = await freePort()
  const child = spawn(process.execPath, [PROXY_SCRIPT])
  const lines = makeLineReader(child)
  const base = `http://127.0.0.1:${port}`
  const pA = profile('a', 'Provider A', `http://127.0.0.1:${upA.address().port}`, ['m1'])
  const pB = profile('b', 'Provider B', `http://127.0.0.1:${upB.address().port}`, ['m1'])

  try {
    child.stdin.write(JSON.stringify({ type: 'init', config: config(port, [pA, pB], { m1: 'provider:b' }) }) + '\n')
    await lines.next((l) => l.includes('"started"'))

    const res = await postChat(base, 'm1')
    assert.equal(res.status, 200)
    assert.equal(hitsA.length, 0, '不应命中 Provider A')
    assert.equal(hitsB.length, 1, '应命中 Provider B')
  } finally {
    child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    child.kill()
    upA.close()
    upB.close()
  }
})

test('指定提供商不存在时回退到第一个匹配 provider', async () => {
  const hitsA = []
  const hitsB = []
  const upA = await startUpstream(hitsA)
  const upB = await startUpstream(hitsB)
  const port = await freePort()
  const child = spawn(process.execPath, [PROXY_SCRIPT])
  const lines = makeLineReader(child)
  const base = `http://127.0.0.1:${port}`
  const pA = profile('a', 'Provider A', `http://127.0.0.1:${upA.address().port}`, ['m1'])
  const pB = profile('b', 'Provider B', `http://127.0.0.1:${upB.address().port}`, ['m1'])

  try {
    child.stdin.write(JSON.stringify({ type: 'init', config: config(port, [pA, pB], { m1: 'provider:missing' }) }) + '\n')
    await lines.next((l) => l.includes('"started"'))

    const res = await postChat(base, 'm1')
    assert.equal(res.status, 200)
    assert.equal(hitsA.length, 1, '应回退到 Provider A')
    assert.equal(hitsB.length, 0, '不应命中 Provider B')
  } finally {
    child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    child.kill()
    upA.close()
    upB.close()
  }
})

test('指定提供商已停用时回退到第一个匹配 provider', async () => {
  const hitsA = []
  const hitsB = []
  const upA = await startUpstream(hitsA)
  const upB = await startUpstream(hitsB)
  const port = await freePort()
  const child = spawn(process.execPath, [PROXY_SCRIPT])
  const lines = makeLineReader(child)
  const base = `http://127.0.0.1:${port}`
  const pA = profile('a', 'Provider A', `http://127.0.0.1:${upA.address().port}`, ['m1'])
  const pB = profile('b', 'Provider B', `http://127.0.0.1:${upB.address().port}`, ['m1'])

  try {
    // Provider B 不在已启用 profiles 中（等同停用），但策略仍指定它
    child.stdin.write(JSON.stringify({ type: 'init', config: config(port, [pA], { m1: 'provider:b' }) }) + '\n')
    await lines.next((l) => l.includes('"started"'))

    const res = await postChat(base, 'm1')
    assert.equal(res.status, 200)
    assert.equal(hitsA.length, 1, '应回退到 Provider A')
    assert.equal(hitsB.length, 0, '停用的 Provider B 不应被命中')
  } finally {
    child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    child.kill()
    upA.close()
    upB.close()
  }
})
