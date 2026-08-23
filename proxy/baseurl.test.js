import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import net from 'node:net'

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

// 假上游：记录收到的请求路径，按不同路径返回对应的固定响应
function startUpstream() {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url.split('?')[0] })
      if (req.method === 'GET' && req.url.startsWith('/files')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [] }))
        return
      }
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
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

function profile(providerType, baseUrl) {
  return {
    id: 'p1', name: 'P1', providerType, baseUrl,
    apiKey: 'k', defaultModel: '', models: ['m1']
  }
}

function postChat(base, model) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
  })
}

// 启动一个带指定 baseUrl 的代理实例，执行测试函数后统一清理
async function withProxy(port, profiles, fn) {
  const child = spawn(process.execPath, [PROXY_SCRIPT])
  const lines = makeLineReader(child)
  const errors = []
  child.stderr.on('data', (d) => errors.push(d.toString()))
  try {
    child.stdin.write(JSON.stringify({ type: 'init', config: config(port, profiles) }) + '\n')
    await lines.next((l) => l.includes('"started"'))
    await fn(`http://127.0.0.1:${port}`)
    assert.deepEqual(errors, [], `proxy stderr should be empty, got: ${errors.join('')}`)
  } finally {
    child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    child.kill()
  }
}

test('Base URL 含版本段（如火山引擎 /api/v3）时，上游路径不再重复拼接 /v1', async () => {
  const upstream = await startUpstream()
  const port = await freePort()
  try {
    await withProxy(port, [profile('openai-chat', `http://127.0.0.1:${upstream.port}/api/v3`)], async (base) => {
      const res = await postChat(base, 'm1')
      assert.equal(res.status, 200)
      assert.equal(upstream.seen.length, 1)
      assert.equal(upstream.seen[0].url, '/api/v3/chat/completions')
    })
  } finally {
    upstream.server.close()
  }
})

test('Base URL 以 /v1 结尾时去重，请求仍打到 /v1/chat/completions', async () => {
  const upstream = await startUpstream()
  const port = await freePort()
  try {
    await withProxy(port, [profile('openai-chat', `http://127.0.0.1:${upstream.port}/v1`)], async (base) => {
      const res = await postChat(base, 'm1')
      assert.equal(res.status, 200)
      assert.equal(upstream.seen.length, 1)
      assert.equal(upstream.seen[0].url, '/v1/chat/completions')
    })
  } finally {
    upstream.server.close()
  }
})

test('Base URL 为裸根地址时正常拼接 /v1/chat/completions', async () => {
  const upstream = await startUpstream()
  const port = await freePort()
  try {
    await withProxy(port, [profile('openai-chat', `http://127.0.0.1:${upstream.port}`)], async (base) => {
      const res = await postChat(base, 'm1')
      assert.equal(res.status, 200)
      assert.equal(upstream.seen.length, 1)
      assert.equal(upstream.seen[0].url, '/v1/chat/completions')
    })
  } finally {
    upstream.server.close()
  }
})

test('google-gemini：Base URL 含 /v1beta 时去重，请求打到 /v1beta/openai/chat/completions', async () => {
  const upstream = await startUpstream()
  const port = await freePort()
  try {
    await withProxy(port, [profile('google-gemini', `http://127.0.0.1:${upstream.port}/v1beta`)], async (base) => {
      const res = await postChat(base, 'm1')
      assert.equal(res.status, 200)
      assert.equal(upstream.seen.length, 1)
      assert.equal(upstream.seen[0].url, '/v1beta/openai/chat/completions')
    })
  } finally {
    upstream.server.close()
  }
})

test('Files API：Base URL 含版本段时保留其前缀（/api/v3/files）', async () => {
  const upstream = await startUpstream()
  const port = await freePort()
  try {
    await withProxy(port, [profile('openai-chat', `http://127.0.0.1:${upstream.port}/api/v3`)], async (base) => {
      const res = await fetch(`${base}/v1/files`, { headers: { Authorization: 'Bearer k' } })
      assert.equal(res.status, 200)
      assert.equal(upstream.seen.length, 1)
      assert.equal(upstream.seen[0].url, '/api/v3/files')
    })
  } finally {
    upstream.server.close()
  }
})
