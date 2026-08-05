import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

function profile(id, name, models) {
  return {
    id, name, providerType: 'openai-chat', baseUrl: 'http://127.0.0.1:1',
    apiKey: 'k', defaultModel: '', models
  }
}

function config(port, profiles, extra = {}) {
  return {
    profiles,
    models: ['global-legacy-model'], // 全局 models.json 条目不应出现在 /v1/models
    modelStrategies: {},
    modelMappings: { enabled: false, rules: [] },
    settings: { port, logEnabled: false, httpProxy: null },
    ...extra
  }
}

test('GET /v1/models 只返回已启用 profile 的模型，且配置变动后返回最新列表', async () => {
  const port = await freePort()
  const child = spawn(process.execPath, [PROXY_SCRIPT])
  const lines = makeLineReader(child)
  const errors = []
  child.stderr.on('data', (d) => errors.push(d.toString()))
  const base = `http://127.0.0.1:${port}`

  const pA = profile('a', 'Provider A', ['a1', 'a2'])
  const pB = profile('b', 'Provider B', ['b1'])
  const pC = profile('c', 'Provider C', ['c1'])
  const initial = config(port, [pA, pB])

  try {
    child.stdin.write(JSON.stringify({ type: 'init', config: initial }) + '\n')
    await lines.next((l) => l.includes('"started"'))

    // 首次请求：代理向父进程请求最新配置，父进程原样回复
    const req1 = fetch(`${base}/v1/models`)
    const line1 = await lines.next((l) => l.includes('"config_request"'))
    const msg1 = JSON.parse(line1)
    child.stdin.write(JSON.stringify({ type: 'config_update', id: msg1.id, config: initial }) + '\n')
    const body1 = await (await req1).json()
    assert.deepEqual(
      body1.data.map((m) => m.id).sort(),
      ['a1', 'a2', 'b1'],
      '只应返回已启用 profile 的模型，不含 models.json 全局条目'
    )

    // 配置变动：新增 Provider C（模拟 add_profile 后父进程下发最新配置）
    const updated = config(port, [pA, pC])
    const req2 = fetch(`${base}/v1/models`)
    const line2 = await lines.next((l) => l.includes('"config_request"'))
    const msg2 = JSON.parse(line2)
    child.stdin.write(JSON.stringify({ type: 'config_update', id: msg2.id, config: updated }) + '\n')
    const body2 = await (await req2).json()
    assert.deepEqual(
      body2.data.map((m) => m.id).sort(),
      ['a1', 'a2', 'c1'],
      '配置变动后，下一次请求应返回最新可用模型列表'
    )

    // 再次请求且不回复 config_request（模拟超时兜底）：
    // 代理应继续使用上一次已更新的 currentConfig
    const req3 = fetch(`${base}/v1/models`)
    await lines.next((l) => l.includes('"config_request"'))
    const body3 = await (await req3).json()
    assert.deepEqual(
      body3.data.map((m) => m.id).sort(),
      ['a1', 'a2', 'c1'],
      '父进程未回复时应回退到当前配置'
    )
  } finally {
    child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    child.kill()
  }
  assert.deepEqual(errors, [], 'sidecar stderr should be empty')
})

test('本地快照无 profile 时 /v1/models 仍拉取最新配置而不是 503', async () => {
  const port = await freePort()
  const child = spawn(process.execPath, [PROXY_SCRIPT])
  const lines = makeLineReader(child)
  const base = `http://127.0.0.1:${port}`

  try {
    // 代理本地快照为空（例如刚启动、尚未收到任何配置）
    child.stdin.write(JSON.stringify({
      type: 'init',
      config: { profiles: [], models: [], modelStrategies: {}, modelMappings: { enabled: false, rules: [] }, settings: { port } }
    }) + '\n')
    await lines.next((l) => l.includes('"started"'))

    const req = fetch(`${base}/v1/models`)
    const line = await lines.next((l) => l.includes('"config_request"'))
    const msg = JSON.parse(line)
    // 父进程下发最新配置：启用了一个 profile
    const fresh = config(port, [profile('d', 'Provider D', ['d1'])])
    child.stdin.write(JSON.stringify({ type: 'config_update', id: msg.id, config: fresh }) + '\n')
    const res = await req
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(body.data.map((m) => m.id), ['d1'])
  } finally {
    child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
    await new Promise((r) => setTimeout(r, 150))
    child.kill()
  }
})
