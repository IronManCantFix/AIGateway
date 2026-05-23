# OpenAI 图像生成支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 sidecar 中新增 `/v1/images/generations` 和 `/v1/images/edits` 两个端点，配合新的 `openai-image` providerType，将图像请求按 model 路由到对应 OpenAI 兼容上游。

**Architecture:** Sidecar 入口按 `Content-Type` 分流：JSON 走现有 readBody 路径；multipart 用 `readBodyAsBuffer` 整体缓冲后由零依赖 `multipart-scanner.js` 提取文本字段（不解析文件字节）。路由复用现有"按 model 匹配 profile"逻辑，加 `providerType==='openai-image'` 过滤。日志中剥离文件字节和响应 `b64_json`。

**Tech Stack:** Node.js 原生 `http`/`https`、`node:test`、Vue 3、Vite、Tauri（Rust 层零改动）。

**Spec：** [docs/superpowers/specs/2026-05-22-openai-image-design.md](../specs/2026-05-22-openai-image-design.md)

---

## 文件清单

| 文件 | 操作 | 责任 |
|---|---|---|
| `proxy/multipart-scanner.js` | 新增 | 零依赖 multipart 字段扫描器 |
| `proxy/multipart-scanner.test.js` | 新增 | scanner 单元测试（node:test） |
| `proxy/proxy-server.js` | 修改 | 路由表 + 入口分流 + image 处理 + sanitize 日志 |
| `src/pages/ProfileEdit/index.vue` | 修改 | 表单 select 加一行 |
| `src/pages/Home/index.vue` | 修改 | providerLabel/providerColor 加分支 |
| `src/i18n/locales/zh-CN.json` | 修改 | 加 providerType.openai-image |
| `src/i18n/locales/en-US.json` | 修改 | 加 providerType.openai-image |

---

## Task 1: multipart-scanner 模块（TDD）

**Files:**
- Create: `proxy/multipart-scanner.js`
- Test: `proxy/multipart-scanner.test.js`

### Step 1.1: 写第一个测试 —— 单个文本字段

- [ ] **写测试 `proxy/multipart-scanner.test.js`：**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMultipartFields } from './multipart-scanner.js'

const CRLF = '\r\n'

function buildBody(boundary, parts) {
  // parts: [{ headers: 'Content-Disposition: ...', body: Buffer|string }, ...]
  const chunks = []
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}${p.headers}${CRLF}${CRLF}`))
    chunks.push(typeof p.body === 'string' ? Buffer.from(p.body) : p.body)
    chunks.push(Buffer.from(CRLF))
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`))
  return Buffer.concat(chunks)
}

test('parseMultipartFields: single text field', () => {
  const boundary = 'X'
  const buf = buildBody(boundary, [
    { headers: 'Content-Disposition: form-data; name="model"', body: 'gpt-image-1' }
  ])
  const result = parseMultipartFields(buf, boundary)
  assert.deepEqual(result.fields, { model: 'gpt-image-1' })
  assert.deepEqual(result.files, [])
})
```

### Step 1.2: 跑测试确认失败

- [ ] **运行：**

```bash
cd proxy && node --test multipart-scanner.test.js
```

预期：`ERR_MODULE_NOT_FOUND` 或类似（文件不存在）。

### Step 1.3: 写最小实现让测试通过

- [ ] **创建 `proxy/multipart-scanner.js`：**

```js
// proxy/multipart-scanner.js
// Zero-dependency multipart/form-data field scanner.
// Extracts non-file fields as text. File parts are NOT decoded — only metadata recorded.

const CRLF = Buffer.from('\r\n')
const DOUBLE_CRLF = Buffer.from('\r\n\r\n')

function parseHeaders(headerBlock) {
  const headers = {}
  const lines = headerBlock.toString('latin1').split('\r\n')
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const name = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    headers[name] = value
  }
  return headers
}

function parseContentDisposition(value) {
  if (!value) return {}
  const params = {}
  const parts = value.split(';').map(p => p.trim())
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim().toLowerCase()
    let v = part.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    params[k] = v
  }
  return params
}

export function parseMultipartFields(buf, boundary) {
  if (!Buffer.isBuffer(buf)) throw new Error('Bad multipart: body must be Buffer')
  if (!boundary) throw new Error('Bad multipart: missing boundary')

  const delim = Buffer.from(`--${boundary}`)
  const fields = {}
  const files = []

  let pos = buf.indexOf(delim)
  if (pos < 0) throw new Error('Bad multipart: no boundary found in body')

  while (pos < buf.length) {
    const partStart = pos + delim.length
    // Check terminator "--"
    if (buf[partStart] === 0x2d && buf[partStart + 1] === 0x2d) break
    // Skip CRLF after boundary
    let cursor = partStart
    if (buf[cursor] === 0x0d && buf[cursor + 1] === 0x0a) cursor += 2

    // Find end of headers
    const headersEnd = buf.indexOf(DOUBLE_CRLF, cursor)
    if (headersEnd < 0) throw new Error('Bad multipart: malformed body (no header terminator)')
    const headerBlock = buf.slice(cursor, headersEnd)
    const contentStart = headersEnd + DOUBLE_CRLF.length

    // Find next boundary
    const nextBoundary = buf.indexOf(delim, contentStart)
    if (nextBoundary < 0) throw new Error('Bad multipart: malformed body (no terminator)')
    // Content ends 2 bytes before next boundary (strip trailing CRLF)
    let contentEnd = nextBoundary
    if (buf[contentEnd - 2] === 0x0d && buf[contentEnd - 1] === 0x0a) contentEnd -= 2

    const headers = parseHeaders(headerBlock)
    const disp = parseContentDisposition(headers['content-disposition'])
    const name = disp.name
    if (name) {
      if (disp.filename !== undefined) {
        files.push({
          name,
          filename: disp.filename,
          contentType: headers['content-type'] || 'application/octet-stream',
          size: contentEnd - contentStart
        })
      } else {
        fields[name] = buf.slice(contentStart, contentEnd).toString('utf8')
      }
    }

    pos = nextBoundary
  }

  return { fields, files }
}
```

### Step 1.4: 跑测试确认通过

- [ ] **运行：**

```bash
cd proxy && node --test multipart-scanner.test.js
```

预期：1 pass, 0 fail。

### Step 1.5: 加文件 part 测试

- [ ] **在测试文件末尾追加：**

```js
test('parseMultipartFields: file part records metadata only', () => {
  const boundary = 'X'
  const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8])  // arbitrary binary
  const buf = buildBody(boundary, [
    { headers: 'Content-Disposition: form-data; name="model"', body: 'gpt-image-1' },
    {
      headers: 'Content-Disposition: form-data; name="image"; filename="cat.png"\r\nContent-Type: image/png',
      body: fileBytes
    },
    { headers: 'Content-Disposition: form-data; name="prompt"', body: 'add a hat' }
  ])
  const result = parseMultipartFields(buf, boundary)
  assert.deepEqual(result.fields, { model: 'gpt-image-1', prompt: 'add a hat' })
  assert.equal(result.files.length, 1)
  assert.deepEqual(result.files[0], {
    name: 'image',
    filename: 'cat.png',
    contentType: 'image/png',
    size: fileBytes.length
  })
})
```

- [ ] **运行：**

```bash
cd proxy && node --test multipart-scanner.test.js
```

预期：2 pass, 0 fail。

### Step 1.6: 加多文件 + quoted boundary 测试

- [ ] **追加：**

```js
test('parseMultipartFields: multiple files with same name', () => {
  const boundary = 'X'
  const buf = buildBody(boundary, [
    { headers: 'Content-Disposition: form-data; name="model"', body: 'gpt-image-1' },
    { headers: 'Content-Disposition: form-data; name="image[]"; filename="a.png"\r\nContent-Type: image/png', body: Buffer.from('AAA') },
    { headers: 'Content-Disposition: form-data; name="image[]"; filename="b.png"\r\nContent-Type: image/png', body: Buffer.from('BBBB') }
  ])
  const result = parseMultipartFields(buf, boundary)
  assert.equal(result.files.length, 2)
  assert.equal(result.files[0].filename, 'a.png')
  assert.equal(result.files[0].size, 3)
  assert.equal(result.files[1].filename, 'b.png')
  assert.equal(result.files[1].size, 4)
})

test('parseMultipartFields: rejects missing boundary in body', () => {
  assert.throws(() => parseMultipartFields(Buffer.from('garbage'), 'X'),
    /no boundary found/)
})

test('parseMultipartFields: rejects empty boundary param', () => {
  assert.throws(() => parseMultipartFields(Buffer.from('--X--'), ''),
    /missing boundary/)
})
```

- [ ] **运行：**

```bash
cd proxy && node --test multipart-scanner.test.js
```

预期：5 pass, 0 fail。

### Step 1.7: 提交

- [ ] **提交：**

```bash
git add proxy/multipart-scanner.js proxy/multipart-scanner.test.js
git commit -m "feat(image): add multipart-scanner for image edits endpoint"
```

---

## Task 2: PATH_TO_SOURCE + PROVIDER_META 扩展

**Files:**
- Modify: `proxy/proxy-server.js:48-64`

### Step 2.1: 修改 PATH_TO_SOURCE 加入图像端点

- [ ] **在 `proxy/proxy-server.js:48-55` 的 `PATH_TO_SOURCE` 末尾增加：**

```js
const PATH_TO_SOURCE = {
  '/v1/chat/completions': 'chat_completions',
  '/v1/responses': 'responses',
  '/v1/messages': 'messages',
  '/chat/completions': 'chat_completions',
  '/responses': 'responses',
  '/messages': 'messages',
  '/v1/images/generations': 'image',
  '/v1/images/edits': 'image'
}
```

### Step 2.2: 修改 PROVIDER_META 加入 openai-image

- [ ] **替换 `proxy/proxy-server.js:59-64` 的 PROVIDER_META：**

```js
const PROVIDER_META = {
  'openai-chat':        { target: 'chat_completions', path: '/v1/chat/completions' },
  'openai-response':    { target: 'responses',        path: '/v1/responses' },
  'anthropic-message':  { target: 'messages',         path: '/v1/messages' },
  'newapi':             { target: 'chat_completions', path: '/v1/chat/completions' },
  'openai-image':       { target: 'image',            paths: {
                            '/v1/images/generations': '/v1/images/generations',
                            '/v1/images/edits':       '/v1/images/edits'
                          } }
}
```

### Step 2.3: 加 image 体积上限常量

- [ ] **在 `proxy/proxy-server.js` 第 45 行附近（PATH_TO_SOURCE 上方）加：**

```js
const MAX_IMAGE_BODY = 200 * 1024 * 1024  // 200 MiB
```

### Step 2.4: 验证 sidecar 语法

- [ ] **运行：**

```bash
node --check proxy/proxy-server.js
```

预期：无输出 + exit 0（语法正确）。

### Step 2.5: 提交

- [ ] **提交：**

```bash
git add proxy/proxy-server.js
git commit -m "feat(image): register openai-image provider type and image routes"
```

---

## Task 3: readBodyAsBuffer 工具 + 入口 Content-Type 分流

**Files:**
- Modify: `proxy/proxy-server.js` —— 加 `readBodyAsBuffer`、改造 line 811-822 入口分流

### Step 3.1: 新增 readBodyAsBuffer 函数

- [ ] **在 `proxy/proxy-server.js` 现有 `readBody` 函数（约 line 68-81）后追加：**

```js
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
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)) })
    req.on('error', err => { if (!aborted) reject(err) })
  })
}
```

### Step 3.2: 改造入口分流（line 811-822）

- [ ] **定位 `proxy/proxy-server.js` 的当前 PATH_TO_SOURCE 分支（line 811 起的 `else if (PATH_TO_SOURCE[urlPath]) {` 块），替换为：**

```js
    } else if (PATH_TO_SOURCE[urlPath]) {
      const ct = req.headers['content-type'] || ''
      const isMultipart = ct.startsWith('multipart/form-data')
      if (isMultipart) {
        try {
          req._rawBuffer = await readBodyAsBuffer(req, MAX_IMAGE_BODY)
        } catch (e) {
          if (e.code === 'PAYLOAD_TOO_LARGE') {
            const errBody = JSON.stringify({ error: 'Payload Too Large', maxBytes: MAX_IMAGE_BODY })
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(errBody)
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
      if (logEnabled) {
        req._onResponseBody = (body) => {
          responseBody = (PATH_TO_SOURCE[urlPath] === 'image') ? sanitizeImageResponseBody(body) : body
        }
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
```

注意保持后续 `} else {` 分支（404 处理）和 try/catch 结构原样。

### Step 3.3: 暂时桩 sanitizeImageResponseBody（避免 undefined）

- [ ] **在 `proxy/proxy-server.js` 文件末尾 import 区域下方（约 line 30 上方），加一个临时桩：**

```js
// Will be implemented in Task 6
function sanitizeImageResponseBody(body) { return body }
```

（Task 6 会替换为真实实现。）

### Step 3.4: 验证 sidecar 语法

- [ ] **运行：**

```bash
node --check proxy/proxy-server.js
```

预期：无输出 + exit 0。

### Step 3.5: 提交

- [ ] **提交：**

```bash
git add proxy/proxy-server.js
git commit -m "feat(image): split entry handler by content-type with 200MB cap"
```

---

## Task 4: forwardRequest 支持 Buffer body + 自定义 Content-Type

**为什么先做这个：** 后续 Task 5 中 `handleApiRequest` 调用 `forwardRequest` 时会传第 11 个 `contentType` 参数。先扩 `forwardRequest` 签名，避免 Task 5 的代码在签名扩之前先落地。

**Files:**
- Modify: `proxy/proxy-server.js` 中 `forwardRequest` 函数签名和内部（约 line 159-182）

### Step 4.1: 扩展函数签名加 contentType 参数

- [ ] **替换 `proxy/proxy-server.js:159`：**

```js
function forwardRequest(clientReq, clientRes, upstreamUrl, apiKey, body, sseConverter, onResponseBody, responseBodyConverter, sourceFormat, profileId) {
```

**为：**

```js
function forwardRequest(clientReq, clientRes, upstreamUrl, apiKey, body, sseConverter, onResponseBody, responseBodyConverter, sourceFormat, profileId, contentType) {
```

### Step 4.2: bodyStr 计算支持 Buffer

- [ ] **替换 `proxy/proxy-server.js:169`：**

```js
  const bodyStr = JSON.stringify(body)
```

**为：**

```js
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const effectiveContentType = contentType || 'application/json'
```

### Step 4.3: options.headers 使用 effectiveContentType + Buffer 长度

- [ ] **替换 `proxy/proxy-server.js:177-181`：**

```js
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(bodyStr)
    }
```

**为：**

```js
    headers: {
      'Content-Type': effectiveContentType,
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': bodyBuf.length
    }
```

### Step 4.4: write 改用 bodyBuf

- [ ] **定位文件末段 `upstreamReq.write(bodyStr)`（约 line 574）：**

```js
  upstreamReq.write(bodyStr)
  upstreamReq.end()
```

**改为：**

```js
  upstreamReq.write(bodyBuf)
  upstreamReq.end()
```

### Step 4.5: 全文搜索校验没有遗留 bodyStr 引用

- [ ] **运行：**

```bash
grep -n "bodyStr" proxy/proxy-server.js
```

预期：无输出（所有 `bodyStr` 都已替换）。

### Step 4.6: 验证 sidecar 语法 + 现有测试

- [ ] **运行：**

```bash
node --check proxy/proxy-server.js
cd proxy && node --test protocol-converters.test.js
echo "ok"
```

预期：语法 OK；现有测试全过（chat / responses / messages 路径不传 contentType，effectiveContentType 默认 `application/json`，行为与改造前一致）。

### Step 4.7: 提交

- [ ] **提交：**

```bash
git add proxy/proxy-server.js
git commit -m "refactor(proxy): forwardRequest accepts Buffer body and Content-Type override"
```

---

## Task 5: handleApiRequest 适配 image source

**Files:**
- Modify: `proxy/proxy-server.js` 中 `handleApiRequest`（约 line 593-728）

### Step 5.1: 在 handleApiRequest 顶部识别 image source

- [ ] **找到 `handleApiRequest` 内 `const source = PATH_TO_SOURCE[urlPath]` 一行（约 line 602）。在 source 判定后、`let body = req._body` 之前，插入 multipart 解析分支：**

替换 `proxy/proxy-server.js` 当前 line 610-619：

```js
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
```

为：

```js
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
```

### Step 5.2: 文件顶部导入 parseMultipartFields

- [ ] **在 `proxy/proxy-server.js` 顶部 imports 区域（约 line 22 后）加：**

```js
import { parseMultipartFields } from './multipart-scanner.js'
```

### Step 5.3: 路由按 providerType 过滤（image source）

- [ ] **定位 handleApiRequest 中按 model 路由的循环（当前 line 645-651）：**

```js
  if (requestedModel) {
    for (const p of currentConfig.profiles) {
      if (Array.isArray(p.models) && p.models.length > 0 && p.models.includes(requestedModel)) {
        profile = p
        break
      }
    }
```

**替换为（加 source==='image' 时的 providerType 过滤）：**

```js
  if (requestedModel) {
    for (const p of currentConfig.profiles) {
      if (source === 'image' && p.providerType !== 'openai-image') continue
      if (source !== 'image' && p.providerType === 'openai-image') continue
      if (Array.isArray(p.models) && p.models.length > 0 && p.models.includes(requestedModel)) {
        profile = p
        break
      }
    }
```

- [ ] **同样修改 fallback 分支（当前 line 659-664）：**

```js
  } else {
    // No model specified — use the first profile with models
    for (const p of currentConfig.profiles) {
      if (Array.isArray(p.models) && p.models.length > 0) {
        profile = p
        break
      }
    }
```

**替换为：**

```js
  } else {
    // No model specified — use the first profile with models (matching source family)
    for (const p of currentConfig.profiles) {
      if (source === 'image' && p.providerType !== 'openai-image') continue
      if (source !== 'image' && p.providerType === 'openai-image') continue
      if (Array.isArray(p.models) && p.models.length > 0) {
        profile = p
        break
      }
    }
```

### Step 5.4: image 跳过 cleanBody / flattenBodyMessages

- [ ] **定位 `proxy/proxy-server.js` 当前 line 621-623：**

```js
  // Clean malformed body: strip "[undefined]" strings, flatten input_text content arrays
  body = cleanBody(body)
  body = flattenBodyMessages(body)
```

**改为：**

```js
  if (source !== 'image') {
    // Clean malformed body: strip "[undefined]" strings, flatten input_text content arrays
    body = cleanBody(body)
    body = flattenBodyMessages(body)
  }
```

### Step 5.5: image 跳过 bodyConverter + 单独算 size

- [ ] **定位 line 686-694（`// Apply body converter` 块）：**

```js
  // Apply body converter
  const bodyConverter = getBodyConverter(source, meta.target)
  let bodySizeBefore = JSON.stringify(body).length
  if (bodyConverter) {
    body = bodyConverter(body)
  }
  let bodySizeAfter = JSON.stringify(body).length
  req._bodySizeBefore = bodySizeBefore
  req._bodySizeAfter = bodySizeAfter
```

**改为：**

```js
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
```

### Step 5.6: image 跳过 system 注入

- [ ] **定位 system 注入块（约 line 699-702）：**

```js
  if (body.system && meta.target === 'chat_completions' && profile.providerType !== 'newapi' && Array.isArray(body.messages)) {
    body.messages.unshift({ role: 'system', content: body.system })
    delete body.system
  }
```

**改为：**

```js
  if (source !== 'image' && body.system && meta.target === 'chat_completions' && profile.providerType !== 'newapi' && Array.isArray(body.messages)) {
    body.messages.unshift({ role: 'system', content: body.system })
    delete body.system
  }
```

### Step 5.7: image 用 paths 表 + 跳过 SSE/converter

- [ ] **替换 `proxy/proxy-server.js` 当前 line 704-728（从 `const baseUrl = profile.baseUrl...` 到 `forwardRequest(...)` 结束）：**

```js
  const baseUrl = profile.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const upstreamUrl = `${baseUrl}${meta.path}`
  req._upstreamUrl = upstreamUrl
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
```

**为：**

```js
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
```

### Step 5.8: 验证 sidecar 语法 + 现有协议测试

- [ ] **运行：**

```bash
node --check proxy/proxy-server.js
cd proxy && node --test protocol-converters.test.js multipart-scanner.test.js
echo "ok"
```

预期：语法 OK；所有测试通过。

### Step 5.9: 提交

- [ ] **提交：**

```bash
git add proxy/proxy-server.js
git commit -m "feat(image): route image requests via openai-image profiles"
```

---

## Task 6: sanitizeImageResponseBody 真实现 + 日志收尾

**Files:**
- Modify: `proxy/proxy-server.js` 替换 Task 3 的桩函数

### Step 6.1: 替换桩为真实现

- [ ] **找到 Task 3 在 proxy-server.js 中加的：**

```js
// Will be implemented in Task 6
function sanitizeImageResponseBody(body) { return body }
```

**替换为：**

```js
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
```

### Step 6.2: 加快速冒烟单元测试

- [ ] **创建 `proxy/sanitize.test.js`：**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

// Inline-import the function by evaluating the source — we don't export it
// because it's internal to proxy-server.js. Use a regex extract for the test.
const src = readFileSync(new URL('./proxy-server.js', import.meta.url), 'utf8')
const m = src.match(/function sanitizeImageResponseBody[\s\S]*?\n\}/)
assert.ok(m, 'sanitizeImageResponseBody must be present in proxy-server.js')
const sanitize = new Function(`${m[0]}; return sanitizeImageResponseBody`)()

test('sanitize: strips b64_json', () => {
  const input = JSON.stringify({ created: 1, data: [{ b64_json: 'AAAABBBBCCCC', revised_prompt: 'foo' }] })
  const out = JSON.parse(sanitize(input))
  assert.equal(out.data[0].b64_json, '<base64 stripped, length=12>')
  assert.equal(out.data[0].revised_prompt, 'foo')
})

test('sanitize: keeps url-form responses untouched', () => {
  const input = JSON.stringify({ created: 1, data: [{ url: 'https://x.example/img.png', revised_prompt: 'foo' }] })
  const out = JSON.parse(sanitize(input))
  assert.equal(out.data[0].url, 'https://x.example/img.png')
})

test('sanitize: non-JSON passes through unchanged', () => {
  assert.equal(sanitize('not json at all'), 'not json at all')
})

test('sanitize: empty input passes through', () => {
  assert.equal(sanitize(null), null)
  assert.equal(sanitize(''), '')
})
```

### Step 6.3: 跑测试

- [ ] **运行：**

```bash
cd proxy && node --test sanitize.test.js
```

预期：4 pass, 0 fail。

### Step 6.4: 提交

- [ ] **提交：**

```bash
git add proxy/proxy-server.js proxy/sanitize.test.js
git commit -m "feat(image): strip b64_json from response in logs"
```

---

## Task 7: UI — ProfileEdit select + i18n

**Files:**
- Modify: `src/pages/ProfileEdit/index.vue` line 216-220
- Modify: `src/i18n/locales/zh-CN.json` line 228-233
- Modify: `src/i18n/locales/en-US.json` 同位置

### Step 7.1: ProfileEdit 加 option

- [ ] **替换 `src/pages/ProfileEdit/index.vue:216-220`：**

```html
            <select v-model="form.providerType">
              <option value="openai-chat">{{ $t('profileEdit.providerType.openai-chat') }}</option>
              <option value="openai-response">{{ $t('profileEdit.providerType.openai-response') }}</option>
              <option value="anthropic-message">{{ $t('profileEdit.providerType.anthropic-message') }}</option>
              <option value="newapi">{{ $t('profileEdit.providerType.newapi') }}</option>
```

**为（在 newapi 行后插入一行）：**

```html
            <select v-model="form.providerType">
              <option value="openai-chat">{{ $t('profileEdit.providerType.openai-chat') }}</option>
              <option value="openai-response">{{ $t('profileEdit.providerType.openai-response') }}</option>
              <option value="anthropic-message">{{ $t('profileEdit.providerType.anthropic-message') }}</option>
              <option value="openai-image">{{ $t('profileEdit.providerType.openai-image') }}</option>
              <option value="newapi">{{ $t('profileEdit.providerType.newapi') }}</option>
```

### Step 7.2: i18n zh-CN 加 key

- [ ] **替换 `src/i18n/locales/zh-CN.json:228-233`：**

```json
    "providerType": {
      "openai-chat": "OpenAI Chat Completions",
      "openai-response": "OpenAI Responses",
      "anthropic-message": "Anthropic Messages",
      "newapi": "NEW API"
    }
```

**为：**

```json
    "providerType": {
      "openai-chat": "OpenAI Chat Completions",
      "openai-response": "OpenAI Responses",
      "anthropic-message": "Anthropic Messages",
      "openai-image": "OpenAI 图像",
      "newapi": "NEW API"
    }
```

### Step 7.3: i18n en-US 加 key

- [ ] **在 `src/i18n/locales/en-US.json` 中找到同样的 `"providerType": {` 块，在 `"anthropic-message": "..."` 行后加：**

```json
      "openai-image": "OpenAI Image",
```

具体编辑：

```json
    "providerType": {
      "openai-chat": "OpenAI Chat Completions",
      "openai-response": "OpenAI Responses",
      "anthropic-message": "Anthropic Messages",
      "openai-image": "OpenAI Image",
      "newapi": "NEW API"
    }
```

### Step 7.4: 验证 i18n JSON 合法

- [ ] **运行：**

```bash
node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/zh-CN.json','utf8'));JSON.parse(require('fs').readFileSync('src/i18n/locales/en-US.json','utf8'));console.log('ok')"
```

预期：输出 `ok`。

### Step 7.5: 提交

- [ ] **提交：**

```bash
git add src/pages/ProfileEdit/index.vue src/i18n/locales/zh-CN.json src/i18n/locales/en-US.json
git commit -m "feat(ui): add openai-image option to provider type select"
```

---

## Task 8: UI — Home 列表标签和配色

**Files:**
- Modify: `src/pages/Home/index.vue:127-135`

### Step 8.1: 修改 providerLabel

- [ ] **替换 `src/pages/Home/index.vue:127-130`：**

```js
function providerLabel(type) {
  const map = { 'openai-chat': 'OpenAI Chat', 'openai-response': 'OpenAI Response', 'anthropic-message': 'Anthropic', 'newapi': 'NEW API' }
  return map[type] || type
}
```

**为：**

```js
function providerLabel(type) {
  const map = { 'openai-chat': 'OpenAI Chat', 'openai-response': 'OpenAI Response', 'anthropic-message': 'Anthropic', 'openai-image': 'OpenAI Image', 'newapi': 'NEW API' }
  return map[type] || type
}
```

### Step 8.2: 修改 providerColor

- [ ] **替换 `src/pages/Home/index.vue:132-135`：**

```js
function providerColor(type) {
  const map = { 'openai-chat': '#10b981', 'openai-response': '#f59e0b', 'anthropic-message': '#8b5cf6', 'newapi': '#06b6d4' }
  return map[type] || '#6b7280'
}
```

**为（加 `openai-image` 用粉色 `#ec4899` 与现有四色区分）：**

```js
function providerColor(type) {
  const map = { 'openai-chat': '#10b981', 'openai-response': '#f59e0b', 'anthropic-message': '#8b5cf6', 'openai-image': '#ec4899', 'newapi': '#06b6d4' }
  return map[type] || '#6b7280'
}
```

### Step 8.3: 提交

- [ ] **提交：**

```bash
git add src/pages/Home/index.vue
git commit -m "feat(ui): label and color for openai-image profile cards"
```

---

## Task 9: 手工 e2e 验收

**目标**：在 `npm run tauri dev` 中走通真实图像请求。这一步不写代码，是验收清单。

### Step 9.1: 启动 dev

- [ ] **运行：**

```bash
npm run tauri dev
```

等 sidecar 在 `localhost:9999` 监听。

### Step 9.2: UI 配置 openai-image profile

- [ ] **打开 Settings → Profiles，新建一个 profile：**

  - Name: `OpenAI Image`
  - Provider type: `OpenAI 图像` / `OpenAI Image`（验证 select 中能选到，验证 Home 列表标签和配色显示）
  - Base URL: `https://api.openai.com`
  - API key: 自己的 `sk-...`
  - Default model: `gpt-image-1`
  - Models: `gpt-image-1`, `dall-e-3`

保存后回到 Home 验证卡片 tag 颜色为粉色、文本为 "OpenAI Image"。

### Step 9.3: generations / JSON 文生图

- [ ] **运行：**

```bash
curl -X POST http://localhost:9999/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-1","prompt":"a cute orange cat sitting on a table","size":"1024x1024","n":1}'
```

**预期：** HTTP 200，响应体 JSON 含 `data[].b64_json` 或 `data[].url`。

**日志验证：** 在 Tauri 应用的 Logs 页查找该请求，确认：
- endpoint = `/v1/images/generations`
- model = `gpt-image-1`
- statusCode = 200
- responseBody 中 `b64_json` 字段被替换为 `<base64 stripped, length=N>`

### Step 9.4: edits / multipart 图生图

- [ ] **准备一张 png 小图（例如 `cat.png`），运行：**

```bash
curl -X POST http://localhost:9999/v1/images/edits \
  -F model=gpt-image-1 \
  -F 'prompt=add a hat on the cat' \
  -F image=@cat.png
```

**预期：** HTTP 200，响应 JSON。

**日志验证：**
- endpoint = `/v1/images/edits`
- model = `gpt-image-1`
- requestBody = `{"fields":{"model":"gpt-image-1","prompt":"add a hat on the cat"},"files":[{"name":"image","filename":"cat.png","contentType":"image/png","size":...}]}`
- 不包含 png 字节
- responseBody 中 `b64_json` 被剥离

### Step 9.5: 多 profile 路由

- [ ] **再建一个 openai-image profile B（不同 base URL 或不同 key），models = `['dall-e-3']`。**

发起：

```bash
curl -X POST http://localhost:9999/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"dall-e-3","prompt":"a sunset","size":"1024x1024"}'
```

**预期：** 路由命中 profile B（日志 provider 字段为 B 的 name）。

### Step 9.6: 超大 body 拦截

- [ ] **生成 250MB 的伪文件并上传：**

```bash
dd if=/dev/zero of=/tmp/big.bin bs=1m count=250
curl -i -X POST http://localhost:9999/v1/images/edits \
  -F model=gpt-image-1 -F prompt=x -F image=@/tmp/big.bin
rm /tmp/big.bin
```

**预期：** HTTP 413，响应 `{"error":"Payload Too Large","maxBytes":209715200}`。

### Step 9.7: 不匹配 model

- [ ] **运行：**

```bash
curl -i -X POST http://localhost:9999/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"nonexistent-model","prompt":"x"}'
```

**预期：** HTTP 400，`error.code = "model_not_found"`。

### Step 9.8: 同名模型不跨 source 路由

- [ ] **在某个 openai-chat profile 的 models 列表里临时加上 `gpt-image-1`，发起 `/v1/images/generations` 请求带 `model=gpt-image-1`。**

**预期：** 仍命中 openai-image profile（不是 chat profile），日志 provider 显示 image profile 名称。

测完移除该测试模型。

### Step 9.9: 回归现有接口

- [ ] **走一遍现有 chat / responses / messages 请求，确认未受影响：**

```bash
# Chat
curl -X POST http://localhost:9999/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<现有 chat model>","messages":[{"role":"user","content":"hi"}]}'
# Responses
curl -X POST http://localhost:9999/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"<现有 response model>","input":"hi"}'
# Messages
curl -X POST http://localhost:9999/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"<现有 anthropic model>","messages":[{"role":"user","content":"hi"}],"max_tokens":100}'
```

**预期：** 都返回 200。

### Step 9.10: 标记完成

- [ ] **若全部通过：**

```bash
git log --oneline dev-1.2.0..dev-1.3.0
```

确认所有 commits 清单合理。手工验收无代码改动，无需 commit。

如发现 bug：回到对应 Task 修复后重跑 9.x 步骤。

---

## 完成条件

- [ ] Task 1-8 所有 step 完成且各自 commit
- [ ] Task 9 所有 e2e 步骤通过
- [ ] `node --test proxy/multipart-scanner.test.js` 5 passes
- [ ] `node --test proxy/sanitize.test.js` 4 passes
- [ ] `node --test proxy/protocol-converters.test.js` 全过（回归）
- [ ] dev-1.3.0 分支 commits 数量约 8（每 Task 一个）+ docs commit 已存在
