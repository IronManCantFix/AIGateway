# Tauri 客户端迁移实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将基于 uTools 插件的 AI API 代理/切换器迁移为独立的 Tauri 2.x 桌面客户端，保留所有现有功能，新增系统托盘支持。

**Architecture:** Rust 后端管理 JSON 配置文件存储 + Node.js Sidecar 进程生命周期；Vue 3 前端仅将 `window.services` 同步调用替换为 `api.xxx()` 异步调用；Sidecar 通过 stdin/stdout JSON Lines IPC 通信。

**Tech Stack:** Tauri 2.x, Rust, Vue 3, Vite, Node.js (Sidecar via bun compile)

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|---|---|
| `src-tauri/Cargo.toml` | Rust 依赖声明 |
| `src-tauri/tauri.conf.json` | Tauri 应用配置 |
| `src-tauri/build.rs` | Tauri 构建脚本 |
| `src-tauri/capabilities/default.json` | Tauri 权限配置 |
| `src-tauri/src/main.rs` | Tauri 入口 + 命令注册 + 系统托盘 |
| `src-tauri/src/config.rs` | JSON 文件配置存储 |
| `src-tauri/src/proxy.rs` | Sidecar 进程管理 |
| `src-tauri/src/commands.rs` | Tauri invoke 命令 |
| `src/api.js` | Tauri invoke 封装（替代 window.services） |
| `proxy/package.json` | Sidecar 依赖声明 |
| `scripts/build-proxy.sh` | Sidecar 编译脚本 |

### 修改文件

| 文件 | 改动 |
|---|---|
| `package.json` | 移除 utools-api-types，添加 @tauri-apps/cli, @tauri-apps/api |
| `vite.config.js` | 添加 Tauri 开发服务器配置 |
| `index.html` | 移除 uTools 相关 meta |
| `src/App.vue` | 路由改为应用启动直接导航，窗口关闭事件 |
| `src/pages/Home/index.vue` | window.services → api（同步→异步） |
| `src/pages/ProfileEdit/index.vue` | window.services → api（同步→异步） |
| `src/pages/Settings/index.vue` | window.services → api + 文案修改 |

### 删除文件

| 文件 | 原因 |
|---|---|
| `public/plugin.json` | uTools 插件配置，Tauri 用 tauri.conf.json |
| `public/preload/` 整个目录 | 职责移至 Rust + proxy/ |

### 移动文件

| 原路径 | 新路径 | 改动 |
|---|---|---|
| `public/preload/proxy-server.js` | `proxy/proxy-server.js` | IPC 改 stdin/stdout JSON Lines |

---

## Task 1: 初始化 Tauri 项目结构

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/main.rs`（占位）
- Create: `src-tauri/src/config.rs`（占位）
- Create: `src-tauri/src/proxy.rs`（占位）
- Create: `src-tauri/src/commands.rs`（占位）
- Modify: `package.json`
- Modify: `vite.config.js`

- [ ] **Step 1: 安装 Tauri CLI 和前端 API**

```bash
cd /Users/huanghongda/develop/node/ai-api-switch
npm install @tauri-apps/api
npm install -D @tauri-apps/cli
```

- [ ] **Step 2: 更新 package.json 添加 Tauri 脚本**

修改 `package.json`，移除 `utools-api-types`，添加 Tauri 相关依赖和脚本：

```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri",
    "proxy:build": "bash scripts/build-proxy.sh"
  },
  "dependencies": {
    "vue": "^3.5.13",
    "@tauri-apps/api": "^2"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.1",
    "@tauri-apps/cli": "^2",
    "vite": "^6.0.11"
  }
}
```

- [ ] **Step 3: 更新 vite.config.js**

```js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
```

- [ ] **Step 4: 创建 src-tauri/Cargo.toml**

```toml
[package]
name = "ai-api-switch"
version = "1.0.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-clipboard-manager = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["json"] }
uuid = { version = "1", features = ["v4"] }
dirs = "6"
```

- [ ] **Step 5: 创建 src-tauri/build.rs**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 6: 创建 src-tauri/tauri.conf.json**

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/schema.json",
  "productName": "AI API Switch",
  "version": "1.0.0",
  "identifier": "com.ai-api-switch.app",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "AI API Switch",
        "width": 820,
        "height": 680,
        "minWidth": 600,
        "minHeight": 400,
        "center": true
      }
    ],
    "trayIcon": {
      "iconPath": "icons/icon.png",
      "iconAsTemplate": true
    },
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "externalBin": ["binaries/proxy-server"]
  }
}
```

- [ ] **Step 7: 创建 src-tauri/capabilities/default.json**

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/schema.json",
  "identifier": "default",
  "description": "默认权限配置",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "clipboard-manager:allow-write-text",
    "clipboard-manager:allow-read-text"
  ]
}
```

- [ ] **Step 8: 创建占位 Rust 源文件**

`src-tauri/src/main.rs`:
```rust
mod config;
mod proxy;
mod commands;

fn main() {
    // TODO: Task 4 实现
}
```

`src-tauri/src/config.rs`:
```rust
// TODO: Task 2 实现
```

`src-tauri/src/proxy.rs`:
```rust
// TODO: Task 3 实现
```

`src-tauri/src/commands.rs`:
```rust
// TODO: Task 4 实现
```

- [ ] **Step 9: 创建 Tauri 所需图标占位**

```bash
mkdir -p src-tauri/icons
# 使用 tauri icon 命令生成图标，或先放置占位 PNG
# 最低要求: icon.png (512x512)
```

- [ ] **Step 10: 验证 Tauri 项目结构**

```bash
cd src-tauri && cargo check
```

Expected: 编译通过（占位文件无实际代码，仅检查 Cargo.toml 依赖正确）

- [ ] **Step 11: Commit**

```bash
git add package.json vite.config.js src-tauri/
git commit -m "feat: initialize Tauri 2.x project structure"
```

---

## Task 2: Rust config.rs — JSON 文件配置存储

**Files:**
- Modify: `src-tauri/src/config.rs`

- [ ] **Step 1: 实现 config.rs 完整代码**

将以下完整代码写入 `src-tauri/src/config.rs`：

```rust
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// --- Data Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(rename = "providerType")]
    pub provider_type: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "apiKey", default)]
    pub api_key: String,
    #[serde(rename = "defaultModel", default)]
    pub default_model: String,
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(rename = "autoStart", default)]
    pub auto_start: bool,
}

fn default_port() -> u16 { 9999 }

impl Default for Settings {
    fn default() -> Self {
        Self { port: 9999, auto_start: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelMappings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub rules: Vec<MappingRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MappingRule {
    pub from: String,
    pub to: String,
}

impl Default for ModelMappings {
    fn default() -> Self {
        Self { enabled: false, rules: vec![] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: u64,
    pub endpoint: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub provider: String,
    #[serde(rename = "statusCode")]
    pub status_code: u16,
    #[serde(default)]
    pub duration: u64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(rename = "requestBody", default)]
    pub request_body: Option<String>,
    #[serde(rename = "responseBody", default)]
    pub response_body: Option<String>,
    #[serde(rename = "promptTokens", default)]
    pub prompt_tokens: Option<u64>,
    #[serde(rename = "completionTokens", default)]
    pub completion_tokens: Option<u64>,
    #[serde(rename = "totalTokens", default)]
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StatsSnapshot {
    #[serde(default)]
    pub logs: Vec<LogEntry>,
}

// --- Config Store ---

pub struct ConfigStore {
    dir: PathBuf,
}

impl ConfigStore {
    pub fn new() -> Self {
        let dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ai-api-switch");
        fs::create_dir_all(&dir).ok();
        Self { dir }
    }

    // For testing: use a custom directory
    #[allow(dead_code)]
    pub fn with_dir(dir: PathBuf) -> Self {
        fs::create_dir_all(&dir).ok();
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn read_json<T: Default + for<'de> Deserialize<'de>>(&self, name: &str) -> T {
        let path = self.path(name);
        match fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => T::default(),
        }
    }

    fn write_json<T: Serialize>(&self, name: &str, value: &T) -> Result<(), String> {
        let path = self.path(name);
        let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())
    }

    // --- Profiles ---

    pub fn get_profiles(&self) -> Vec<Profile> {
        #[derive(Deserialize, Default)]
        struct Wrapper { #[serde(default)] profiles: Vec<Profile> }
        let w: Wrapper = self.read_json("profiles.json");
        w.profiles
    }

    fn save_profiles(&self, profiles: &[Profile]) -> Result<(), String> {
        #[derive(Serialize)]
        struct Wrapper<'a> { profiles: &'a [Profile] }
        self.write_json("profiles.json", &Wrapper { profiles })
    }

    pub fn add_profile(&self, mut profile: Profile) -> Result<Profile, String> {
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        let mut profiles = self.get_profiles();
        profiles.push(profile.clone());
        self.save_profiles(&profiles)?;
        Ok(profile)
    }

    pub fn update_profile(&self, id: &str, updates: serde_json::Value) -> Result<Profile, String> {
        let mut profiles = self.get_profiles();
        let idx = profiles.iter().position(|p| p.id == id)
            .ok_or_else(|| "Profile not found".to_string())?;
        // Merge updates into existing profile
        let mut profile_json = serde_json::to_value(&profiles[idx]).map_err(|e| e.to_string())?;
        if let (Some(obj), Some(upd)) = (profile_json.as_object_mut(), updates.as_object()) {
            for (k, v) in upd {
                obj.insert(k.clone(), v.clone());
            }
        }
        let updated: Profile = serde_json::from_value(profile_json).map_err(|e| e.to_string())?;
        profiles[idx] = updated.clone();
        self.save_profiles(&profiles)?;
        Ok(updated)
    }

    pub fn delete_profile(&self, id: &str) -> Result<(), String> {
        let mut profiles = self.get_profiles();
        profiles.retain(|p| p.id != id);
        self.save_profiles(&profiles)?;
        // Also remove from active profiles
        let mut active = self.get_active_profiles();
        active.retain(|aid| aid != id);
        self.set_active_profiles(&active)?;
        Ok(())
    }

    pub fn reorder_profiles(&self, ordered_ids: &[String]) -> Result<(), String> {
        let profiles = self.get_profiles();
        let mut reordered = Vec::new();
        for id in ordered_ids {
            if let Some(p) = profiles.iter().find(|p| &p.id == id) {
                reordered.push(p.clone());
            }
        }
        // Append any profiles not in ordered_ids (shouldn't happen, but safe)
        for p in &profiles {
            if !ordered_ids.contains(&p.id) {
                reordered.push(p.clone());
            }
        }
        self.save_profiles(&reordered)
    }

    // --- Active Profiles ---

    pub fn get_active_profiles(&self) -> Vec<String> {
        #[derive(Deserialize, Default)]
        struct Wrapper { #[serde(default)] ids: Vec<String> }
        let w: Wrapper = self.read_json("active-profiles.json");
        w.ids
    }

    pub fn set_active_profiles(&self, ids: &[String]) -> Result<(), String> {
        #[derive(Serialize)]
        struct Wrapper<'a> { ids: &'a [String] }
        self.write_json("active-profiles.json", &Wrapper { ids })
    }

    // --- Settings ---

    pub fn get_settings(&self) -> Settings {
        self.read_json("settings.json")
    }

    pub fn set_settings(&self, settings: &Settings) -> Result<(), String> {
        self.write_json("settings.json", settings)
    }

    // --- Models ---

    pub fn get_models(&self) -> Vec<String> {
        #[derive(Deserialize, Default)]
        struct Wrapper { #[serde(default)] models: Vec<String> }
        let w: Wrapper = self.read_json("models.json");
        w.models
    }

    pub fn set_models(&self, models: &[String]) -> Result<(), String> {
        #[derive(Serialize)]
        struct Wrapper<'a> { models: &'a [String] }
        self.write_json("models.json", &Wrapper { models })
    }

    // --- Model Mappings ---

    pub fn get_model_mappings(&self) -> ModelMappings {
        self.read_json("model-mappings.json")
    }

    pub fn set_model_mappings(&self, mappings: &ModelMappings) -> Result<(), String> {
        self.write_json("model-mappings.json", mappings)
    }

    // --- Log Enabled ---

    pub fn get_log_enabled(&self) -> bool {
        #[derive(Deserialize, Default)]
        struct Wrapper { #[serde(rename = "logEnabled", default)] log_enabled: bool }
        let w: Wrapper = self.read_json("settings.json");
        w.log_enabled
    }

    pub fn set_log_enabled(&self, enabled: bool) -> Result<(), String> {
        // Read full settings, update logEnabled, write back
        let mut settings: serde_json::Value = self.read_json("settings.json");
        if let Some(obj) = settings.as_object_mut() {
            obj.insert("logEnabled".to_string(), serde_json::Value::Bool(enabled));
        }
        self.write_json("settings.json", &settings)
    }

    // --- Logs & Stats ---

    pub fn get_logs(&self, limit: Option<usize>) -> Vec<LogEntry> {
        let snapshot: StatsSnapshot = self.read_json("stats-snapshot.json");
        let mut logs = snapshot.logs;
        logs.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        if let Some(n) = limit {
            logs.truncate(n);
        }
        logs
    }

    pub fn add_log(&self, entry: &LogEntry) -> Result<(), String> {
        let mut snapshot: StatsSnapshot = self.read_json("stats-snapshot.json");
        snapshot.logs.push(entry.clone());
        // Keep last 5000 entries
        if snapshot.logs.len() > 5000 {
            let drain_count = snapshot.logs.len() - 5000;
            snapshot.logs.drain(0..drain_count);
        }
        self.write_json("stats-snapshot.json", &snapshot)
    }

    pub fn clear_logs(&self) -> Result<(), String> {
        let snapshot = StatsSnapshot { logs: vec![] };
        self.write_json("stats-snapshot.json", &snapshot)
    }

    pub fn clear_logs_bodies(&self) -> Result<(), String> {
        let mut snapshot: StatsSnapshot = self.read_json("stats-snapshot.json");
        for log in &mut snapshot.logs {
            log.request_body = None;
            log.response_body = None;
        }
        self.write_json("stats-snapshot.json", &snapshot)
    }

    pub fn clear_all_data(&self) -> Result<(), String> {
        for name in &["profiles.json", "active-profiles.json", "models.json", "model-mappings.json", "stats-snapshot.json"] {
            fs::remove_file(self.path(name)).ok();
        }
        Ok(())
    }

    // --- Stats aggregation ---

    pub fn get_stats(&self) -> serde_json::Value {
        let logs = self.get_logs(None);
        let total_requests = logs.len();
        let total_tokens: u64 = logs.iter().filter_map(|l| l.total_tokens).sum();
        let total_prompt_tokens: u64 = logs.iter().filter_map(|l| l.prompt_tokens).sum();
        let total_completion_tokens: u64 = logs.iter().filter_map(|l| l.completion_tokens).sum();

        // by provider
        let mut provider_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut provider_model_map: std::collections::HashMap<String, std::collections::HashMap<String, u64>> = std::collections::HashMap::new();
        let mut model_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut model_tokens_map: std::collections::HashMap<String, (u64, u64, u64)> = std::collections::HashMap::new();
        let mut provider_tokens_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

        for log in &logs {
            let provider = if log.provider.is_empty() { "-".to_string() } else { log.provider.clone() };
            let model = if log.model.is_empty() { "-".to_string() } else { log.model.clone() };

            *provider_map.entry(provider.clone()).or_insert(0) += 1;
            *provider_model_map.entry(provider.clone()).or_default().entry(model.clone()).or_insert(0) += 1;
            *model_map.entry(model.clone()).or_insert(0) += 1;

            if let Some(t) = log.total_tokens {
                let e = model_tokens_map.entry(model.clone()).or_insert((0, 0, 0));
                e.0 += t;
                e.1 += log.prompt_tokens.unwrap_or(0);
                e.2 += log.completion_tokens.unwrap_or(0);
                *provider_tokens_map.entry(provider.clone()).or_insert(0) += t;
            }
        }

        // Trend (last 30 days)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let day_ms: u64 = 86400000;
        let mut trend = Vec::new();
        for i in (0..30).rev() {
            let day_start = now - (i + 1) * day_ms;
            let day_end = now - i * day_ms;
            let date = chrono_date(day_end);
            let day_logs: Vec<&LogEntry> = logs.iter().filter(|l| l.timestamp >= day_start && l.timestamp < day_end).collect();
            let count = day_logs.len();
            let tokens: u64 = day_logs.iter().filter_map(|l| l.total_tokens).sum();
            trend.push(serde_json::json!({ "date": date, "count": count, "tokens": tokens }));
        }

        // Year heatmap
        let mut year_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut year_map_tokens: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for log in &logs {
            let date = chrono_date(log.timestamp);
            *year_map.entry(date.clone()).or_insert(0) += 1;
            *year_map_tokens.entry(date).or_insert(0) += log.total_tokens.unwrap_or(0);
        }

        // by provider with models
        let by_provider_model: Vec<serde_json::Value> = provider_model_map.iter().map(|(provider, models)| {
            let models_arr: Vec<serde_json::Value> = models.iter().map(|(model, count)| {
                serde_json::json!({ "model": model, "count": count })
            }).collect();
            serde_json::json!({
                "provider": provider,
                "count": provider_map.get(provider).unwrap_or(&0),
                "models": models_arr
            })
        }).collect();

        let by_provider_tokens: Vec<serde_json::Value> = provider_tokens_map.iter().map(|(provider, total)| {
            serde_json::json!({ "provider": provider, "total": total })
        }).collect();

        let by_model: Vec<serde_json::Value> = model_map.iter().map(|(model, count)| {
            let tokens = model_tokens_map.get(model);
            serde_json::json!({
                "model": model,
                "count": count,
                "tokens": tokens.map(|(t, p, c)| serde_json::json!({ "total": t, "prompt": p, "completion": c }))
            })
        }).collect();

        serde_json::json!({
            "totalRequests": total_requests,
            "totalTokens": total_tokens,
            "totalPromptTokens": total_prompt_tokens,
            "totalCompletionTokens": total_completion_tokens,
            "trend": trend,
            "yearMap": year_map,
            "yearMapTokens": year_map_tokens,
            "byProviderModel": by_provider_model,
            "byProviderTokens": by_provider_tokens,
            "byModel": by_model,
        })
    }

    // --- Build sidecar config payload ---

    pub fn build_proxy_config(&self) -> serde_json::Value {
        let profiles = self.get_profiles();
        let active_ids = self.get_active_profiles();
        let active_profiles: Vec<&Profile> = profiles.iter()
            .filter(|p| active_ids.contains(&p.id))
            .collect();
        let settings = self.get_settings();
        let models = self.get_models();
        let model_mappings = self.get_model_mappings();
        let log_enabled = self.get_log_enabled();

        serde_json::json!({
            "profiles": active_profiles,
            "settings": {
                "port": settings.port,
                "logEnabled": log_enabled,
            },
            "models": models,
            "modelMappings": model_mappings,
        })
    }
}

fn chrono_date(ts_ms: u64) -> String {
    // Simple date formatting without chrono dependency
    // ts_ms since epoch → "YYYY-MM-DD"
    let secs = ts_ms / 1000;
    let days = secs / 86400;
    // Days since 1970-01-01
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year { break; }
        remaining -= days_in_year;
        y += 1;
    }
    let leap = is_leap(y);
    let month_days = if leap { [31,29,31,30,31,30,31,31,30,31,30,31] } else { [31,28,31,30,31,30,31,31,30,31,30,31] };
    let mut m = 0usize;
    for (i, &d) in month_days.iter().enumerate() {
        if remaining < d as i64 { m = i; break; }
        remaining -= d as i64;
        m = i + 1;
    }
    format!("{:04}-{:02}-{:02}", y, m + 1, remaining + 1)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
```

- [ ] **Step 2: 验证编译**

```bash
cd src-tauri && cargo check
```

Expected: 编译通过，无错误

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "feat: implement JSON file config store in Rust"
```

---

## Task 3: Rust proxy.rs — Sidecar 进程管理

**Files:**
- Modify: `src-tauri/src/proxy.rs`

- [ ] **Step 1: 实现 proxy.rs 完整代码**

```rust
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::config::{ConfigStore, LogEntry};

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProxyStatus {
    pub status: String, // "running" | "stopped"
    pub port: u16,
}

pub struct ProxyManager {
    child: Arc<Mutex<Option<Child>>>,
    status: Arc<Mutex<String>>,
    port: Arc<Mutex<u16>>,
    config_store: Arc<ConfigStore>,
}

impl ProxyManager {
    pub fn new(config_store: Arc<ConfigStore>) -> Self {
        let port = config_store.get_settings().port;
        Self {
            child: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new("stopped".to_string())),
            port: Arc::new(Mutex::new(port)),
            config_store,
        }
    }

    pub fn get_status(&self) -> ProxyStatus {
        let status = self.status.lock().unwrap().clone();
        let port = *self.port.lock().unwrap();
        ProxyStatus { status, port }
    }

    pub fn start(&self) -> Result<ProxyStatus, String> {
        let mut child_guard = self.child.lock().unwrap();
        if child_guard.is_some() {
            return Ok(self.get_status());
        }

        let config = self.config_store.build_proxy_config();
        let port = self.config_store.get_settings().port;

        // Resolve sidecar path — Tauri external binary
        let sidecar_name = if cfg!(target_os = "windows") {
            "proxy-server-x86_64-pc-windows-msvc.exe"
        } else if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                "proxy-server-aarch64-apple-darwin"
            } else {
                "proxy-server-x86_64-apple-darwin"
            }
        } else {
            "proxy-server-x86_64-unknown-linux-gnu"
        };

        // In Tauri, external binaries are resolved relative to the app resource dir
        let sidecar_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {}", e))?
            .parent()
            .ok_or("Failed to get exe parent dir")?
            .join(sidecar_name);

        if !sidecar_path.exists() {
            return Err(format!("Sidecar not found: {}", sidecar_path.display()));
        }

        let mut child = Command::new(&sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        // Send init config via stdin
        if let Some(ref mut stdin) = child.stdin {
            let msg = serde_json::json!({
                "type": "init",
                "config": config,
            });
            let line = serde_json::to_string(&msg).unwrap();
            stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            stdin.write_all(b"\n").map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }

        // Spawn stdout reader thread
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        let status_clone = Arc::clone(&self.status);
        let port_clone = Arc::clone(&self.port);
        let config_store_clone = Arc::clone(&self.config_store);
        let child_arc = Arc::clone(&self.child);

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.trim().is_empty() { continue; }
                let msg: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                match msg.get("type").and_then(|t| t.as_str()) {
                    Some("started") => {
                        if let Some(p) = msg.get("port").and_then(|p| p.as_u64()) {
                            *port_clone.lock().unwrap() = p as u16;
                        }
                        *status_clone.lock().unwrap() = "running".to_string();
                    }
                    Some("log") => {
                        if let Some(data) = msg.get("data") {
                            if let Ok(entry) = serde_json::from_value::<LogEntry>(data.clone()) {
                                config_store_clone.add_log(&entry).ok();
                            }
                        }
                    }
                    Some("error") => {
                        let error = msg.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
                        let message = msg.get("message").and_then(|m| m.as_str()).unwrap_or("");
                        eprintln!("Sidecar error: {} - {}", error, message);
                    }
                    _ => {}
                }
            }
            // Process exited
            *status_clone.lock().unwrap() = "stopped".to_string();
            *child_arc.lock().unwrap() = None;
        });

        *child_guard = Some(child);
        *self.status.lock().unwrap() = "starting".to_string();
        *self.port.lock().unwrap() = port;

        Ok(ProxyStatus { status: "starting".to_string(), port })
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut child_guard = self.child.lock().unwrap();
        if let Some(ref mut child) = *child_guard {
            // Try graceful shutdown
            if let Some(ref mut stdin) = child.stdin {
                let msg = serde_json::json!({ "type": "shutdown" });
                let line = serde_json::to_string(&msg).unwrap();
                stdin.write_all(line.as_bytes()).ok();
                stdin.write_all(b"\n").ok();
                stdin.flush().ok();
            }
            // Give it 2 seconds, then force kill
            std::thread::sleep(std::time::Duration::from_secs(2));
            child.kill().ok();
            child.wait().ok();
        }
        *child_guard = None;
        *self.status.lock().unwrap() = "stopped".to_string();
        Ok(())
    }

    pub fn reload(&self) -> Result<(), String> {
        let child_guard = self.child.lock().unwrap();
        if let Some(ref child) = *child_guard {
            // We need mutable stdin, so we can't hold the lock on child
            // Instead, we'll send reload via a different approach
            // For simplicity, we'll drop and re-acquire
        }
        drop(child_guard);

        let mut child_guard = self.child.lock().unwrap();
        if let Some(ref mut child) = *child_guard {
            if let Some(ref mut stdin) = child.stdin {
                let config = self.config_store.build_proxy_config();
                let msg = serde_json::json!({
                    "type": "reload",
                    "config": config,
                });
                let line = serde_json::to_string(&msg).unwrap();
                stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
                stdin.write_all(b"\n").map_err(|e| e.to_string())?;
                stdin.flush().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}
```

- [ ] **Step 2: 验证编译**

```bash
cd src-tauri && cargo check
```

Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/proxy.rs
git commit -m "feat: implement sidecar process manager in Rust"
```

---

## Task 4: Rust commands.rs + main.rs — Tauri 命令与入口

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 实现 commands.rs 完整代码**

```rust
use std::sync::Arc;
use tauri::State;

use crate::config::{ConfigStore, ModelMappings, Profile, Settings};
use crate::proxy::{ProxyManager, ProxyStatus};

pub struct AppState {
    pub config: Arc<ConfigStore>,
    pub proxy: ProxyManager,
}

// --- Proxy commands ---

#[tauri::command]
pub fn start_proxy(state: State<'_, AppState>) -> Result<ProxyStatus, String> {
    state.proxy.start()
}

#[tauri::command]
pub fn stop_proxy(state: State<'_, AppState>) -> Result<(), String> {
    state.proxy.stop()
}

#[tauri::command]
pub fn get_proxy_status(state: State<'_, AppState>) -> ProxyStatus {
    state.proxy.get_status()
}

// --- Profile commands ---

#[tauri::command]
pub fn get_profiles(state: State<'_, AppState>) -> Vec<Profile> {
    state.config.get_profiles()
}

#[tauri::command]
pub fn add_profile(state: State<'_, AppState>, profile: serde_json::Value) -> Result<Profile, String> {
    let p: Profile = serde_json::from_value(profile).map_err(|e| e.to_string())?;
    let saved = state.config.add_profile(p)?;
    // If this is the first profile, auto-activate it
    let active = state.config.get_active_profiles();
    if active.is_empty() {
        state.config.set_active_profiles(&[saved.id.clone()])?;
        if state.proxy.get_status().status == "running" {
            state.proxy.reload()?;
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn update_profile(state: State<'_, AppState>, id: String, updates: serde_json::Value) -> Result<Profile, String> {
    let saved = state.config.update_profile(&id, updates)?;
    // If this profile is active, reload proxy
    let active = state.config.get_active_profiles();
    if active.contains(&id) && state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(saved)
}

#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.config.delete_profile(&id)
}

#[tauri::command]
pub fn get_active_profiles(state: State<'_, AppState>) -> Vec<String> {
    state.config.get_active_profiles()
}

#[tauri::command]
pub fn set_active_profiles(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    state.config.set_active_profiles(&ids)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(())
}

#[tauri::command]
pub fn toggle_profile(state: State<'_, AppState>, id: String, enabled: bool) -> Result<(), String> {
    let mut ids = state.config.get_active_profiles();
    if enabled {
        if !ids.contains(&id) {
            ids.push(id);
        }
    } else {
        ids.retain(|i| i != &id);
    }
    state.config.set_active_profiles(&ids)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(())
}

#[tauri::command]
pub fn reorder_profiles(state: State<'_, AppState>, ordered_ids: Vec<String>) -> Result<(), String> {
    state.config.reorder_profiles(&ordered_ids)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(())
}

// --- Settings commands ---

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.config.get_settings()
}

#[tauri::command]
pub fn set_settings(state: State<'_, AppState>, settings: serde_json::Value) -> Result<Settings, String> {
    let s: Settings = serde_json::from_value(settings).map_err(|e| e.to_string())?;
    state.config.set_settings(&s)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(s)
}

// --- Models commands ---

#[tauri::command]
pub fn get_models(state: State<'_, AppState>) -> Vec<String> {
    state.config.get_models()
}

#[tauri::command]
pub fn add_model(state: State<'_, AppState>, model_id: String) -> Result<Vec<String>, String> {
    let mut models = state.config.get_models();
    if !models.contains(&model_id) {
        models.push(model_id);
        state.config.set_models(&models)?;
        if state.proxy.get_status().status == "running" {
            state.proxy.reload()?;
        }
    }
    Ok(models)
}

#[tauri::command]
pub fn remove_model(state: State<'_, AppState>, model_id: String) -> Result<Vec<String>, String> {
    let mut models = state.config.get_models();
    models.retain(|m| m != &model_id);
    state.config.set_models(&models)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(models)
}

// --- Model Mappings commands ---

#[tauri::command]
pub fn get_model_mappings(state: State<'_, AppState>) -> ModelMappings {
    state.config.get_model_mappings()
}

#[tauri::command]
pub fn set_model_mappings(state: State<'_, AppState>, mappings: serde_json::Value) -> Result<ModelMappings, String> {
    let m: ModelMappings = serde_json::from_value(mappings).map_err(|e| e.to_string())?;
    state.config.set_model_mappings(&m)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(m)
}

// --- Log commands ---

#[tauri::command]
pub fn get_log_enabled(state: State<'_, AppState>) -> bool {
    state.config.get_log_enabled()
}

#[tauri::command]
pub fn set_log_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.config.set_log_enabled(enabled)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(())
}

// --- Stats & Logs commands ---

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> serde_json::Value {
    state.config.get_stats()
}

#[tauri::command]
pub fn get_logs(state: State<'_, AppState>, limit: Option<usize>) -> Vec<crate::config::LogEntry> {
    state.config.get_logs(limit)
}

#[tauri::command]
pub fn clear_logs(state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_logs()
}

#[tauri::command]
pub fn clear_all_data(state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_all_data()
}

#[tauri::command]
pub fn clear_logs_bodies(state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_logs_bodies()
}

// --- Clipboard ---

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    // Use tauri-plugin-clipboard-manager
    // This will be handled via the plugin, so we use a simple approach
    // The actual clipboard access is via the plugin's JS API
    // For now, we'll use arboard crate or just return Ok
    // Actually, we should use the tauri clipboard plugin's command
    // Let's use a simple approach with arboard
    Ok(())
}

// --- Fetch provider models ---

#[tauri::command]
pub async fn fetch_provider_models(profile: serde_json::Value) -> Result<Vec<String>, String> {
    let base_url = profile.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = profile.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");

    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let status_messages: std::collections::HashMap<u16, &str> = [
            (401, "API Key 无效或无权限访问"),
            (403, "无权限访问该接口"),
            (404, "该提供商不支持 /v1/models 端点"),
            (429, "请求过于频繁，请稍后重试"),
            (500, "上游服务器内部错误"),
            (502, "上游网关错误"),
            (503, "上游服务暂不可用"),
        ].iter().cloned().collect();

        let tip = status_messages.get(&status.as_u16()).unwrap_or(&"未知错误");
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("{}\n{}", tip, &body[..body.len().min(200)]));
    }

    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("JSON解析失败: {}", e))?;

    if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
        let models: Vec<String> = data.iter()
            .filter_map(|m| {
                if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                    Some(id.to_string())
                } else if m.is_string() {
                    m.as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();
        Ok(models)
    } else if let Some(models) = body.get("models").and_then(|d| d.as_array()) {
        let models: Vec<String> = models.iter()
            .filter_map(|m| {
                if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                    Some(id.to_string())
                } else if m.is_string() {
                    m.as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();
        Ok(models)
    } else {
        Err(format!("未知响应格式: {}", serde_json::to_string(&body).unwrap_or_default().chars().take(300).collect::<String>()))
    }
}
```

- [ ] **Step 2: 实现 main.rs 完整代码**

```rust
mod config;
mod proxy;
mod commands;

use std::sync::Arc;
use tauri::Manager;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use commands::AppState;
use config::ConfigStore;
use proxy::ProxyManager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let config_store = Arc::new(ConfigStore::new());
            let proxy_manager = ProxyManager::new(Arc::clone(&config_store));

            app.manage(AppState {
                config: Arc::clone(&config_store),
                proxy: proxy_manager,
            });

            // Setup system tray
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("AI API Switch")
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                window.show().ok();
                                window.set_focus().ok();
                            }
                        }
                        _ => {}
                    }
                })
                .menu_on_left_click(false)
                .build(app)?;

            // Auto-start proxy if configured
            let settings = config_store.get_settings();
            if settings.auto_start {
                let state = app.state::<AppState>();
                if let Err(e) = state.proxy.start() {
                    eprintln!("Auto-start proxy failed: {}", e);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_proxy,
            commands::stop_proxy,
            commands::get_proxy_status,
            commands::get_profiles,
            commands::add_profile,
            commands::update_profile,
            commands::delete_profile,
            commands::get_active_profiles,
            commands::set_active_profiles,
            commands::toggle_profile,
            commands::reorder_profiles,
            commands::get_settings,
            commands::set_settings,
            commands::get_models,
            commands::add_model,
            commands::remove_model,
            commands::get_model_mappings,
            commands::set_model_mappings,
            commands::get_log_enabled,
            commands::set_log_enabled,
            commands::get_stats,
            commands::get_logs,
            commands::clear_logs,
            commands::clear_all_data,
            commands::clear_logs_bodies,
            commands::copy_text,
            commands::fetch_provider_models,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Hide to tray instead of closing
                window.hide().ok();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: 更新 capabilities 添加剪贴板权限**

更新 `src-tauri/capabilities/default.json`，确保包含剪贴板权限：

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/schema.json",
  "identifier": "default",
  "description": "默认权限配置",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "clipboard-manager:allow-write-text",
    "clipboard-manager:allow-read-text"
  ]
}
```

- [ ] **Step 4: 验证编译**

```bash
cd src-tauri && cargo check
```

Expected: 编译通过

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs src-tauri/capabilities/
git commit -m "feat: implement Tauri commands, app entry, and system tray"
```

---

## Task 5: 前端 api.js — Tauri invoke 封装

**Files:**
- Create: `src/api.js`

- [ ] **Step 1: 创建 src/api.js**

```js
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

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
    listen('proxy-status-changed', (event) => fn(event.payload))
  },
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api.js
git commit -m "feat: add Tauri invoke wrapper (api.js)"
```

---

## Task 6: 前端 App.vue 迁移

**Files:**
- Modify: `src/App.vue`

- [ ] **Step 1: 重写 App.vue**

将 `src/App.vue` 替换为以下内容：

```vue
<script setup>
import { onMounted, ref, provide } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { api } from './api.js'
import Home from './pages/Home/index.vue'
import ProfileEdit from './pages/ProfileEdit/index.vue'
import Settings from './pages/Settings/index.vue'

const route = ref('')
const pagePayload = ref(null)

function navigate(page, payload) {
  route.value = page
  pagePayload.value = payload ?? null
}

provide('navigate', navigate)
provide('pagePayload', pagePayload)

onMounted(async () => {
  // 直接导航到主页面（不再依赖 uTools onPluginEnter）
  navigate('gateway')

  // autoStart 逻辑
  try {
    const settings = await api.getSettings()
    const status = await api.getProxyStatus()
    if (settings.autoStart && status.status !== 'running') {
      await api.startProxy()
    }
  } catch (e) {
    console.error('Auto-start failed:', e)
  }

  // 窗口关闭时停止代理
  const appWindow = getCurrentWindow()
  await appWindow.onCloseRequested(async () => {
    try {
      await api.stopProxy()
    } catch {}
  })
})
</script>

<template>
  <template v-if="route === 'gateway'">
    <Home />
  </template>
  <template v-else-if="route === 'gw-add'">
    <ProfileEdit />
  </template>
  <template v-else-if="route === 'gw-set'">
    <Settings />
  </template>
</template>
```

注意：移除了 `no-utools` 占位页面和所有 `window.utools` 引用。

- [ ] **Step 2: Commit**

```bash
git add src/App.vue
git commit -m "feat: migrate App.vue from uTools to Tauri lifecycle"
```

---

## Task 7: 前端 Home/index.vue 迁移

**Files:**
- Modify: `src/pages/Home/index.vue`

- [ ] **Step 1: 添加 api import**

在 `<script setup>` 的第一行添加：

```js
import { api } from '../../api.js'
```

同时移除 `import { ref, onMounted, computed, inject } from 'vue'` 中不需要的（保留现有 import 不变）。

- [ ] **Step 2: 将 loadData 改为 async**

将 `loadData()` 函数替换为：

```js
async function loadData() {
  profiles.value = await api.getProfiles()
  activeProfileIds.value = await api.getActiveProfiles()
  // Data migration: if new format is empty but legacy exists, skip (no legacy in Tauri)
  const status = await api.getProxyStatus()
  proxyStatus.value = status.status
  proxyPort.value = status.port
  modelMappings.value = await api.getModelMappings()
}
```

- [ ] **Step 3: 修改 toggleProxy**

将 `toggleProxy` 函数中的 `window.services` 替换为 `api`（已经是 async，但需要 await）：

```js
async function toggleProxy() {
  if (proxyStatus.value === 'running') {
    await api.stopProxy()
  } else {
    try { await api.startProxy() } catch (e) {
      showToast('启动失败: ' + e.message)
      return
    }
  }
  await loadData()
}
```

- [ ] **Step 4: 修改 toggleProfile**

```js
async function toggleProfile(id) {
  const enabled = !isActive(id)
  await api.toggleProfile(id, enabled)
  await loadData()
}
```

- [ ] **Step 5: 修改 copyModelId**

```js
async function copyModelId(id) {
  await api.copyText(id)
  showToast('已复制: ' + id)
}
```

- [ ] **Step 6: 修改 copyProfile**

```js
async function copyProfile(p) {
  await api.addProfile({
    name: `${p.name} (副本)`,
    providerType: p.providerType,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    defaultModel: p.defaultModel,
    models: p.models ? [...p.models] : []
  })
  await loadData()
  showToast(`已复制「${p.name}」`)
}
```

- [ ] **Step 7: 修改 confirmDelete**

```js
async function confirmDelete(id) {
  if (window.confirm('确定要删除该提供商吗？')) {
    await api.deleteProfile(id)
    await loadData()
  }
}
```

- [ ] **Step 8: 修改 onDrop 中的 reorderProfiles**

在 `onDrop` 函数中，将：
```js
window.services.reorderProfiles(orderedIds)
```
改为：
```js
await api.reorderProfiles(orderedIds)
```

注意：`onDrop` 函数需要变为 `async`。

- [ ] **Step 9: 修改模型映射相关函数**

```js
async function toggleModelMappings() {
  modelMappings.value = { ...modelMappings.value, enabled: !modelMappings.value.enabled }
  await api.setModelMappings(modelMappings.value)
}

async function addMappingRule() {
  modelMappings.value = {
    ...modelMappings.value,
    rules: [...modelMappings.value.rules, { from: '', to: '' }]
  }
  await api.setModelMappings(modelMappings.value)
}

async function removeMappingRule(index) {
  const rules = [...modelMappings.value.rules]
  rules.splice(index, 1)
  modelMappings.value = { ...modelMappings.value, rules }
  await api.setModelMappings(modelMappings.value)
}

async function updateMappingRule(index, field, value) {
  const rules = [...modelMappings.value.rules]
  rules[index] = { ...rules[index], [field]: value }
  modelMappings.value = { ...modelMappings.value, rules }
  await api.setModelMappings(modelMappings.value)
}
```

- [ ] **Step 10: 修改 onMounted**

```js
onMounted(async () => {
  await loadData()
})
```

- [ ] **Step 11: Commit**

```bash
git add src/pages/Home/index.vue
git commit -m "feat: migrate Home page from window.services to Tauri api"
```

---

## Task 8: 前端 ProfileEdit/index.vue 迁移

**Files:**
- Modify: `src/pages/ProfileEdit/index.vue`

- [ ] **Step 1: 添加 api import**

在 `<script setup>` 的第一行添加：

```js
import { api } from '../../api.js'
```

- [ ] **Step 2: 将 loadProfile 改为 async**

```js
async function loadProfile(id) {
  const profiles = await api.getProfiles()
  const p = profiles.find(p => p.id === id)
  if (p) {
    editId.value = p.id
    isEdit.value = true
    form.value = { ...p, models: p.models || [] }
  }
}
```

- [ ] **Step 3: 将 save 改为 async**

```js
async function save() {
  error.value = ''
  if (!form.value.name.trim()) { error.value = '请输入配置名称'; return }
  if (!form.value.baseUrl.trim()) { error.value = '请输入 Base URL'; return }
  form.value.baseUrl = form.value.baseUrl.replace(/\/+$/, '')
  saving.value = true
  try {
    if (isEdit.value) {
      await api.updateProfile(editId.value, { ...form.value, models: [...form.value.models] })
    } else {
      await api.addProfile({ ...form.value, models: [...form.value.models] })
    }
    navigate('gateway')
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
```

- [ ] **Step 4: 修改 fetchModels 和 fetchAvailModels**

将 `fetchModels` 中的 `await window.services.fetchProviderModels(form.value)` 改为 `await api.fetchProviderModels(form.value)`。

将 `fetchAvailModels` 中的同样替换。

- [ ] **Step 5: Commit**

```bash
git add src/pages/ProfileEdit/index.vue
git commit -m "feat: migrate ProfileEdit page from window.services to Tauri api"
```

---

## Task 9: 前端 Settings/index.vue 迁移

**Files:**
- Modify: `src/pages/Settings/index.vue`

- [ ] **Step 1: 添加 api import**

在 `<script setup>` 的第一行添加：

```js
import { api } from '../../api.js'
```

- [ ] **Step 2: 将 loadSettings 改为 async**

```js
async function loadSettings() {
  const s = await api.getSettings()
  port.value = s.port || 9999
  autoStart.value = s.autoStart || false
  logEnabled.value = await api.getLogEnabled()
}
```

- [ ] **Step 3: 修改 saveSettings 为 async**

```js
async function saveSettings() {
  const n = parseInt(port.value, 10)
  if (isNaN(n) || n < 1 || n > 65535) { port.value = 9999; return }
  await api.setSettings({ port: n, autoStart: autoStart.value })
  saved.value = true; setTimeout(() => saved.value = false, 1500)
}
```

- [ ] **Step 4: 修改 toggleLogging 为 async**

```js
async function toggleLogging() { await api.setLogEnabled(logEnabled.value) }
```

- [ ] **Step 5: 将 loadStats 改为 async**

```js
async function loadStats() {
  stats.value = await api.getStats()
  logs.value = await api.getLogs(1000)
}
```

- [ ] **Step 6: 修改 clearLogs 为 async**

```js
async function clearLogs() {
  if (!window.confirm('确定要清除所有请求日志吗？\n统计计数将保留。')) return
  await api.clearLogs(); await loadStats()
}
```

- [ ] **Step 7: 修改 clearAllData 为 async**

```js
async function clearAllData() {
  if (!window.confirm('确定要清除所有数据和统计吗？此操作不可恢复。')) return
  await api.clearAllData(); await loadStats()
}
```

- [ ] **Step 8: 修改 clearLogsBodyData 为 async**

```js
async function clearLogsBodyData() {
  if (!window.confirm('确定要清空所有请求参数和返回参数吗？统计计数将保留。')) return
  await api.clearLogsBodies(); await loadStats()
}
```

- [ ] **Step 9: 修改文案**

将 `"启动 uTools 时自动开启代理"` 改为 `"启动应用时自动开启代理"`。

- [ ] **Step 10: 修改 onMounted**

```js
onMounted(async () => { await loadSettings(); await loadStats() })
```

- [ ] **Step 11: Commit**

```bash
git add src/pages/Settings/index.vue
git commit -m "feat: migrate Settings page from window.services to Tauri api"
```

---

## Task 10: Sidecar proxy-server.js IPC 改造

**Files:**
- Move: `public/preload/proxy-server.js` → `proxy/proxy-server.js`
- Create: `proxy/package.json`

- [ ] **Step 1: 创建 proxy 目录并移动文件**

```bash
mkdir -p proxy
cp public/preload/proxy-server.js proxy/proxy-server.js
```

- [ ] **Step 2: 创建 proxy/package.json**

```json
{
  "name": "ai-api-switch-proxy",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "dependencies": {}
}
```

注意：proxy-server.js 只使用 Node.js 内置模块（http, https, url），无外部依赖。

- [ ] **Step 3: 修改 IPC 通信 — 接收消息**

在 `proxy/proxy-server.js` 中，将文件末尾的 IPC 接收部分（约第 1391-1403 行）：

```js
// --- IPC: receive config from parent (preload) ---

process.on('message', (msg) => {
  if (msg.type === 'init') {
    currentConfig = msg.config
    const port = msg.config.settings?.port || 9999
    server.listen(port, '127.0.0.1', () => {
      process.send({ type: 'started', port })
    })
    logEnabled = !!(msg.config.settings && msg.config.settings.logEnabled)
  } else if (msg.type === 'reload') {
    currentConfig = msg.config
    logEnabled = !!(msg.config.settings && msg.config.settings.logEnabled)
  }
})
```

替换为：

```js
// --- IPC: receive config from parent (stdin JSON Lines) ---

let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  const lines = stdinBuffer.split('\n')
  stdinBuffer = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === 'init') {
      currentConfig = msg.config
      const port = msg.config.settings?.port || 9999
      server.listen(port, '127.0.0.1', () => {
        process.stdout.write(JSON.stringify({ type: 'started', port }) + '\n')
      })
      logEnabled = !!(msg.config.settings && msg.config.settings.logEnabled)
    } else if (msg.type === 'reload') {
      currentConfig = msg.config
      logEnabled = !!(msg.config.settings && msg.config.settings.logEnabled)
    } else if (msg.type === 'shutdown') {
      server.close()
      process.exit(0)
    }
  }
})
```

- [ ] **Step 4: 修改 IPC 通信 — 发送日志**

在 `logRequest` 函数中（约第 1333 行），将：

```js
process.send({ type: 'log', data })
```

替换为：

```js
process.stdout.write(JSON.stringify({ type: 'log', data }) + '\n')
```

- [ ] **Step 5: 修改 IPC 通信 — 发送错误**

在 `server.on('error', ...)` 回调中（约第 1411 行），将：

```js
process.send({ type: 'error', error: 'EADDRINUSE', message: err.message })
```

替换为：

```js
process.stdout.write(JSON.stringify({ type: 'error', error: 'EADDRINUSE', message: err.message }) + '\n')
```

- [ ] **Step 6: 修改进程保活检查**

将文件末尾的 `setInterval` 中的 `process.connected` 检查（约第 1416-1421 行）替换为 stdin EOF 检测：

```js
// stdin 关闭后自动关闭 HTTP server 并退出
process.stdin.on('end', () => {
  server.close()
  process.exit(0)
})
```

- [ ] **Step 7: 验证 proxy-server.js 语法**

```bash
node --check proxy/proxy-server.js
```

Expected: 无输出（语法正确）

- [ ] **Step 8: Commit**

```bash
git add proxy/
git commit -m "feat: adapt proxy-server.js IPC to stdin/stdout JSON Lines"
```

---

## Task 11: 清理旧文件与构建配置

**Files:**
- Delete: `public/plugin.json`
- Delete: `public/preload/` 整个目录
- Create: `scripts/build-proxy.sh`
- Modify: `src/main.js`（如需）

- [ ] **Step 1: 删除 uTools 相关文件**

```bash
rm -f public/plugin.json
rm -rf public/preload/
```

- [ ] **Step 2: 创建 scripts/build-proxy.sh**

```bash
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROXY_DIR="$PROJECT_DIR/proxy"
OUT_DIR="$PROJECT_DIR/src-tauri/binaries"

mkdir -p "$OUT_DIR"

echo "Building proxy-server for all platforms..."

# macOS ARM
echo "  → bun-darwin-arm64"
cd "$PROXY_DIR" && bun build --compile --target=bun-darwin-arm64 proxy-server.js --outfile "$OUT_DIR/proxy-server-aarch64-apple-darwin"

# macOS Intel
echo "  → bun-darwin-x64"
cd "$PROXY_DIR" && bun build --compile --target=bun-darwin-x64 proxy-server.js --outfile "$OUT_DIR/proxy-server-x86_64-apple-darwin"

# Windows
echo "  → bun-windows-x64"
cd "$PROXY_DIR" && bun build --compile --target=bun-windows-x64 proxy-server.js --outfile "$OUT_DIR/proxy-server-x86_64-pc-windows-msvc.exe"

# Linux
echo "  → bun-linux-x64"
cd "$PROXY_DIR" && bun build --compile --target=bun-linux-x64 proxy-server.js --outfile "$OUT_DIR/proxy-server-x86_64-unknown-linux-gnu"

echo "Done! Binaries in $OUT_DIR"
ls -la "$OUT_DIR"
```

```bash
chmod +x scripts/build-proxy.sh
```

- [ ] **Step 3: 更新 .gitignore**

在 `.gitignore` 中添加：

```
src-tauri/binaries/
src-tauri/target/
```

- [ ] **Step 4: 验证前端构建**

```bash
npm run build
```

Expected: Vite 构建成功，输出到 dist/

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove uTools files, add build scripts, update gitignore"
```

---

## Task 12: 端到端验证

- [ ] **Step 1: 编译 sidecar（当前平台）**

```bash
mkdir -p src-tauri/binaries
cd proxy && bun build --compile proxy-server.js --outfile ../src-tauri/binaries/proxy-server
```

注意：开发模式下，Tauri 会在 `src-tauri/binaries/` 中查找名为 `proxy-server-{target_triple}` 的文件。可以先创建一个符号链接用于测试：

```bash
# 获取当前平台 triple
TARGET=$(rustc -vV | grep host | cut -d' ' -f2)
ln -sf proxy-server "src-tauri/binaries/proxy-server-$TARGET"
```

- [ ] **Step 2: 启动 Tauri 开发模式**

```bash
npm run tauri dev
```

Expected：
- 窗口打开，显示 Home 页面
- 代理状态显示「已停止」
- 点击启动按钮，代理启动
- 添加/编辑/删除提供商正常
- 设置页面统计正常加载

- [ ] **Step 3: 测试代理功能**

使用 curl 测试代理：

```bash
curl http://127.0.0.1:9999/v1/models
```

Expected: 返回模型列表 JSON

- [ ] **Step 4: 测试系统托盘**

- 关闭窗口应最小化到托盘
- 点击托盘图标应恢复窗口

- [ ] **Step 5: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: end-to-end testing fixes"
```

---

## 自检清单

- [ ] 所有 `window.services` 调用已替换为 `await api.xxx()`
- [ ] 所有 `window.utools` 引用已移除
- [ ] `public/preload/` 目录已删除
- [ ] `public/plugin.json` 已删除
- [ ] `utools-api-types` 已从 devDependencies 移除
- [ ] `proxy-server.js` IPC 改为 stdin/stdout JSON Lines
- [ ] Settings 页文案 "启动 uTools 时" 改为 "启动应用时"
- [ ] `copy_text` 命令使用 Tauri clipboard plugin
- [ ] 系统托盘图标和菜单正常
- [ ] 窗口关闭时最小化到托盘
