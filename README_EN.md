# 🚀 AIGateway

[中文](README.md)

Local AI API unified proxy gateway — let all AI tools share one endpoint, switch backends freely.

## 🤔 What Problem Does It Solve?

You have multiple AI tools: Codex CLI, Cursor, CherryStudio, custom scripts... each connecting to different APIs. When you want to switch to another provider — say from OpenAI to Anthropic, or from the official API to a relay — you need to update each tool's config one by one. Worse, some tools only support OpenAI format, but the provider you want only offers Anthropic format.

**AIGateway sits between all tools and all APIs:**

```
┌─ Client ──────────────────────────────────────┐
│  curl · Claude Code · Continue · ChatGPT etc. │
│  Unified endpoint: /v1/chat/completions       │
│  model: "claude-sonnet-4-20250514"            │
└────────────────────┬──────────────────────────┘
                     │ HTTP localhost:9999
┌────────────────────▼──────────────────────────┐
│  AIGateway                                    │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │  Model Router (config-driven)           │  │
│  │  model ID → match Profile → convert     │  │
│  │                                         │  │
│  │  claude-*   → Anthropic Messages API    │  │
│  │  gpt-*      → OpenAI Chat API           │  │
│  │  gemini-*   → Google Gemini API         │  │
│  │  deepseek-* → DeepSeek API              │  │
│  │  (any model ID, just configure to route)│  │
│  └─────────────────────────────────────────┘  │
└────────────────────┬──────────────────────────┘
           ┌─────────┼─────────┬─────────┐
           ▼         ▼         ▼         ▼
       Anthropic   OpenAI    Google    DeepSeek
       Messages    Chat API  Gemini    API
```

- 📌 Tools only know one address `http://127.0.0.1:9999`, never need to change
- 🔄 Switch backends freely: enable/disable configs in the GUI, tools are unaware
- 🔀 Automatic protocol conversion: OpenAI-format tools can call Anthropic and vice versa
- 🎯 Support multiple providers simultaneously, auto-route by model name — matches providers in config order, stops at first match

## ⚡ Quick Start

### 0️⃣ Download & Install

Go to the [GitHub Releases](https://github.com/IronManCantFix/AIGateway/releases) page to download the installer for your platform:

| Platform | Installer |
|---|---|
| macOS | `.dmg` (aarch64 / x86_64) |
| Windows | `.msi` or `.exe` |
| Linux | `.deb` or `.rpm` |

#### macOS Installation Notes

This app is unsigned. macOS Gatekeeper will block direct opening. After installation, manually remove the quarantine attribute:

```bash
# After mounting the dmg, drag AIGateway.app to the Applications folder, then run:
sudo xattr -r -d com.apple.quarantine /Applications/AIGateway.app
```

> Without the above step, double-clicking will show "Apple cannot verify this App" and fail to run.

### 1️⃣ Configure & Use

After launching the app, add a provider configuration on the main page:

| Field | Example | Description |
|---|---|---|
| Name | `My OpenAI` | Any name you like |
| Type | `openai-chat` | Provider API type |
| Base URL | `https://api.openai.com` | Without path |
| API Key | `sk-...` | Your API key |
| Default Model | `gpt-4o` | Used when no model specified |
| Available Models | `gpt-4o`, `gpt-4o-mini` | Models supported by this provider, used for model routing and exposing available models |

After adding available models, the home page displays all currently available models. Clients can also get the model ID list via `GET /v1/models` (OpenAI-compatible format).

Enable the config, click "Start" proxy. Then point your tools to `http://127.0.0.1:9999`.

![2.png](images/2.png)
![1.png](images/1.png)

### 2️⃣ Use with Codex CLI or Desktop

[Codex CLI](https://github.com/openai/codex) natively supports OpenAI API. Just set the environment variable to point to the AIGateway proxy address.

config.toml file:
```bash
model_provider = "aigateway"
model_override = true

[model_providers.aigateway]
provider_type = "openai"
name = "aigateway"
base_url = "http://127.0.0.1:9999/v1"
wire_api = "responses"
```

Model mapping can transform GPT-5.4-mini, GPT-5.5, GPT-5.4, GPT-5.3 into your specified models.

This way, all Codex requests go through AIGateway. When you switch backend providers, Codex is completely unaware — it always sees OpenAI-format responses.

### 3️⃣ Other Clients

Any tool that supports custom API Base URL can connect:

| Tool | Setup |
|---|---|
| **Cursor** | Settings → OpenAI API Key & Base URL |
| **CherryStudio** | Enter proxy address in settings |
| **Any HTTP client** | Request `http://127.0.0.1:9999/v1/chat/completions` |

Supported proxy endpoints (`/v1` prefix optional, both `/chat/completions` and `/v1/chat/completions` work):

| Endpoint | Description |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions format |
| `POST /v1/responses` | OpenAI Responses format |
| `POST /v1/messages` | Anthropic Messages format |
| `GET /v1/models` | Global model list (OpenAI-compatible format) |

### 📠 System Tray

Closing the window minimizes the app to the system tray. Right-click the tray icon to quickly start/stop the proxy or quit the app.

## 📊 Logs & Statistics

The Settings page provides multi-dimensional request statistics and log viewing.

### Overview

The top section shows three core metrics: **Total Requests**, **Token Consumption** (Prompt / Completion breakdown), **Daily Average Requests**.

![3.png](images/3.png)

### Trend Analysis

- **Year Heatmap** — Aggregated by day, GitHub-style heatmap, supports switching between "Requests" and "Tokens" views
- **30-Day Trend** — Dual-axis line chart showing both request count and token consumption trends, hover for daily details

### Breakdown Statistics

- **Provider Statistics** — Grouped by provider, showing request counts and token consumption per provider, expand to see model-level details
- **Model Statistics** — Grouped by model, showing call counts and token usage per model (Prompt / Completion / Total)

### Request Logs

The log page records every proxy request, supporting:

- Filter by **provider**, **model**, **date range**
- Paginated browsing (5 / 10 / 20 / 50 per page)
- Each log shows: status code, endpoint type, upstream request URL, provider, model, duration, token usage (P / C / T)
- Requests through HTTP proxy show a blue `PROXY` badge
- Requests with model mapping show `original_model → mapped_model | provider`

### Debug Logging

Enable "Record request and response parameters" in settings to additionally log full request and response bodies:

1. Go to Settings page, check "Record request and response parameters" — takes effect immediately, no proxy restart needed
2. Expand "View Parameters" in the log list to see complete JSON request/response content
3. Click the "Copy" button to quickly copy parameters for debugging

> ⚠️ Enabling debug logging increases storage usage. Use the "Clear Parameters" button to clear recorded request/response bodies (preserving stats), or "Clear Logs" to delete all logs.

## 🌐 HTTP Proxy

When your network requires a proxy server to access upstream APIs, you can configure an HTTP proxy. All proxy requests will be forwarded through your specified HTTP/HTTPS/SOCKS5 proxy server.

### Configuration

1. Open the Settings page, find the "HTTP Proxy" configuration card
2. Enable the proxy toggle, enter the proxy address (e.g., `http://127.0.0.1:7890`)
3. If authentication is required, enter username and password (optional)
4. Optionally exclude specific provider configs — excluded providers' requests bypass the proxy and connect directly

### Tray Quick Toggle

The system tray right-click menu allows quick toggling of HTTP proxy without opening the Settings page. Changes take effect immediately, no proxy restart needed.

### Log Tags

Requests through the proxy show a blue `PROXY` badge in logs, making it easy to identify which requests used the proxy channel.

## 🏷️ Provider Types

| providerType | Upstream API | Typical Use |
|---|---|---|
| `openai-chat` | `/v1/chat/completions` | OpenAI, relays, most compatible APIs |
| `openai-response` | `/v1/responses` | OpenAI Responses API |
| `anthropic-message` | `/v1/messages` | Anthropic Claude API |

## 🔧 Protocol Conversion Matrix

The proxy automatically handles cross-conversion between client request formats and upstream API formats:

| Client Request | → openai-chat | → openai-response | → anthropic-message |
|---|---|---|---|
| `/v1/chat/completions` | Direct forward | → `/v1/responses` | → `/v1/messages` |
| `/v1/responses` | → `/v1/chat/completions` | Direct forward | → `/v1/messages` |
| `/v1/messages` | → `/v1/chat/completions` | → `/v1/responses` | Direct forward |

SSE streaming responses are also converted in real-time.

## ✅ Tested Clients

The following clients have been tested with Codex App, Cherry Studio, and Claude App:

| Client | Provider | Protocol | Result |
|---|---|---|---|
| Codex App | MiMo | `openai-responses` | ✅ |
| Codex App | DeepSeek | `openai-responses` | ✅ |
| Codex App | GLM | `openai-responses` | ✅ |
| Cherry Studio | MiniMax | `openai-chat, Anthropic` | ✅ |
| Cherry Studio | MiMo | `openai-chat, Anthropic` | ✅ |
| Cherry Studio | DeepSeek | `openai-chat, Anthropic` | ✅ |
| Cherry Studio | GLM | `openai-chat, Anthropic` | ✅ |
| Claude App | GLM | `Anthropic` | ✅ |
| Claude App | MiMo | `Anthropic` | ✅ |
| Claude App | DeepSeek | `Anthropic` | ✅ |
| Claude App | MiniMax | `Anthropic` | ✅ |

I haven't personally tested every AI tool on the market — only the tools and models I commonly use. I don't have access to international models for testing.
Currently, streaming requests are the primary focus. Non-streaming requests haven't been thoroughly tested. Feel free to report bugs.

> Issues reporting compatibility with other models or clients are welcome.

## 🛠️ Installation & Development

### Install Dependencies

```bash
npm install
cd proxy && bun install && cd ..
```

### Development Mode

```bash
# Compile Sidecar (first time)
mkdir -p src-tauri/binaries
cd proxy && bun build --compile proxy-server.js --outfile ../src-tauri/binaries/proxy-server && cd ..
TARGET=$(rustc -vV | grep host | cut -d' ' -f2)
ln -sf proxy-server "src-tauri/binaries/proxy-server-$TARGET"

# Start
npm run tauri dev
```

### Production Build

```bash
npm run proxy:build   # Compile Sidecar (all platforms)
npm run tauri build   # Build app
```

### Generate App Icon

Prepare a 1024x1024 PNG image, then run:

```bash
npx tauri icon <path-to-your-icon.png>
```

This command automatically generates all platform (macOS, Windows, Linux, iOS) icon sizes and outputs them to the `src-tauri/icons/` directory.

### When to Recompile the Proxy Server

The proxy server (`proxy/proxy-server.js`) is compiled by `bun compile` into a standalone binary (Sidecar), embedded in the app. Therefore, **you must recompile after modifying `proxy/proxy-server.js`** for changes to take effect.

Typical scenarios requiring recompilation:

- Modified protocol conversion logic (request/response body format conversion)
- Modified SSE stream converters
- Modified routing handlers (e.g., adding new API endpoints)
- Modified proxy forwarding logic

Scenarios NOT requiring recompilation:

- Only modified frontend code (`src/` directory Vue files) — `npm run tauri dev` auto hot-reloads
- Only modified Rust backend code (`src-tauri/src/`) — `npm run tauri dev` auto recompiles
- Only modified config files or README

**Recompile proxy for development (current platform):**

```bash
cd proxy && bun build --compile proxy-server.js --outfile ../src-tauri/binaries/proxy-server && cd ..
TARGET=$(rustc -vV | grep host | cut -d' ' -f2)
ln -sf proxy-server "src-tauri/binaries/proxy-server-$TARGET"
```

**Production build (all platforms):**

```bash
npm run proxy:build
```

After recompilation, restart the app for changes to take effect.

## 📦 Tech Stack

- **Frontend**: Vue 3 + Vite
- **Desktop Framework**: Tauri 2.x (Rust backend)
- **Proxy Server**: Node.js native `http` module (Sidecar mode, bun compile to standalone binary)
- **Data Storage**: JSON files (platform standard app data directory)

## 📁 Project Structure

```
aigateway/
├── src/                          # Vue 3 frontend
│   ├── api.js                    # Tauri invoke wrapper
│   ├── App.vue                   # Router entry
│   └── pages/
│       ├── Home/                 # Home page
│       ├── ProfileEdit/          # Config editor
│       └── Settings/             # Settings
├── src-tauri/                    # Tauri Rust backend
│   ├── src/
│   │   ├── main.rs               # Entry + command registration + system tray
│   │   ├── config.rs             # JSON config storage
│   │   ├── proxy.rs              # Sidecar process management
│   │   └── commands.rs           # Tauri invoke commands
│   ├── tauri.conf.json           # Tauri config
│   └── capabilities/             # Permission config
├── proxy/                        # Node.js proxy Sidecar
│   ├── proxy-server.js           # Proxy server + protocol conversion
│   └── package.json
├── scripts/
│   └── build-proxy.sh            # Sidecar multi-platform build script
└── package.json
```

## 🙏 Acknowledgments

- Thanks to **DeepSeek V4 Pro** for its incredible cost-effectiveness. The first version ([utools plugin](https://github.com/a471640241/ai-gateway-utools)) was entirely built with DeepSeek V4 Pro
- Thanks to **Xiaomi Orbit Hundred-Trillion Token Program** for providing a free Pro monthly plan. This desktop version was migrated from the utools version, developed with MiMo-V2.5-Pro
- Thanks to **Claude Code** for being such a great development tool, significantly boosting development efficiency

## 🗓️ Roadmap

- **Image API Compatibility** — Support cross-protocol image request conversion (OpenAI `image_url` ↔ Anthropic `image` format), allowing OpenAI-format clients to send images through Anthropic APIs and vice versa

## 📄 License

MIT
