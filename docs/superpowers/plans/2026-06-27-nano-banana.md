# Nano Banana 图像生成接口集成实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `google-nano-banana` providerType，支持 Google Nano Banana Interactions API 的代理透传和 OpenAI 兼容转换。

**Architecture:** 在 proxy 层新增 `/v1beta/interactions` 路由做原生透传，同时在 `/v1/images/generations` 路径上增加 OpenAI→Nano Banana 请求/响应转换。UI 层新增 providerType 选项和标签。Rust 层更新模型获取逻辑。

**Tech Stack:** Node.js (http/https), Vue 3, Rust (reqwest), i18n JSON

---

## Task 1: 代理路由和 ProviderType 注册

**Files:**
- Modify: `proxy/proxy-server.js:54-77` (PATH_TO_SOURCE + PROVIDER_META)
- Modify: `proxy/proxy-server.js:680-690` (load balancer image source check)
- Modify: `proxy/proxy-server.js:807-840` (model routing image source check)

- [ ] **Step 1: 添加 `/v1beta/interactions` 到 PATH_TO_SOURCE**

在 `proxy/proxy-server.js` 第 54-63 行的 `PATH_TO_SOURCE` 对象中新增条目：

```javascript
const PATH_TO_SOURCE = {
  '/v1/chat/completions': 'chat_completions',
  '/v1/responses': 'responses',
  '/v1/messages': 'messages',
  '/chat/completions': 'chat_completions',
  '/responses': 'responses',
  '/messages': 'messages',
  '/v1/images/generations': 'image',
  '/v1/images/edits': 'image',
  '/v1beta/interactions': 'interactions'   // ← 新增
}
```

- [ ] **Step 2: 添加 `google-nano-banana` 到 PROVIDER_META**

在 `proxy/proxy-server.js` 第 67-77 行的 `PROVIDER_META` 对象中新增条目：

```javascript
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
  'google-nano-banana': { target: 'interactions',     path: '/v1beta/interactions', authType: 'x-goog-api-key' }  // ← 新增
}
```

- [ ] **Step 3: 更新负载均衡器中的 image source 检查**

在 `proxy/proxy-server.js` 的 `findLBGroupForModel` 函数（约第 683-684 行）中，更新 image source 检查逻辑，允许 `google-nano-banana` 处理 image 请求：

```javascript
// 原代码:
if (source === 'image' && p.providerType !== 'openai-image') continue
if (source !== 'image' && p.providerType === 'openai-image') continue

// 改为:
const imageProviders = new Set(['openai-image', 'google-nano-banana'])
if (source === 'image' && !imageProviders.has(p.providerType)) continue
if (source !== 'image' && imageProviders.has(p.providerType)) continue
```

- [ ] **Step 4: 更新 handleApiRequest 中的模型路由 image source 检查**

在 `proxy/proxy-server.js` 的 `handleApiRequest` 函数中，有 4 处类似的 image source 检查需要更新（约第 807、809、822、824、837、839 行）。使用相同的 `imageProviders` 集合：

```javascript
// 在函数顶部定义（约第 714 行之后）:
const imageProviders = new Set(['openai-image', 'google-nano-banana'])

// 然后将所有以下模式:
if (source === 'image' && p.providerType !== 'openai-image') continue
if (source !== 'image' && p.providerType === 'openai-image') continue

// 替换为:
if (source === 'image' && !imageProviders.has(p.providerType)) continue
if (source !== 'image' && imageProviders.has(p.providerType)) continue
```

注意：同样的替换也需要应用到 failover 路径中的检查（约第 1007-1009 行）。

- [ ] **Step 5: 更新 failover 路径中的 image source 检查**

在 failover 循环中（约第 1004-1009 行），找到以下代码并应用相同的替换：

```javascript
// 原代码:
if (source === 'image' && np.providerType !== 'openai-image') continue
if (source !== 'image' && np.providerType === 'openai-image') continue

// 改为:
if (source === 'image' && !imageProviders.has(np.providerType)) continue
if (source !== 'image' && imageProviders.has(np.providerType)) continue
```

- [ ] **Step 6: 添加 interactions source 的原生透传逻辑**

在 `proxy/proxy-server.js` 的 `handleApiRequest` 函数中，`source === 'image'` 的 pass-through 块之后（约第 927 行），添加 `interactions` source 的处理：

```javascript
if (source === 'interactions') {
  // Native pass-through: forward request body as-is to Google Interactions API
  forwardRequest(req, res, upstreamUrl, profile.apiKey, body,
    null, req._onResponseBody || null, null, source, profile.id, 'application/json')
  return
}
```

- [ ] **Step 7: 提交**

```bash
git add proxy/proxy-server.js
git commit -m "feat(proxy): add google-nano-banana provider type and /v1beta/interactions route"
```

---

## Task 2: OpenAI → Nano Banana 请求/响应转换

**Files:**
- Modify: `proxy/proxy-server.js:914-927` (image pass-through block)

- [ ] **Step 1: 添加 OpenAI size → Nano Banana 转换辅助函数**

在 `proxy/proxy-server.js` 中，`handleApiRequest` 函数之前（约第 700 行附近），添加以下辅助函数：

```javascript
// --- OpenAI → Nano Banana conversion helpers ---

const OPENAI_SIZE_TO_NANOBANANA = {
  '1024x1024': { aspect_ratio: '1:1', image_size: '1K' },
  '1792x1024': { aspect_ratio: '16:9', image_size: '2K' },
  '1024x1792': { aspect_ratio: '9:16', image_size: '2K' },
  '512x512':   { aspect_ratio: '1:1', image_size: '0.5K' },
  '256x256':   { aspect_ratio: '1:1', image_size: '0.5K' }
}

// Supported Nano Banana aspect ratios (width:height)
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
  // Direct lookup for common sizes
  const direct = OPENAI_SIZE_TO_NANOBANANA[size]
  if (direct) return direct
  // Parse WxH and find closest ratio
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
  // Estimate image_size from pixel count
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

function convertNanoBananaResponseToOpenAI(interaction) {
  let base64Data = null
  let revisedPrompt = null
  // Prefer output_image convenience property
  if (interaction.output_image && interaction.output_image.data) {
    base64Data = interaction.output_image.data
  }
  // Fallback: scan steps for last image block
  if (!base64Data && Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      if (step.type === 'model_output' && Array.isArray(step.content)) {
        for (const block of step.content) {
          if (block.type === 'image' && block.data) base64Data = block.data
          if (block.type === 'text' && block.text) revisedPrompt = block.text
        }
      }
    }
  }
  if (!base64Data) return { created: Math.floor(Date.now() / 1000), data: [] }
  const item = { b64_json: base64Data }
  if (revisedPrompt) item.revised_prompt = revisedPrompt
  return { created: Math.floor(Date.now() / 1000), data: [item] }
}
```

- [ ] **Step 2: 在 image pass-through 路径中添加 OpenAI→Nano Banana 转换**

在 `proxy/proxy-server.js` 的 `source === 'image'` 块中（约第 914-927 行），在现有 pass-through 逻辑之前插入 Nano Banana 转换分支：

```javascript
if (source === 'image') {
  // OpenAI → Nano Banana conversion
  if (profile.providerType === 'google-nano-banana' && urlPath === '/v1/images/generations') {
    const nanoBody = convertOpenAIToNanoBanana(body, profile.defaultModel)
    const nanoUrl = `${baseUrl}/v1beta/interactions`
    req._upstreamUrl = nanoUrl

    // Forward to Nano Banana Interactions API
    const transport = nanoUrl.startsWith('https') ? https : http
    const parsed = new URL(nanoUrl)
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
        upstreamRes.headers = upstreamRes.headers
        upstreamRes.statusCode = upstreamRes.statusCode
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
          const openaiResponse = convertNanoBananaResponseToOpenAI(interaction)
          const responseBody = JSON.stringify(openaiResponse)
          res.writeHead(200, { 'Content-Type': 'application/json' })
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
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }))
      }
    })

    upstreamReq.write(bodyBuf)
    upstreamReq.end()
    return
  }

  // No SSE, no body conversion — pass through (existing code).
  const rawBuffer = req._rawBuffer
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
```

- [ ] **Step 3: 提交**

```bash
git add proxy/proxy-server.js
git commit -m "feat(proxy): add OpenAI to Nano Banana request/response conversion"
```

---

## Task 3: UI 更新 — ProfileEdit 和 Home 页面

**Files:**
- Modify: `src/pages/ProfileEdit/index.vue:212-219` (providerType dropdown)
- Modify: `src/pages/Home/index.vue:131-139` (providerLabel + providerColor)

- [ ] **Step 1: 在 ProfileEdit 下拉选项中新增 `google-nano-banana`**

在 `src/pages/ProfileEdit/index.vue` 第 218 行（`google-gemini` option 之后）添加新选项：

```html
<select v-model="form.providerType">
  <option value="openai-chat">{{ $t('profileEdit.providerType.openai-chat') }}</option>
  <option value="openai-response">{{ $t('profileEdit.providerType.openai-response') }}</option>
  <option value="anthropic-message">{{ $t('profileEdit.providerType.anthropic-message') }}</option>
  <option value="openai-image">{{ $t('profileEdit.providerType.openai-image') }}</option>
  <option value="google-gemini">{{ $t('profileEdit.providerType.google-gemini') }}</option>
  <option value="google-nano-banana">{{ $t('profileEdit.providerType.google-nano-banana') }}</option>
  <option value="newapi">{{ $t('profileEdit.providerType.newapi') }}</option>
</select>
```

- [ ] **Step 2: 在 Home 页面添加 providerLabel 和 providerColor 映射**

在 `src/pages/Home/index.vue` 第 131-139 行更新两个映射函数：

```javascript
function providerLabel(type) {
  const map = { 'openai-chat': 'OpenAI Chat', 'openai-response': 'OpenAI Response', 'anthropic-message': 'Anthropic', 'openai-image': 'OpenAI Image', 'google-gemini': 'Google Gemini', 'google-nano-banana': 'Nano Banana', 'newapi': 'NEW API' }
  return map[type] || type
}

function providerColor(type) {
  const map = { 'openai-chat': '#10b981', 'openai-response': '#f59e0b', 'anthropic-message': '#8b5cf6', 'openai-image': '#ec4899', 'google-gemini': '#4285f4', 'google-nano-banana': '#34a853', 'newapi': '#06b6d4' }
  return map[type] || '#6b7280'
}
```

颜色选择：`#34a853` 是 Google 绿色，与 `google-gemini` 的 `#4285f4`（Google 蓝色）区分。

- [ ] **Step 3: 提交**

```bash
git add src/pages/ProfileEdit/index.vue src/pages/Home/index.vue
git commit -m "feat(ui): add google-nano-banana provider type to ProfileEdit and Home"
```

---

## Task 4: i18n 翻译

**Files:**
- Modify: `src/i18n/locales/zh-CN.json:271-278`
- Modify: `src/i18n/locales/en-US.json:271-278`

- [ ] **Step 1: 添加中文翻译**

在 `src/i18n/locales/zh-CN.json` 的 `profileEdit.providerType` 对象中新增：

```json
"providerType": {
  "openai-chat": "OpenAI Chat Completions",
  "openai-response": "OpenAI Responses",
  "anthropic-message": "Anthropic Messages",
  "openai-image": "OpenAI 图像",
  "google-gemini": "Google Gemini",
  "google-nano-banana": "Google Nano Banana",
  "newapi": "NEW API"
}
```

- [ ] **Step 2: 添加英文翻译**

在 `src/i18n/locales/en-US.json` 的 `profileEdit.providerType` 对象中新增：

```json
"providerType": {
  "openai-chat": "OpenAI Chat Completions",
  "openai-response": "OpenAI Responses",
  "anthropic-message": "Anthropic Messages",
  "openai-image": "OpenAI Image",
  "google-gemini": "Google Gemini",
  "google-nano-banana": "Google Nano Banana",
  "newapi": "NEW API"
}
```

- [ ] **Step 3: 提交**

```bash
git add src/i18n/locales/zh-CN.json src/i18n/locales/en-US.json
git commit -m "feat(i18n): add google-nano-banana translations"
```

---

## Task 5: Rust 层更新 — 模型获取支持

**Files:**
- Modify: `src-tauri/src/commands.rs:298-380` (fetch_provider_models)

- [ ] **Step 1: 更新 fetch_provider_models 支持 `google-nano-banana`**

在 `src-tauri/src/commands.rs` 的 `fetch_provider_models` 函数中，更新 `is_gemini` 检查以同时覆盖 `google-nano-banana`：

```rust
// 原代码 (第 305 行):
let is_gemini = provider_type == "google-gemini";

// 改为:
let is_gemini = provider_type == "google-gemini" || provider_type == "google-nano-banana";
```

这样 `google-nano-banana` 会使用相同的 Google API 认证方式（`x-goog-api-key`）和端点（`/v1beta/models`）来获取模型列表。

- [ ] **Step 2: 验证编译通过**

```bash
cd src-tauri && cargo check
```

Expected: 编译成功，无错误。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(rust): support google-nano-banana in fetch_provider_models"
```

---

## Task 6: 验证和最终提交

- [ ] **Step 1: 启动开发模式验证编译**

```bash
npm run tauri dev
```

Expected: 前端和 Rust 编译成功，代理启动。

- [ ] **Step 2: 验证 UI**

1. 打开 ProfileEdit 页面，确认下拉列表中出现 "Google Nano Banana" 选项
2. 选择该类型后，填写 baseUrl（默认 `https://generativelanguage.googleapis.com`）和 API Key
3. 点击 "Fetch Models" 按钮，确认能获取到模型列表
4. 保存配置后，在 Home 页面确认显示绿色 "Nano Banana" 标签

- [ ] **Step 3: 验证原生透传**

使用 curl 测试 `/v1beta/interactions` 原生端点：

```bash
curl -X POST http://127.0.0.1:9999/v1beta/interactions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-image",
    "input": "Create a picture of a cute cat"
  }'
```

Expected: 收到 Google Interactions API 的原始 JSON 响应，包含 `steps` 和 `output_image`。

- [ ] **Step 4: 验证 OpenAI 兼容转换**

使用 curl 测试 OpenAI 格式的图像生成：

```bash
curl -X POST http://127.0.0.1:9999/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-image",
    "prompt": "Create a picture of a cute cat",
    "size": "1024x1024",
    "response_format": "b64_json"
  }'
```

Expected: 收到 OpenAI 格式的响应 `{ "created": ..., "data": [{ "b64_json": "..." }] }`。

- [ ] **Step 5: 验证图像编辑（原生透传）**

```bash
curl -X POST http://127.0.0.1:9999/v1beta/interactions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-image",
    "input": [
      {"type": "text", "text": "Add a hat to this cat"},
      {"type": "image", "data": "<BASE64_IMAGE>", "mime_type": "image/png"}
    ]
  }'
```

Expected: 收到编辑后的图像响应。

- [ ] **Step 6: 最终提交**

```bash
git add -A
git commit -m "feat: add Google Nano Banana image generation proxy support"
```
