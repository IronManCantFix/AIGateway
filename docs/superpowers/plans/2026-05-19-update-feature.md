# 应用更新功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页面添加应用更新功能，通过检测 GitHub release 的版本来提示用户更新。

**Architecture:** CI/CD 流程根据 git tag 注入版本号到 tauri.conf.json；Rust 层通过 reqwest 调用 GitHub API 获取最新 release 版本并比较；前端在设置页面显示版本信息和更新提示。

**Tech Stack:** Rust (reqwest, serde), Vue 3, GitHub Actions, GitHub REST API

---

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| Modify | `.github/workflows/rust.yml` | 从 git tag 注入版本号到 tauri.conf.json |
| Modify | `src-tauri/src/commands.rs` | 添加 UpdateInfo 结构体和 check_for_updates 命令 |
| Modify | `src-tauri/src/main.rs` | 注册新命令到 invoke_handler |
| Modify | `src/api.js` | 添加 checkForUpdates 前端 API |
| Modify | `src/pages/Settings/index.vue` | 添加更新检查 UI |

---

### Task 1: CI/CD 流程注入版本号

**Files:**
- Modify: `.github/workflows/rust.yml:83-84`

- [ ] **Step 1: 在 Build job 的 Build 步骤之前添加版本注入**

在 `.github/workflows/rust.yml` 中，`Build` 步骤之前添加版本注入步骤：

```yaml
      - name: Inject version from tag
        if: startsWith(github.ref, 'refs/tags/v')
        run: |
          VERSION=${GITHUB_REF#refs/tags/v}
          sed -i.bak "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json && rm -f src-tauri/tauri.conf.json.bak
          echo "Injected version: $VERSION"
```

放在 `npm run tauri build` 步骤之前。

- [ ] **Step 2: 验证 YAML 语法**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/rust.yml'))"
```

Expected: 无输出（无语法错误）

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rust.yml
git commit -m "ci: 从 git tag 注入版本号到 tauri.conf.json"
```

---

### Task 2: Rust 层添加更新检查命令

**Files:**
- Modify: `src-tauri/src/commands.rs:1-5` (添加结构体) 和 `src-tauri/src/commands.rs:299` (末尾添加命令)

- [ ] **Step 1: 添加 UpdateInfo 结构体**

在 `src-tauri/src/commands.rs` 顶部（`use` 语句之后、`AppState` 之前）添加：

```rust
#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub download_url: String,
}
```

- [ ] **Step 2: 添加版本比较函数和 check_for_updates 命令**

在 `src-tauri/src/commands.rs` 末尾添加：

```rust
fn compare_versions(current: &str, latest: &str) -> bool {
    let current_parts: Vec<u32> = current.split('.').filter_map(|s| s.parse().ok()).collect();
    let latest_parts: Vec<u32> = latest.split('.').filter_map(|s| s.parse().ok()).collect();
    for i in 0..3 {
        let c = current_parts.get(i).unwrap_or(&0);
        let l = latest_parts.get(i).unwrap_or(&0);
        if l > c { return true; }
        if l < c { return false; }
    }
    false
}

#[tauri::command]
pub async fn check_for_updates(app_handle: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app_handle.package_info().version.to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    let resp = client
        .get("https://api.github.com/repos/IronManCantFix/AIGateway/releases/latest")
        .header("User-Agent", "AIGateway")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回错误: {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("JSON解析失败: {}", e))?;

    let latest_version = body.get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();

    let download_url = body.get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if latest_version.is_empty() {
        return Err("无法获取最新版本号".to_string());
    }

    let has_update = compare_versions(&current_version, &latest_version);

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        download_url,
    })
}
```

- [ ] **Step 3: 验证 Rust 编译**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: 编译通过，无错误

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: 添加 check_for_updates Tauri 命令"
```

---

### Task 3: 注册新命令到 Tauri invoke_handler

**Files:**
- Modify: `src-tauri/src/main.rs:306`

- [ ] **Step 1: 注册 check_for_updates 命令**

在 `src-tauri/src/main.rs` 的 `invoke_handler` 列表末尾添加 `commands::check_for_updates`：

```rust
        .invoke_handler(tauri::generate_handler![
            // ... existing commands ...
            commands::fetch_provider_models,
            commands::check_for_updates,
        ])
```

- [ ] **Step 2: 验证 Rust 编译**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: 编译通过，无错误

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat: 注册 check_for_updates 命令"
```

---

### Task 4: 前端 API 层添加更新检查

**Files:**
- Modify: `src/api.js:50-51`

- [ ] **Step 1: 添加 checkForUpdates API**

在 `src/api.js` 的 `fetchProviderModels` 之后、`onStatusChange` 之前添加：

```javascript
  // --- Update check ---
  checkForUpdates: () => invoke('check_for_updates'),
```

- [ ] **Step 2: Commit**

```bash
git add src/api.js
git commit -m "feat: 添加 checkForUpdates 前端 API"
```

---

### Task 5: 设置页面添加更新检查 UI

**Files:**
- Modify: `src/pages/Settings/index.vue`

- [ ] **Step 1: 添加更新相关状态和函数**

在 `src/pages/Settings/index.vue` 的 `<script setup>` 中，在 `onMounted` 之前添加：

```javascript
const updateInfo = ref(null)
const checkingUpdate = ref(false)

async function checkForUpdates() {
  checkingUpdate.value = true
  try {
    updateInfo.value = await api.checkForUpdates()
  } catch (e) {
    console.error('检查更新失败:', e)
  } finally {
    checkingUpdate.value = false
  }
}

function openDownloadPage() {
  if (updateInfo.value?.downloadUrl) {
    window.open(updateInfo.value.downloadUrl, '_blank')
  }
}
```

- [ ] **Step 2: 修改 onMounted 添加自动检查更新**

将现有的 `onMounted` 修改为：

```javascript
onMounted(async () => { await loadSettings(); await loadStats(); checkForUpdates() })
```

- [ ] **Step 3: 添加更新提示 UI**

在 `<template>` 中，在 `<!-- 关于 -->` 之前添加：

```html
    <!-- 检查更新 -->
    <div class="card" v-if="updateInfo">
      <div class="card-body">
        <div class="update-section">
          <div class="update-info">
            <span class="current-version">当前版本: {{ updateInfo.currentVersion }}</span>
            <span class="latest-version" v-if="updateInfo.hasUpdate">最新版本: {{ updateInfo.latestVersion }}</span>
            <span class="up-to-date" v-else>已是最新版本</span>
          </div>
          <div class="update-actions">
            <button class="check-update-btn" @click="checkForUpdates" :disabled="checkingUpdate">
              {{ checkingUpdate ? '检查中...' : '检查更新' }}
            </button>
            <button class="download-btn" v-if="updateInfo.hasUpdate" @click="openDownloadPage">前往下载</button>
          </div>
        </div>
      </div>
    </div>
```

- [ ] **Step 4: 更新关于区域显示动态版本号**

将关于区域中的 `版本 1.0.0` 修改为动态版本号：

```html
    <div class="about">
      <p><strong>AIGateway</strong></p>
      <p>版本 {{ updateInfo?.currentVersion || '...' }}</p>
      <p>作者 Claude Code &amp; DeepSeek v4 Pro &amp; mimo-v2.5-pro</p>
      <p><a class="github-link" href="https://github.com/IronManCantFix/AIGateway" target="_blank"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg> GitHub</a></p>
    </div>
```

- [ ] **Step 5: 添加更新相关样式**

在 `<style scoped>` 的 `.about` 样式之前添加：

```css
.update-section { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.update-info { display: flex; flex-direction: column; gap: 4px; }
.current-version { font-size: 14px; color: #334155; font-weight: 500; }
.latest-version { font-size: 13px; color: #6366f1; font-weight: 600; }
.up-to-date { font-size: 13px; color: #22c55e; font-weight: 500; }
.update-actions { display: flex; gap: 8px; flex-shrink: 0; }
.check-update-btn { padding: 6px 14px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; font-size: 13px; color: #64748b; cursor: pointer; transition: all .15s; }
.check-update-btn:hover:not(:disabled) { background: #f1f5f9; }
.check-update-btn:disabled { opacity: .6; cursor: default; }
.download-btn { padding: 6px 14px; border: none; border-radius: 8px; background: #6366f1; font-size: 13px; color: #fff; font-weight: 500; cursor: pointer; transition: all .15s; }
.download-btn:hover { background: #4f46e5; }
```

- [ ] **Step 6: Commit**

```bash
git add src/pages/Settings/index.vue
git commit -m "feat: 设置页面添加更新检查功能"
```

---

### Task 6: 验证整体功能

- [ ] **Step 1: 启动开发模式验证编译**

```bash
npm run tauri dev
```

Expected: 应用正常启动，无编译错误

- [ ] **Step 2: 验证设置页面更新区域**

在浏览器中打开设置页面，确认：
- 版本号正确显示
- "检查更新"按钮可用
- 点击后能获取到 GitHub release 信息

- [ ] **Step 3: 最终 Commit**

```bash
git add -A
git commit -m "feat: 完成应用更新检查功能"
```
