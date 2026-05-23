# OpenAI 图像生成支持 — 设计文档

- **日期**：2026-05-22
- **分支**：`dev-1.3.0`
- **状态**：Draft（待评审）

## 1. 目标

在现有的 AIGateway 文本代理基础上，新增对 OpenAI 图像生成接口的支持，覆盖两个端点：

- `POST /v1/images/generations`（文生图）
- `POST /v1/images/edits`（图生图 / 图像编辑）

只处理 OpenAI 协议（不做跨协议转换）。`/v1/images/variations` 不在本次范围内（DALL-E 2 老接口，新的 gpt-image-1 不支持）。

## 2. 非目标

- 不实现 `/v1/images/variations`
- 不引入 multipart 解析库（如 busboy / formidable）—— 用最小自实现避免 bun compile 兼容风险
- 不做 OpenAI 之外其它图像 API 协议（如 Anthropic、Stability、MidJourney）的转换
- 不修改任何 Rust 数据结构（`Profile.provider_type` 已是 `String`，新增枚举值不需要 schema 变更）
- 不为图像加入 SSE / 流式响应（OpenAI 图像 API 本身不支持流式）

## 3. 关键决策

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| D1 | 接口范围：generations + edits | 仅 generations / 加 variations | 覆盖用户需求；variations 已被 OpenAI 新模型放弃 |
| D2 | 新增 `openai-image` providerType | 复用 openai-chat；新增 capabilities 数组 | 与现有"一个 providerType 对应一类上游协议族"一致；UI 改动最小 |
| D3 | multipart：buffer 整 body + 轻量扫描提取文本字段 + 原字节透传 | 流式 busboy 解析；query string 兜底 model | 路由需要 model，必须解析；不重组字节避免兼容问题；零新依赖 |
| D4 | body 上限硬编码 200MB | UI 可配置 | MVP 不引入新设置项 |
| D5 | 图像 profile 路由时按 `providerType === 'openai-image'` 过滤 | 仅按 model 匹配 | 避免 chat profile 和 image profile 声明同名模型时错配 |
| D6 | 日志：剥离 multipart 文件字节 + 响应 `b64_json` 字段 | 全量记录 / 完全不记录 | 用户要求保留传参 JSON，文件/base64 数据剥离 |

## 4. 架构

### 4.1 路由表扩展

`proxy/proxy-server.js` 中：

```js
const PATH_TO_SOURCE = {
  // existing...
  '/v1/images/generations': 'image',
  '/v1/images/edits':       'image'
}

const PROVIDER_META = {
  // existing 'openai-chat' / 'openai-response' / 'anthropic-message' / 'newapi'
  'openai-image': {
    target: 'image',
    paths: {
      '/v1/images/generations': '/v1/images/generations',
      '/v1/images/edits':       '/v1/images/edits'
    }
  }
}
```

`source === 'image'` 是一类新的源标记；同时 `target === 'image'`。`getBodyConverter('image', 'image')` 返回 `null`（无协议转换）；`createSSEConverter` 不调用（图像无流式）。

### 4.2 请求处理流程

```text
incoming /v1/images/* request
  │
  ├─ Content-Type: application/json
  │     │
  │     ├─ readBody → JSON  (现有逻辑)
  │     ├─ extract body.model → route profile (providerType=openai-image)
  │     ├─ forwardRequest(upstream, body as JSON)
  │     └─ log(requestBody=body)
  │
  └─ Content-Type: multipart/form-data
        │
        ├─ guard: Content-Length / streamed bytes ≤ 200MB → else 413
        ├─ readBodyAsBuffer(req) → Buffer  (新增辅助函数)
        ├─ parseMultipartFields(buffer, boundary) → { fields, files }
        ├─ extract fields.model → route profile (providerType=openai-image)
        ├─ forwardRequest(upstream, buffer raw bytes, original Content-Type)
        └─ log(requestBody={ fields, files })
```

**入口分流点**：当前 `proxy-server.js` line 811-822 对所有 `PATH_TO_SOURCE` 路径无条件调用 `readBody`（JSON 解析）。改造：

```js
} else if (PATH_TO_SOURCE[urlPath]) {
  const ct = req.headers['content-type'] || ''
  if (ct.startsWith('multipart/form-data')) {
    // image edits — buffer raw bytes, defer parsing to handleApiRequest
    const buf = await readBodyAsBuffer(req, MAX_IMAGE_BODY)  // 413 on overflow
    req._rawBuffer = buf
    req._contentType = ct
    model = '-'  // resolved later inside handleApiRequest
  } else {
    rawBody = await readBody(req)         // existing path
    model = (rawBody && rawBody.model) || '-'
    req._body = rawBody
  }
  if (logEnabled) { req._onResponseBody = wrapResponseLogger(/* source */) }
  await handleApiRequest(req, res)
  if (req._loggedRequestBody) rawBody = req._loggedRequestBody  // multipart sets { fields, files }
  if (req._resolvedModel) model = req._resolvedModel
  ...
}
```

`handleApiRequest` 在 multipart 分支里调 `parseMultipartFields`，把 `{ fields, files }` 写到 `req._loggedRequestBody`，把 `fields.model` 写到 `req._resolvedModel`，供外层日志使用。

### 4.3 路由匹配规则

文本接口现有逻辑：找第一个 `models.includes(requestedModel)` 的 profile。

图像接口扩展为：找第一个**同时满足** `providerType === 'openai-image' && models.includes(requestedModel)` 的 profile。

如 `requestedModel` 缺失（multipart 没传 model 字段、JSON body 没 model）：fall back 到第一个 `providerType === 'openai-image' && models.length > 0` 的 profile（与现有文本接口的 fallback 一致）。

如无任何匹配：返回 `400 { error: { message: 'AI 网关未匹配到模型: ${model}', type: 'invalid_request_error', code: 'model_not_found' } }`（与文本路径一致）。

## 5. multipart 扫描器

### 5.1 模块

新文件：`proxy/multipart-scanner.js`，约 70 行，零依赖（仅 Node 内置）。

### 5.2 接口

```js
/**
 * Scan a multipart/form-data Buffer and extract non-file fields as text.
 * File parts (those with filename=) are NOT decoded — only metadata recorded.
 *
 * @param {Buffer} buf       Complete request body
 * @param {string} boundary  Boundary string from Content-Type header (without "--")
 * @returns {{ fields: Record<string, string>, files: Array<{ name, filename, contentType, size }> }}
 * @throws {Error} when malformed (no boundary found, no terminator)
 */
export function parseMultipartFields(buf, boundary)
```

### 5.3 算法

1. 从 `Content-Type: multipart/form-data; boundary=XYZ` 中取出 `boundary`（OpenAI / 标准客户端格式）
2. 用 `Buffer.indexOf(Buffer.from('--' + boundary))` 切片定位每个 part 起点
3. 对每个 part：
   - 从起点找到第一个 `\r\n\r\n`（headers 与 content 分界）
   - 解析 headers 段（解码为 ASCII 字符串）：
     - 取 `Content-Disposition: form-data; name="X"; filename="Y"` 中的 `name` 和 `filename`
     - 取 `Content-Type` 头（无则用 `application/octet-stream`）
   - 定位 part 终点（下一个 `--boundary`，往前减 `\r\n`）
   - **有 `filename`**：跳过 content，只记 `{ name, filename, contentType, size: content.length }`
   - **无 `filename`**：把 content 当 UTF-8 字符串，写到 `fields[name]`
4. 遇 `--boundary--`（terminator）结束

### 5.4 边界条件

- `boundary` 可被引号包围（`boundary="XYZ"`）→ 去引号
- 多个同名字段（如 `image[]`）：fields 用最后值覆盖（OpenAI 也允许 `image[]` 重复 → 但那是文件，按 files 数组累加）；files 数组保留所有
- malformed body / 找不到 boundary：抛错，调用方返 `400 Bad multipart`
- 部分 part 缺失 `name=`：跳过该 part（不抛错）

## 6. 上游转发

复用现有 `forwardRequest()`，无需改造接口签名。两点适配：

1. **Content-Type 透传**：对 multipart 路径，调用 `forwardRequest` 前把 `req.headers['content-type']` 原样传到上游 headers（不能用现有的 `'application/json'` 默认值）。改造 `forwardRequest` 内 headers 构建，接收一个可选 `contentType` 参数（默认 `'application/json'`）。
2. **Body 写入**：现有调用 `upstreamReq.write(bodyStr)` 把对象序列化为 JSON 字符串。multipart 路径改为传入 `Buffer`，直接 `upstreamReq.write(buffer)`。需要在 `forwardRequest` 中识别 body 类型（`Buffer.isBuffer(body)`）跳过 `JSON.stringify`。

URL 拼接：`profile.baseUrl + meta.paths[reqPath]`，复用现有 `baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')` 规整化。

## 7. 日志策略

### 7.1 请求体

| 路径 | requestBody（日志中） |
|---|---|
| `/v1/images/generations`（JSON） | 原 JSON body（与现有 chat 路径一致） |
| `/v1/images/edits`（multipart） | `{ fields: {...}, files: [{ name, filename, contentType, size }, ...] }` |

### 7.2 响应体

`source === 'image'` 时，sanitize 注入点是**外层** `req._onResponseBody`（`proxy-server.js` 当前 line 816 设置的回调）而非 `forwardRequest` 内部——`forwardRequest` 的 `onResponseBody` 拿到的是上游完整 body 字符串（line 554 已聚合完成），我们在外层包装这个回调：

```js
// 在 PATH_TO_SOURCE 分支设置 _onResponseBody 时:
req._onResponseBody = (body) => {
  responseBody = (source === 'image') ? sanitizeImageResponseBody(body) : body
}

function sanitizeImageResponseBody(rawText) {
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
    return rawText  // non-JSON (error page etc.) — log as-is
  }
}
```

**只影响日志**，不修改返回给客户端的字节（client 侧 `clientRes.end(responseBody)` 在 sanitize 之前已经发出，line 553）。

### 7.3 logEnabled 开关

沿用现有 `currentConfig.settings.logEnabled`：关闭时仅记录 timestamp / endpoint / model / status / duration，不写 requestBody / responseBody。

## 8. UI 改动

### 8.1 ProfileEdit（`src/pages/ProfileEdit/index.vue`）

`<select v-model="form.providerType">` 块（约 line 216-220）新增一行：

```html
<option value="openai-image">{{ $t('profileEdit.providerType.openai-image') }}</option>
```

无新字段、无表单分支——图像 profile 复用现有 `name` / `baseUrl` / `apiKey` / `defaultModel` / `models`。

### 8.2 Home 列表（`src/pages/Home/index.vue`）

- `providerLabel('openai-image')` → 返回 i18n key 翻译
- `providerColor('openai-image')` → 挑一个与现有 openai-chat / openai-response / anthropic-message 区分的色调（建议偏紫粉，待实现时定）

### 8.3 i18n（`src/i18n/locales/`）

| key | zh-CN | en-US |
|---|---|---|
| `profileEdit.providerType.openai-image` | `OpenAI 图像` | `OpenAI Image` |

## 9. Rust / IPC

**零改动**。

确认理由：
- `Profile.provider_type: String`（`src-tauri/src/config.rs:13-14`），无枚举约束
- grep `src-tauri/src/` 未发现 providerType 白名单或硬编码值
- sidecar IPC 透传 profile 整体，不解析 providerType

## 10. 错误处理

| 场景 | 状态码 | 响应体 |
|---|---|---|
| body > 200MB | 413 | `{ error: 'Payload Too Large', maxBytes: 209715200 }` |
| multipart Content-Type 但无 boundary | 400 | `{ error: 'Bad multipart: missing boundary' }` |
| multipart 解析失败 | 400 | `{ error: 'Bad multipart: malformed body' }` |
| model 字段缺失且无可用 image profile | 503 | `{ error: 'AI 网关无可用图像提供商配置' }` |
| model 匹配不到任何 image profile | 400 | `{ error: { message, type: 'invalid_request_error', code: 'model_not_found' } }` |
| 上游错误 / 超时 | 502 / 504 | 沿用 `forwardRequest` 现有错误响应 |

上游返回的错误（4xx/5xx 含 OpenAI 自带的内容审核拒绝 `safety_violations`）直接透传，不二次处理。

## 11. 文件清单

### 新增

- `proxy/multipart-scanner.js` — multipart 字段扫描器
- `docs/superpowers/specs/2026-05-22-openai-image-design.md` — 本文档

### 修改

- `proxy/proxy-server.js`
  - `PATH_TO_SOURCE` 新增 2 条
  - `PROVIDER_META` 新增 `openai-image` 项（multi-path 结构）
  - 入口分发（line 811 附近）：按 Content-Type 分流 JSON / multipart
  - 新增 `readBodyAsBuffer(req, maxBytes)` 辅助函数（流式累积，超限抛错触发 413）
  - 新增常量 `MAX_IMAGE_BODY = 200 * 1024 * 1024`
  - `handleApiRequest`：识别 `source === 'image'`，按 `req._rawBuffer` 走 multipart 分支
  - `forwardRequest`：参数支持 Buffer body 和自定义 Content-Type
  - 新增 `sanitizeImageResponseBody`
  - `_onResponseBody` 包装：image source 时调 sanitize
  - 路由选择条件：image 路径加 `providerType === 'openai-image'` 过滤
- `src/pages/ProfileEdit/index.vue` — option 一行
- `src/pages/Home/index.vue` — providerLabel / providerColor 两处分支
- `src/i18n/locales/zh-CN.json` — 1 key
- `src/i18n/locales/en-US.json` — 1 key

### 不修改

- `src-tauri/src/*.rs`
- `proxy/protocol-converters.js`
- `proxy/protocol-converters.test.js`

## 12. 测试策略

无单元测试框架；以手工 e2e 为主：

1. **JSON / generations**
   - 建 openai-image profile（baseUrl `https://api.openai.com`，models `['gpt-image-1', 'dall-e-3']`）
   - `curl -X POST localhost:9999/v1/images/generations -H 'Content-Type: application/json' -d '{"model":"gpt-image-1","prompt":"a cat","size":"1024x1024"}'`
   - 验证：返 200 + JSON 含 `data[].b64_json` / `url`；日志中 b64 被剥离

2. **multipart / edits**
   - 同上 profile
   - `curl -X POST localhost:9999/v1/images/edits -F model=gpt-image-1 -F prompt=add\ hat -F image=@cat.png`
   - 验证：上游收到完整 multipart；返 200；日志中 `fields.prompt='add hat'`，`files=[{filename:'cat.png',size:...}]`，无 png 字节

3. **多 profile 路由**
   - 建两个 openai-image profile：A models `['gpt-image-1']`，B models `['dall-e-3']`
   - 分别发请求验证路由正确

4. **错误**
   - `curl -F image=@huge_file.png` 超过 200MB → 413
   - 不存在的 model → 400 `model_not_found`
   - 同名 model 在 chat profile 中也声明 → 验证图像请求只命中 image profile

5. **回归**
   - 现有 `/v1/chat/completions` / `/v1/responses` / `/v1/messages` 各跑一遍，确认无破坏

## 13. 后续可能（不在本次范围）

- `/v1/images/variations` 支持
- 图像 multipart 上限 UI 可配
- 其他厂商图像 API 协议转换（Stability、Anthropic 等）
- 图像响应缓存（CDN URL 短链化）

---

**评审标记**：等待用户确认。
