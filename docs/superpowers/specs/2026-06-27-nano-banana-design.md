# Nano Banana 图像生成接口集成设计

**日期:** 2026-06-27
**分支:** dev-1.5.0
**状态:** 已批准

## 背景

Google 推出了 Nano Banana 系列图像生成模型，通过 Interactions API（`/v1beta/interactions`）提供文本生成图像、图像编辑、多轮迭代等功能。当前 AIGateway 的 `google-gemini` providerType 仅支持 `generateContent` 文本对话，不支持图像生成。

需要新增独立的 `google-nano-banana` providerType，支持 Nano Banana Interactions API 的代理和协议转换。

## 功能范围

第一版支持：
- 文本生成图像（text-to-image）
- 图像编辑（text-and-image-to-image）
- 宽高比/分辨率配置（response_format: aspect_ratio, image_size）
- 多轮编辑（previous_interaction_id）

不支持（第一版）：
- Google Search grounding tools
- Video-to-image
- Thinking process 详情输出
- Batch API

## 设计

### 1. 新增 ProviderType: `google-nano-banana`

配置字段（与 `google-gemini` 一致）：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `name` | 配置名称 | 用户自定义 |
| `providerType` | `google-nano-banana` | — |
| `baseUrl` | Google API 基础地址 | `https://generativelanguage.googleapis.com` |
| `apiKey` | Google API Key | 用户填写 |
| `defaultModel` | 默认模型 | `gemini-3.1-flash-image` |
| `models` | 可用模型列表 | 用户配置 |

支持的模型：
- `gemini-3.1-flash-image`（Nano Banana 2）
- `gemini-3-pro-image`（Nano Banana Pro）
- `gemini-2.5-flash-image`（Nano Banana）

### 2. 代理端点

#### 端点一：原生透传 `POST /v1beta/interactions`

客户端直接发送 Nano Banana 原生请求格式，代理做最小化处理后透传。

**请求流程：**
```
Client → POST localhost:9999/v1beta/interactions
  ↓
代理处理：
  1. 注入 x-goog-api-key header
  2. 替换目标地址为 {baseUrl}/v1beta/interactions
  3. 转发请求
  4. 透传响应
```

**请求格式（原样透传）：**
```json
{
  "model": "gemini-3.1-flash-image",
  "input": "生成一只猫的图片",
  "response_format": {
    "type": "image",
    "aspect_ratio": "16:9",
    "image_size": "2K"
  }
}
```

**支持的 input 类型：**
- 纯文本：`"input": "prompt text"`
- 文本对象：`"input": [{"type": "text", "text": "..."}]`
- 混合输入（图像编辑）：`"input": [{"type": "text", "text": "..."}, {"type": "image", "data": "base64...", "mime_type": "image/png"}]`
- 多图输入：数组中包含多个 image 对象

**支持的可选参数：**
- `response_format` — 输出格式、宽高比、分辨率
- `previous_interaction_id` — 多轮编辑
- `generation_config` — thinking_level 等

#### 端点二：OpenAI 兼容 `POST /v1/images/generations`

接收 OpenAI 图像生成格式，自动转换为 Nano Banana Interactions 格式。

**请求转换映射：**

| OpenAI 字段 | Nano Banana 字段 | 转换规则 |
|---|---|---|
| `prompt` | `input` | 直接作为 text 类型 input |
| `model` | `model` | 直接传递（若客户端未指定，使用配置的 defaultModel） |
| `size` | `response_format` | 解析为 aspect_ratio + image_size |
| `n` | — | 忽略（Nano Banana 每次生成 1 张） |
| `response_format` | — | 决定返回 url 还是 b64_json |

**size 到 aspect_ratio 转换规则：**

| OpenAI size | aspect_ratio | image_size |
|---|---|---|
| `1024x1024` | `1:1` | `1K` |
| `1792x1024` | `16:9` | `2K` |
| `1024x1792` | `9:16` | `2K` |
| `512x512` | `1:1` | `0.5K` |
| `256x256` | `1:1` | `0.5K` |

对于非标准尺寸，计算宽高比并取最接近的支持比例。

**响应转换：**

Nano Banana 响应结构（简化）：
```json
{
  "id": "interaction_xxx",
  "steps": [
    {
      "type": "model_output",
      "content": [
        {"type": "image", "data": "base64...", "mime_type": "image/png"}
      ]
    }
  ],
  "output_image": {"data": "base64...", "mime_type": "image/png"}
}
```

转换为 OpenAI 格式：
```json
{
  "created": 1234567890,
  "data": [
    {
      "b64_json": "base64...",
      "revised_prompt": "..."
    }
  ]
}
```

当 `response_format` 为 `url` 时，将 base64 转为 data URL：`data:image/png;base64,...`

### 3. 模型列表端点

`GET /v1/models` 在当前启用配置为 `google-nano-banana` 类型时：
- 直接返回配置中的 models 列表
- 或代理转发到 `{baseUrl}/v1beta/models`（如果 Google 有对应端点）

### 4. 错误处理

- Google API 错误原样透传给客户端
- 401/403 时记录日志提示检查 API Key
- 超时使用现有配置（默认 5 分钟，大图像生成可能较慢）

### 5. 日志记录

复用现有日志系统，记录：
- 请求路径：`/v1beta/interactions` 或 `/v1/images/generations`
- 使用的模型
- 请求耗时
- 响应状态码
- Token 消耗（如果 Google API 返回）

## 修改文件清单

| 文件 | 改动说明 |
|---|---|
| `proxy/proxy-server.js` | 新增 `/v1beta/interactions` 路由 + OpenAI→Nano Banana 转换逻辑 |
| `src/pages/ProfileEdit/index.vue` | 下拉选项新增 `google-nano-banana` |
| `src/pages/Home/index.vue` | `providerLabel` 和 `providerColor` 新增映射 |
| `src/i18n/locales/zh-CN.json` | 新增 `google-nano-banana` 中文标签 |
| `src/i18n/locales/en-US.json` | 新增 `google-nano-banana` 英文标签 |

## 不涉及的部分

- Rust 层（`src-tauri/`）— profile 配置结构是通用 JSON，新增 providerType 无需 Rust 改动
- Model mapping / Load balancer — 不在本次范围内
- 代理自动编译 — proxy 修改后重启开发模式自动生效
