# AI API Switch — Tauri 客户端迁移设计文档

## 概述

将现有基于 uTools 插件的 AI API 代理/切换器迁移为独立的 Tauri 桌面客户端，去掉 uTools 依赖，支持 macOS / Windows / Linux 三平台。

## 关键决策

| 决策项 | 选择 | 理由 |
|---|---|---|
| 代理引擎 | Sidecar 模式（Node.js 打包为二进制） | 复用现有 ~1500 行协议转换代码，迁移成本最低 |
| 数据存储 | JSON 文件 | 简单直观，用户可手动编辑/备份 |
| UI 改造 | 最小改动 | 只替换 uTools API 调用为 Tauri invoke |
| 兼容性 | 只维护 Tauri 版 | 代码更干净，不维护两套 |
| 目标平台 | macOS / Windows / Linux | 三平台全覆盖 |

## 架构

```
┌─ Tauri Window ─────────────────────────────────┐
│  Vue 3 前端（现有页面，替换 utools 调用）        │
│  window.services.* → invoke('cmd', args)        │
└────────────┬───────────────────────────────────┘
             │ Tauri IPC (invoke / emit)
┌────────────▼───────────────────────────────────┐
│  Rust 后端                                      │
│  ├── config.rs    配置存储（JSON 文件读写）      │
│  ├── proxy.rs     Sidecar 管理（spawn/kill/IPC） │
│  ├── commands.rs  Tauri invoke 命令注册          │
│  └── 系统托盘、剪贴板、窗口生命周期              │
└────────────┬───────────────────────────────────┘
             │ stdin/stdout JSON Lines IPC
┌────────────▼───────────────────────────────────┐
│  Node.js Sidecar（proxy-server.js 编译二进制）   │
│  HTTP 代理 + 协议转换 + SSE 流式转换             │
│  监听 localhost:{port}                           │
└────────────────────────────────────────────────┘
        │           │           │
        ▼           ▼           ▼
   OpenAI Chat  OpenAI Resp  Anthropic
```

## 项目结构

```
ai-api-switch/
├── src/                          # Vue 3 前端
│   ├── api.js                    # Tauri invoke 封装（替代 window.services）
│   ├── App.vue                   # 路由改为应用内导航
│   ├── main.js
│   ├── main.css
│   └── pages/
│       ├── Home/index.vue        # 代理控制主页面
│       ├── ProfileEdit/index.vue # 提供商配置编辑
│       └── Settings/index.vue    # 设置页（含数据导入）
├── src-tauri/                    # Tauri Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── icons/                    # 应用图标
│   ├── capabilities/             # Tauri 权限配置
│   └── src/
│       ├── main.rs               # Tauri 入口 + 命令注册
│       ├── config.rs             # JSON 配置存储
│       ├── proxy.rs              # Sidecar 生命周期管理
│       └── commands.rs           # Tauri invoke 命令
├── proxy/                        # Node.js 代理（Sidecar）
│   ├── package.json
│   └── proxy-server.js           # 代理服务器（改 stdin/stdout IPC）
├── scripts/
│   └── build-proxy.sh            # Sidecar 编译脚本
├── package.json                  # 前端 + Tauri CLI 依赖
├── vite.config.js
└── index.html
```

## Rust 后端设计

### 配置存储（config.rs）

替代 `utools.db`，使用 JSON 文件存储在各平台标准应用数据目录：

- macOS: `~/Library/Application Support/ai-api-switch/`
- Windows: `%APPDATA%/ai-api-switch/`
- Linux: `~/.config/ai-api-switch/`

文件清单：

| 文件 | 内容 | 对应原 DB Key |
|---|---|---|
| `profiles.json` | `{ profiles: [...] }` | `config/profiles` |
| `settings.json` | `{ port, autoStart, logEnabled }` | `config/proxy-settings` |
| `active-profiles.json` | `{ ids: [...] }` | `config/active-profiles` |
| `models.json` | `{ models: [...] }` | `config/models` |
| `model-mappings.json` | `{ enabled, rules }` | `config/model-mappings` |
| `stats-snapshot.json` | 统计快照 | `config/stats-snapshot` |
| `logs.json` | 请求日志 | `config/request-logs` |

读写策略：每次 invoke 时 `fs::read_to_string` → `serde_json::from_str` → 修改 → `serde_json::to_string_pretty` → `fs::write`。数据量小（通常 < 1MB），无并发写入问题。

缺失文件时返回默认值（与现有 `config-store.js` 行为一致）。

### Sidecar 管理（proxy.rs）

管理 Node.js proxy sidecar 进程生命周期：

**启动流程（`start_proxy`）：**
1. 从 config.rs 读取 profiles、settings、models、model-mappings
2. `Command::new(sidecar_path)` spawn sidecar 进程
3. 通过 stdin 发送 `{"type":"init","config":{...}}`
4. 监听 stdout 等待 `{"type":"started","port":N}` 响应
5. 持续监听 stdout 处理 `{"type":"log","data":{...}}` 和 `{"type":"error",...}` 消息

**停止流程（`stop_proxy`）：**
1. 向 stdin 发送 `{"type":"shutdown"}`（可选）
2. 发送 SIGTERM（Unix）/ TerminateProcess（Windows）
3. 3 秒超时后 force kill

**热更新（`reload_proxy`）：**
1. 重新读取配置
2. 向 stdin 发送 `{"type":"reload","config":{...}}`

**崩溃检测：**
- 监听进程 exit 事件，非主动停止时通知前端

**IPC 协议（与现有 fork IPC 一致）：**

```
Rust → Sidecar (stdin):
  {"type":"init","config":{"profiles":[...],"settings":{...},"models":[...],"modelMappings":{...}}}
  {"type":"reload","config":{...}}

Sidecar → Rust (stdout):
  {"type":"started","port":9999}
  {"type":"log","data":{"timestamp":...,"endpoint":"...","statusCode":200,...}}
  {"type":"error","error":"EADDRINUSE","message":"..."}
```

### Tauri 命令（commands.rs）

前端 `invoke('cmd', args)` 调用的命令列表：

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `start_proxy` | — | `{ port, status }` | 启动 sidecar |
| `stop_proxy` | — | `void` | 停止 sidecar |
| `get_proxy_status` | — | `{ status, port }` | 查询状态 |
| `get_profiles` | — | `Profile[]` | 读 profiles.json |
| `add_profile` | `{ profile }` | `Profile` | 写入并返回（含生成 id） |
| `update_profile` | `{ id, updates }` | `Profile` | 部分更新 |
| `delete_profile` | `{ id }` | `void` | 删除 + 清理 active |
| `get_active_profiles` | — | `string[]` | 读 active-profiles.json |
| `set_active_profiles` | `{ ids }` | `void` | 写入 + reload |
| `toggle_profile` | `{ id, enabled }` | `void` | 增减 + reload |
| `reorder_profiles` | `{ ordered_ids }` | `void` | 重排序 |
| `get_settings` | — | `Settings` | 读 settings.json |
| `set_settings` | `{ settings }` | `Settings` | 写入 + reload |
| `get_models` | — | `string[]` | 读 models.json |
| `add_model` | `{ model_id }` | `string[]` | 添加 + reload |
| `remove_model` | `{ model_id }` | `string[]` | 删除 + reload |
| `get_model_mappings` | — | `ModelMappings` | 读 model-mappings.json |
| `set_model_mappings` | `{ mappings }` | `ModelMappings` | 写入 + reload |
| `get_stats` | — | `Stats` | 统计聚合 |
| `get_logs` | `{ limit }` | `LogEntry[]` | 日志查询 |
| `clear_logs` | — | `void` | 清日志 |
| `clear_all_data` | — | `void` | 清所有数据 |
| `clear_logs_bodies` | — | `void` | 清日志 body |
| `get_log_enabled` | — | `bool` | 读 logEnabled |
| `set_log_enabled` | `{ enabled }` | `void` | 写入 + reload |
| `copy_text` | `{ text }` | `void` | Tauri 剪贴板 API |
| `fetch_provider_models` | `{ profile }` | `string[]` | HTTP 请求（reqwest） |
| `import_data` | `{ json }` | `void` | 批量导入配置 |

## 前端改造

### api.js — Tauri invoke 封装

创建 `src/api.js`，暴露与现有 `window.services` 完全相同的接口：

```js
import { invoke } from '@tauri-apps/api/core'

export const api = {
  startProxy: () => invoke('start_proxy'),
  stopProxy: () => invoke('stop_proxy'),
  getProxyStatus: () => invoke('get_proxy_status'),
  getProfiles: () => invoke('get_profiles'),
  addProfile: (profile) => invoke('add_profile', { profile }),
  updateProfile: (id, updates) => invoke('update_profile', { id, updates }),
  deleteProfile: (id) => invoke('delete_profile', { id }),
  getActiveProfiles: () => invoke('get_active_profiles'),
  setActiveProfiles: (ids) => invoke('set_active_profiles', { ids }),
  toggleProfile: (id, enabled) => invoke('toggle_profile', { id, enabled }),
  reorderProfiles: (orderedIds) => invoke('reorder_profiles', { orderedIds }),
  getSettings: () => invoke('get_settings'),
  setSettings: (settings) => invoke('set_settings', { settings }),
  getModels: () => invoke('get_models'),
  addModel: (modelId) => invoke('add_model', { modelId }),
  removeModel: (modelId) => invoke('remove_model', { modelId }),
  getModelMappings: () => invoke('get_model_mappings'),
  setModelMappings: (mappings) => invoke('set_model_mappings', { mappings }),
  getStats: () => invoke('get_stats'),
  getLogs: (limit) => invoke('get_logs', { limit }),
  clearLogs: () => invoke('clear_logs'),
  clearAllData: () => invoke('clear_all_data'),
  clearLogsBodies: () => invoke('clear_logs_bodies'),
  getLogEnabled: () => invoke('get_log_enabled'),
  setLogEnabled: (enabled) => invoke('set_log_enabled', { enabled }),
  copyText: (text) => invoke('copy_text', { text }),
  fetchProviderModels: (profile) => invoke('fetch_provider_models', { profile }),
  onStatusChange: (fn) => {
    // 通过 Tauri event 监听 sidecar 状态变更
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('proxy-status-changed', (event) => fn(event.payload))
    })
  },
}
```

### 页面改动

每个页面组件中 `window.services.xxx()` → `api.xxx()`。改动是机械式搜索替换。

以 `Home/index.vue` 为例：
```diff
- const status = window.services.getProxyStatus()
+ const status = await api.getProxyStatus()
```

注意：现有代码中 `window.services` 调用是同步的（uTools preload 环境），Tauri invoke 是异步的（返回 Promise）。需要将相关调用改为 `await`。

### App.vue 路由改造

```diff
 onMounted(() => {
-  if (!window.utools) {
-    route.value = 'no-utools'
-    return
-  }
-  window.utools.onPluginEnter((action) => {
-    navigate(action.code, action.payload)
-    ...
-  })
+  navigate('gateway')
+  // autoStart 逻辑
+  api.getSettings().then(settings => {
+    if (settings.autoStart) {
+      api.startProxy().catch(() => {})
+    }
+  })
 })
```

窗口关闭时停止代理：
```js
import { getCurrentWindow } from '@tauri-apps/api/window'

getCurrentWindow().onCloseRequested(async () => {
  await api.stopProxy()
})
```

### 去掉的依赖

- `utools-api-types` devDependency → 删除
- `window.utools` 所有引用 → 删除
- `public/plugin.json` → 删除（Tauri 用 `tauri.conf.json`）
- `public/preload/` 目录 → 删除（职责移至 Rust + proxy/）

## Sidecar 打包

### 编译方案

使用 `bun build --compile` 将 proxy/ 目录编译为自包含可执行：

```bash
# macOS ARM
bun build --compile --target=bun-darwin-arm64 proxy-server.js --outfile proxy-server-aarch64-apple-darwin

# macOS Intel
bun build --compile --target=bun-darwin-x64 proxy-server.js --outfile proxy-server-x86_64-apple-darwin

# Windows
bun build --compile --target=bun-windows-x64 proxy-server.js --outfile proxy-server-x86_64-pc-windows-msvc.exe

# Linux
bun build --compile --target=bun-linux-x64 proxy-server.js --outfile proxy-server-x86_64-unknown-linux-gnu
```

输出放在 `src-tauri/binaries/` 下，Tauri 按平台自动选择。

### Sidecar 代码改动

`proxy-server.js` 本身基本不改。唯一的改动是 IPC 通信方式：

- 现有：`process.on('message', handler)` + `process.send(msg)`（Node.js IPC）
- 改为：`process.stdin` 读取 JSON Lines + `process.stdout.write` 写入

这是因为 Bun compile 后的二进制不支持 Node.js 的 IPC 通道，但 stdin/stdout 可用。

```diff
- process.on('message', (msg) => {
+ process.stdin.on('data', (chunk) => {
+   const msg = JSON.parse(chunk.toString())
    if (msg.type === 'init') { ... }
    if (msg.type === 'reload') { ... }
  })

- process.send({ type: 'started', port })
+ process.stdout.write(JSON.stringify({ type: 'started', port }) + '\n')
```

Sidecar 中不再需要 `config-store.js` 和 `proxy-manager.js`——配置由 Rust 通过 IPC 传入（存在 `currentConfig` 中），日志通过 stdout 发回 Rust 持久化。只需修改 `proxy-server.js` 的 IPC 通信方式。

## 应用生命周期

| 事件 | uTools 版本 | Tauri 版本 |
|---|---|---|
| 应用启动 | `onPluginEnter` | `setup()` → 加载配置 → autoStart |
| 窗口关闭 | `onPluginOut(isKill=false)` | `onCloseRequested` → 隐藏到托盘 |
| 应用退出 | `onPluginOut(isKill=true)` | 托盘退出菜单 → stop sidecar |
| Sidecar 崩溃 | `crashCallback` | 进程 exit 事件 → emit 到前端 |

## 系统托盘

- 图标显示代理状态（运行中/已停止，可通过不同颜色区分）
- 菜单项：
  - 打开主窗口
  - 启动/停止代理
  - 退出
- 窗口关闭时默认最小化到托盘

## 数据迁移

提供导入功能，不提供自动检测：

1. 用户在 Settings 页面点击「导入配置」
2. 粘贴从旧版 uTools 导出的 JSON 数据
3. 前端调用 `import_data` 命令，Rust 解析后写入各 JSON 文件

## 构建与发布

### 开发环境

```bash
npm install          # 前端依赖
cd proxy && npm install  # proxy 依赖
npm run tauri dev    # 启动开发模式
```

### 生产构建

```bash
# 1. 编译 sidecar（各平台）
npm run proxy:build

# 2. 构建 Tauri 应用
npm run tauri build
```

### GitHub Actions

Matrix 构建：macOS (arm64 + x64)、Windows (x64)、Linux (x64)。每个 runner 上用 bun 编译对应平台的 sidecar，再执行 `tauri build`。

## 保留的功能清单

迁移后保留所有现有功能：

- [x] 多提供商配置管理（CRUD）
- [x] 多配置同时启用
- [x] 配置拖拽排序
- [x] 协议转换（9 种 source × target 组合）
- [x] SSE 流式响应实时转换
- [x] 请求日志与统计面板
- [x] 模型列表管理
- [x] 模型映射
- [x] 一键复制代理地址
- [x] 端口自定义
- [x] 自动启动
- [x] 日志开关
- [x] Reasoning 内容转换

新增功能：

- [x] 系统托盘（状态显示 + 快捷操作）
- [x] 独立窗口（不依赖 uTools）
- [x] 跨平台支持（macOS / Windows / Linux）
- [x] 数据导入（从旧版迁移）
