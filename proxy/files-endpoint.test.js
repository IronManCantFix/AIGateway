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

// 假上游：记录收到的请求，按 Files API 语义返回固定响应
function startUpstream() {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const entry = { method: req.method, url: req.url, contentType: req.headers['content-type'] || '', body }
      seen.push(entry)
      let status = 200
      let payload
      if (req.method === 'POST' && req.url === '/files') {
        payload = { id: 'file-api-1234567890abcdef', object: 'file', bytes: body.length, created_at: 1700000000, filename: 'image.png', purpose: 'user_data' }
      } else if (req.method === 'GET' && req.url.startsWith('/files?') || (req.method === 'GET' && req.url === '/files')) {
        payload = { object: 'list', data: [{ id: 'file-api-1234567890abcdef', object: 'file', bytes: 1024, created_at: 1700000000, filename: 'image.png', purpose: 'user_data' }] }
      } else if (req.method === 'GET' && req.url.startsWith('/files/')) {
        payload = { id: 'file-api-1234567890abcdef', object: 'file', bytes: 1024, created_at: 1700000000, filename: 'image.png', purpose: 'user_data' }
      } else if (req.method === 'DELETE' && req.url.startsWith('/files/')) {
        payload = { id: 'file-api-1234567890abcdef', object: 'file', deleted: true }
      } else {
        status = 404
        payload = { error: 'not found' }
      }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
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

test('Files API 透传：上传/列表/查询/删除，multipart 原样转发到上游', async () => {
  const upstream = await startUpstream()
  const port = await freePort()
  const child = spawn(process.execPath, [PROXY_SCRIPT])
  const lines = makeLineReader(child)
  const errors = []
  child.stderr.on('data', (d) => errors.push(d.toString()))
  const base = `http://127.0.0.1:${port}`

  const profile = {
    id: 'ds', name: 'DeepSeek', providerType: 'openai-chat',
    baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: 'k', defaultModel: '', models: []
  }

  try {
    child.stdin.write(JSON.stringify({ type: 'init', config: config(port, [profile]) }) + '\n')
    await lines.next((l) => l.includes('"started"'))

    // 1. multipart 上传 → 网关去掉 /v1 前缀，转发到上游 /files
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
    const fd = new FormData()
    fd.append('purpose', 'user_data')
    fd.append('file', new Blob([pngBytes], { type: 'image/png' }), 'image.png')
    const upRes = await fetch(`${base}/v1/files`, { method: 'POST', body: fd, headers: { Authorization: 'Bearer k' } })
    assert.equal(upRes.status, 200)
    const upJson = await upRes.json()
    assert.equal(upJson.id, 'file-api-1234567890abcdef')
    assert.equal(upJson.filename, 'image.png')

    const upload = upstream.seen.find((e) => e.method === 'POST')
    assert.ok(upload, 'upstream should receive the upload')
    assert.equal(upload.url, '/files', 'upstream path should drop the /v1 prefix')
    assert.ok(upload.contentType.startsWith('multipart/form-data'), 'multipart content-type forwarded')
    assert.ok(upload.body.includes(pngBytes), 'file binary forwarded verbatim')
    assert.ok(upload.body.toString('latin1').includes('user_data'), 'multipart fields forwarded')

    // 2. 列表（带查询参数透传）
    const listRes = await fetch(`${base}/v1/files?limit=10&purpose=user_data`, { headers: { Authorization: 'Bearer k' } })
    assert.equal(listRes.status, 200)
    const listJson = await listRes.json()
    assert.equal(listJson.data[0].id, 'file-api-1234567890abcdef')
    const listReq = upstream.seen.find((e) => e.method === 'GET' && e.url.startsWith('/files?'))
    assert.equal(listReq.url, '/files?limit=10&purpose=user_data', 'query string passed through')

    // 3. 查询单个文件
    const getRes = await fetch(`${base}/v1/files/file-api-1234567890abcdef`, { headers: { Authorization: 'Bearer k' } })
    assert.equal(getRes.status, 200)
    assert.equal((await getRes.json()).id, 'file-api-1234567890abcdef')
    assert.ok(upstream.seen.some((e) => e.method === 'GET' && e.url === '/files/file-api-1234567890abcdef'))

    // 4. 删除
    const delRes = await fetch(`${base}/v1/files/file-api-1234567890abcdef`, { method: 'DELETE', headers: { Authorization: 'Bearer k' } })
    assert.equal(delRes.status, 200)
    assert.equal((await delRes.json()).deleted, true)
    assert.ok(upstream.seen.some((e) => e.method === 'DELETE' && e.url === '/files/file-api-1234567890abcdef'))
  } finally {
    child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    child.kill()
    upstream.server.close()
  }
  assert.deepEqual(errors, [], 'sidecar stderr should be empty')
})

test('Files API 路由校验：无 OpenAI 兼容 profile 时 503，上传到 item 路径 400', async () => {
  const port = await freePort()
  const child = spawn(process.execPath, [PROXY_SCRIPT])
  const lines = makeLineReader(child)
  const errors = []
  child.stderr.on('data', (d) => errors.push(d.toString()))
  const base = `http://127.0.0.1:${port}`

  try {
    // 只有一个 anthropic-message profile：Files API 不应路由到它
    const anthropic = {
      id: 'cl', name: 'Claude', providerType: 'anthropic-message',
      baseUrl: 'http://127.0.0.1:1', apiKey: 'k', defaultModel: '', models: []
    }
    child.stdin.write(JSON.stringify({ type: 'init', config: config(port, [anthropic]) }) + '\n')
    await lines.next((l) => l.includes('"started"'))

    const res = await fetch(`${base}/v1/files`, { headers: { Authorization: 'Bearer k' } })
    assert.equal(res.status, 503)

    const bad = await fetch(`${base}/v1/files/some-id`, { method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{}' })
    assert.equal(bad.status, 400)

    const notAllowed = await fetch(`${base}/v1/files`, { method: 'PUT', headers: { Authorization: 'Bearer k' } })
    assert.equal(notAllowed.status, 405)
  } finally {
    child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    child.kill()
  }
  assert.deepEqual(errors, [], 'sidecar stderr should be empty')
})
