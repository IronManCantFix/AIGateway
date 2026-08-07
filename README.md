# 🚀 AIGateway

[English](README_EN.md)

本地 AI API 统一代理网关 — 让所有 AI 工具共享一个入口，随意切换后端。

## 🤔 它解决什么问题？

你手上有好几个 AI 工具：Codex CLI、Cursor、CherryStudio、自己写的脚本……每个都直连不同的 API。当你想切换到另一个提供商时——比如从 OpenAI 换到 Anthropic，或者从官方 API 换到中转站——你得逐个修改每个工具的配置。更麻烦的是，有的工具只支持 OpenAI 格式，但你想用的提供商只提供 Anthropic 格式。

**AIGateway 坐在所有工具和所有 API 之间：**

```
┌─ Client ──────────────────────────────────────┐
│  curl · Claude Code · Continue · ChatGPT 等   │
│  统一请求: /v1/chat/completions               │
│  model: "claude-sonnet-4-20250514"            │
└────────────────────┬──────────────────────────┘
                     │ HTTP localhost:9999
┌────────────────────▼──────────────────────────┐
│  AIGateway                                    │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │  Model Router（配置驱动）                │  │
│  │  model ID → 匹配 Profile → 协议转换     │  │
│  │                                         │  │
│  │  claude-*   → Anthropic Messages API    │  │
│  │  gpt-*      → OpenAI Chat API           │  │
│  │  gemini-*   → Google Gemini API         │  │
│  │  deepseek-* → DeepSeek API              │  │
│  │  (任意 model ID，配置即路由)             │  │
│  └─────────────────────────────────────────┘  │
└────────────────────┬──────────────────────────┘
           ┌─────────┼─────────┬─────────┐
           ▼         ▼         ▼         ▼
       Anthropic   OpenAI    Google    DeepSeek
       Messages    Chat API  Gemini    API
```

- 📌 工具侧只认一个地址 `http://127.0.0.1:9999`，永远不用改
- 🔄 后端随意切换：在 GUI 里勾选/取消配置即可，工具无感
- 🔀 协议自动转换：用 OpenAI 格式的工具也能调 Anthropic，反过来也行
- 🎯 支持同时启用多个提供商，按模型名自动路由 — 请求中的模型名会按配置的先后顺序匹配提供商，命中即停

## ⚡ 快速开始

### 0️⃣ 下载安装

前往 [GitHub Releases](https://github.com/IronManCantFix/AIGateway/releases) 页面下载对应平台的安装包：

| 平台 | 安装包 |
|---|---|
| macOS | `.dmg`（aarch64 / x86_64） |
| Windows | `.msi` 或 `.exe` |
| Linux | `.deb` 或 `.rpm` |

#### macOS 安装说明

本应用未签名，macOS 的 Gatekeeper 会阻止直接打开。安装后需要手动解除隔离属性：

```bash
# 挂载 dmg 后，将 AIGateway.app 拖入「应用程序」文件夹，然后执行：
sudo xattr -r -d com.apple.quarantine /Applications/AIGateway.app
```


> 未执行上述步骤直接双击打开，会提示"Apple 无法验证此 App"而无法运行。

### 1️⃣ 配置并使用

启动应用后，在主界面添加一条提供商配置：

| 字段 | 示例 | 说明 |
|---|---|---|
| 名称 | `My OpenAI` | 随意命名 |
| 类型 | `openai-chat` | 提供商接口类型 |
| Base URL | `https://api.openai.com` | 不含路径 |
| API Key | `sk-...` | 你的密钥 |
| 默认模型 | `gpt-4o` | 未指定模型时使用 |
| 可用模型 | `gpt-4o`, `gpt-4o-mini` | 该提供商支持的模型列表，用于模型路由匹配和对外暴露可用模型 |

添加可用模型后，首页会展示当前所有可用模型，客户端也可通过 `GET /v1/models` 接口获取模型 ID 列表（OpenAI 兼容格式）。

勾选启用，点击「启动」代理。然后把你的工具指向 `http://127.0.0.1:9999` 即可。

![2.png](images/2.png)

### 2️⃣ 在 Codex CLI或桌面端 中使用

[Codex CLI](https://github.com/openai/codex) 原生支持 OpenAI API，只需设置环境变量指向 AIGateway 代理地址

config.toml文件
```bash
model_provider = "aigateway"
model_override = true

[model_providers.aigateway]
provider_type = "openai"
name = "aigateway"
base_url = "http://127.0.0.1:9999/v1"
wire_api = "responses"
```

模型映射，将GPT-5.4-mini、GPT-5.5、GPT-5.4、GPT-5.3映射成你指定的模型

这样 Codex 的所有请求都经过 AIGateway 代理。当你切换后端提供商时，Codex 完全无感——它看到的始终是 OpenAI 格式的响应。

### 3️⃣ 其他客户端

任何支持自定义 API Base URL 的工具都能接入：

| 工具 | 设置方式 |
|---|---|
| **Cursor** | Settings → OpenAI API Key & Base URL |
| **CherryStudio** | 设置中填入代理地址 |
| **任意 HTTP 客户端** | 请求 `http://127.0.0.1:9999/v1/chat/completions` |

支持的代理接口（`/v1` 前缀可选，`/chat/completions` 和 `/v1/chat/completions` 均可）：

| 接口 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions 格式 |
| `POST /v1/responses` | OpenAI Responses 格式 |
| `POST /v1/messages` | Anthropic Messages 格式 |
| `POST /v1/images/generations` | OpenAI 图像生成格式 |
| `POST /v1/images/edits` | OpenAI 图像编辑格式 |
| `GET /v1/models` | 全局模型列表（OpenAI 兼容格式） |

### 📎 系统托盘

关闭窗口时应用最小化到系统托盘。右键托盘图标可以快速启动/停止代理或退出应用。
![1.png](images/1.png)

## 📊 日志与统计

设置页面提供多维度的请求统计和日志查看功能。

### 总览

顶部展示三个核心指标：**总请求数**、**Token 消耗**（Prompt / Completion 明细）、**日均请求**。

![6.png](images/6.png)

### 趋势分析

- **全年热力图** — 按天聚合，GitHub 风格热力图，支持切换「请求数」和「Token」两种视图
- **30 天趋势** — 双轴折线图，同时展示请求数和 Token 消耗走势，悬停查看每日明细

### 分维度统计

- **提供商统计** — 按提供商分组，展示各提供商的请求次数、Token 消耗量，展开查看各模型的调用明细
- **模型统计** — 按模型分组，展示每个模型的调用次数和 Token 用量（Prompt / Completion / Total）

### 请求日志

日志页记录每一次代理请求，支持：

- 按**提供商**、**模型**、**状态码**（2xx 成功 / 4xx 客户端错误 / 5xx 服务端错误）、**日期范围**筛选
- 提供商和模型下拉项来自已配置的提供商；选中某提供商后，模型下拉只显示该提供商的模型（联动过滤）
- **筛选与分页均在后端完成**：每次只取当前页的数据，不会一次性加载全部日志，避免 logEnabled 开启时大日志拖慢前端
- 分页浏览（每页 5 / 10 / 20 / 50 条），底部显示 `共 X 条 / 第 Y / Z 页`
- 每条日志显示：状态码、HTTP 方法、接口类型、上游请求地址、提供商、模型、耗时、Token 用量（P / C / T）
- 通过代理发出的请求会显示蓝色 `PROXY` 标签
- 经过模型映射的请求会显示 `原始模型 → 映射后模型 | 提供商`
- **404 路由未匹配请求**会额外记录：HTTP 方法、从请求体提取的 model、完整的请求/响应体（无需开启调试日志），便于排查客户端发错地址或参数

![7.png](images/7.png)

### 调试日志

在设置中开启「记录请求参数与返回参数」后，每条日志会额外记录完整的请求体和响应体：

1. 进入设置页面，勾选「记录请求参数与返回参数」— 立即生效，无需重启代理
2. 在日志列表中展开「查看参数」，可查看完整的 JSON 请求/响应内容
3. 点击「复制」按钮可快速复制参数用于排查

> ⚠️ 开启调试日志会增加存储占用。可通过「清空参数」按钮清除已记录的请求/响应体（保留统计计数），或「清除日志」删除全部日志。

### 开发者控制台

可通过以下方式打开内置开发者工具（DevTools）排查问题：

- **快捷键**：`Cmd+Shift+D`（macOS）/ `Ctrl+Shift+D`（Windows/Linux）— 任何时候可用，即使页面白屏
- **设置页面**：进入设置 → 关于区域 → 点击「开发者控制台」

## 🔄 模型映射

模型映射功能允许你将客户端请求的模型 ID 映射为真实模型 ID。适用于客户端固定模型名称但你没有该模型的场景。

### 典型用例

- **Codex 固定模型**：Codex 只能调用 `gpt5.5`，但你想使用 `gpt-4o`，可以配置映射规则 `gpt5.5` → `gpt-4o`
- **统一模型名称**：多个客户端使用不同的模型名称，可以通过映射统一到实际可用的模型

### 配置方式

1. 在首页找到「模型映射」配置卡片
2. 点击「+ 添加映射」按钮
3. 填写「请求模型」（客户端发送的模型名）和「实际模型」（要映射到的真实模型名）
4. 启用映射开关，保存配置

### 日志标记

经过模型映射的请求会在日志中显示 `原始模型 → 映射后模型`，方便追踪映射效果。

## ⚖️ 负载均衡

当多个提供商提供相同模型时，可以配置负载均衡策略来优化请求分配和提高可用性。

### 负载均衡策略

| 策略 | 说明 |
|---|---|
| **轮询（Round Robin）** | 请求轮流分配到各个提供商，均匀分担负载 |
| **故障转移（Failover）** | 按顺序尝试提供商，失败自动切换到下一个，确保高可用 |

### 配置方式

1. 在首页找到「负载均衡」配置卡片
2. 点击「+ 创建负载均衡组」按钮
3. 填写组名称（如「GPT-4o 双线」）
4. 选择策略（轮询或故障转移）
5. 选择参与的提供商（至少需要 2 个）
6. 保存配置

### 使用场景

- **多账号轮询**：多个 OpenAI 账号提供相同模型，轮询分配请求避免单账号限流
- **主备切换**：主提供商故障时自动切换到备用提供商，确保服务连续性
- **跨区域容灾**：不同区域的提供商互为备份，提高可用性

## 🌐 HTTP 代理

当你的网络环境需要通过代理服务器才能访问上游 API 时，可以配置 HTTP 代理。所有代理请求都会通过你指定的 HTTP/HTTPS/SOCKS5 代理服务器转发。

### 配置方式

1. 打开设置页面，找到「HTTP 代理」配置卡片
2. 启用代理开关，填写代理地址（如 `http://127.0.0.1:7890`）
3. 如需认证，填写用户名和密码（可选）
4. 可选择排除特定提供商配置 — 被排除的配置其请求将不经过代理，直接连接上游

### 托盘快捷开关

系统托盘右键菜单中可快速开关 HTTP 代理，无需打开设置页面。切换后立即生效，无需重启代理。

### 日志标记

通过代理发出的请求会在日志中显示蓝色 `PROXY` 标签，方便识别哪些请求走了代理通道。

## 🏷️ 提供商类型

| providerType | 上游接口 | 典型用途 |
|---|---|---|
| `openai-chat` | `/v1/chat/completions` | OpenAI、中转站、大多数兼容 API |
| `openai-response` | `/v1/responses` | OpenAI Responses API |
| `openai-image` | `/v1/images/generations` `/v1/images/edits` | OpenAI 图像生成 API（gpt-image-2 等） |
| `anthropic-message` | `/v1/messages` | Anthropic Claude API |
| `google-gemini` | `/v1beta/openai/chat/completions` | Google Gemini API（OpenAI 兼容模式） |

## 🔧 协议转换矩阵

代理自动处理客户端请求格式与上游 API 格式之间的交叉转换：

| 客户端请求 | → openai-chat | → openai-response | → anthropic-message | → openai-image |
|---|---|---|---|---|
| `/v1/chat/completions` | 直接转发 | → `/v1/responses` | → `/v1/messages` | - |
| `/v1/responses` | → `/v1/chat/completions` | 直接转发 | → `/v1/messages` | - |
| `/v1/messages` | → `/v1/chat/completions` | → `/v1/responses` | 直接转发 | - |
| `/v1/images/generations` | - | - | - | 直接转发 |
| `/v1/images/edits` | - | - | - | 直接转发 |

SSE 流式响应也会实时转换。图像接口（`openai-image`）目前仅支持直连转发，不支持跨协议转换。

## ✅ 测试说明

### 已测试模型系列

| 系列 | 模型 | 提供商类型 | 流式 |
|------|------|-----------|------|
| GLM | GLM-5.1, GLM-4.7 | `openai-chat` | ✅ |
| MiniMax | MiniMax-M2.5, MiniMax-M2.7 | `openai-chat` | ✅ |
| MiMo | mimo-v2-pro, MiMo-2.5-pro | `openai-chat` | ✅ |
| DeepSeek | DeepSeek V4 Pro, DeepSeek V4 Flash | `openai-chat` | ✅ |
| GPT | gpt-5.4, gpt-5.4-mini, gpt-5.5 | `openai-chat` | ✅ |
| GPT Image | gpt-image-2 | `openai-image` | - |
| Claude | claude-opus-4-7, claude-sonnet-4-6, claude-opus-4-6 | `anthropic-message` | ✅ |
| Gemini | gemini-3.1-flash, gemini-3.1-flash-lite, gemini-3.1-pro | `google-gemini` | ✅ |

> 以上模型均通过代理的协议转换测试（如 OpenAI 格式客户端调用 Anthropic 格式提供商等）。

### 已测试客户端

| 客户端           | 提供商       | 协议                      | 结果 |
|---------------|-----------|-------------------------|---|
| Codex App     | MiMo      | `openai-responses`      | ✅ |
| Codex App     | DeepSeek  | `openai-responses`      | ✅ |
| Codex App     | GLM       | `openai-responses`      | ✅ |
| Codex App     | GPT       | `openai-responses`      | ✅ |
| Codex App     | MiniMax    | `openai-responses`      | ✅ |
| Cherry Studio | MiniMax   | `openai-chat、Anthropic` | ✅ |
| Cherry Studio | MiMo      | `openai-chat、Anthropic` | ✅ |
| Cherry Studio | DeepSeek  | `openai-chat、Anthropic` | ✅ |
| Cherry Studio | GLM       | `openai-chat、Anthropic` | ✅ |
| Cherry Studio | GPT       | `openai-chat、Anthropic` | ✅ |
| Cherry Studio | Claude    | `openai-chat、Anthropic` | ✅ |
| Cherry Studio | Gemini    | `openai-chat、Anthropic` | ✅ |
| Claude App    | GLM       | `Anthropic` | ✅ |
| Claude App    | MiMo      | `Anthropic` | ✅ |
| Claude App    | DeepSeek  | `Anthropic` | ✅ |
| Claude App    | MiniMax   | `Anthropic` | ✅ |
| Claude App    | GPT       | `Anthropic` | ✅ |
| Claude App    | Gemini    | `Anthropic` | ✅ |

目前基本上都是使用流式请求进行测试，有bug可以反馈。

> 欢迎提交 Issue 反馈其他模型或客户端的兼容性情况。

## 🛠️ 安装与开发

### 安装依赖

```bash
npm install
cd proxy && bun install && cd ..
```

### 开发模式

```bash
npm run tauri dev
```

> `tauri dev` 启动前会自动执行 `npm run proxy:build:current`，根据当前主机平台编译 Sidecar，无需手动操作。

### 生产构建

```bash
npm run proxy:build   # 编译 Sidecar（所有平台）
npm run tauri build   # 构建应用
```

也可以按平台单独构建 Sidecar：

```bash
npm run proxy:build:current      # 自动检测当前主机平台
npm run proxy:build:mac          # macOS (ARM + Intel)
npm run proxy:build:mac-arm      # 仅 macOS ARM (M 系列)
npm run proxy:build:mac-intel    # 仅 macOS Intel
npm run proxy:build:windows      # 仅 Windows x64
npm run proxy:build:linux        # 仅 Linux x64
```

### 生成应用图标

准备一张 1024x1024 的 PNG 图片，然后运行：

```bash
npx tauri icon <path-to-your-icon.png>
```

该命令会自动生成所有平台（macOS、Windows、Linux、iOS）所需的图标尺寸，输出到 `src-tauri/icons/` 目录。

## 📦 技术栈

- **前端**：Vue 3 + Vite
- **桌面框架**：Tauri 2.x（Rust 后端）
- **代理服务器**：Node.js 原生 `http` 模块（Sidecar 模式，bun compile 编译为独立二进制）
- **数据存储**：JSON 文件（平台标准应用数据目录）

## 📁 项目结构

```
aigateway/
├── src/                          # Vue 3 前端
│   ├── api.js                    # Tauri invoke 封装
│   ├── App.vue                   # 路由入口
│   └── pages/
│       ├── Home/                 # 主页
│       ├── ProfileEdit/          # 配置编辑
│       └── Settings/             # 设置
├── src-tauri/                    # Tauri Rust 后端
│   ├── src/
│   │   ├── main.rs               # 入口 + 命令注册 + 系统托盘
│   │   ├── config.rs             # JSON 配置存储
│   │   ├── proxy.rs              # Sidecar 进程管理
│   │   └── commands.rs           # Tauri invoke 命令
│   ├── tauri.conf.json           # Tauri 配置
│   └── capabilities/             # 权限配置
├── proxy/                        # Node.js 代理 Sidecar
│   ├── proxy-server.js           # 代理服务器 + 协议转换
│   └── package.json
├── scripts/
│   └── build-proxy.sh            # Sidecar 多平台编译脚本
└── package.json
```

## 🙏 致谢

- 感谢 **DeepSeek V4 Pro** 模型的超高性价比，第一版（[utools 插件版](https://github.com/a471640241/ai-gateway-utools)）完全使用 DeepSeek V4 Pro 开发
- 感谢 **小米 Orbit 百万亿 Token 计划**，提供了免费的 Pro 月度套餐，本桌面版从 utools 版迁移而来，使用 MiMo-V2.5-Pro 开发
- 感谢 **Claude Code** 这么好用的开发工具，让开发效率大幅提升

## 📄 许可证

MIT
