# AIGateway 应用更新功能设计文档

## 概述

在设置页面添加应用更新功能，通过检测 GitHub release 的版本来提示用户更新。

## 需求

1. CI/CD 流程中根据 git tag 自动将版本号打包进程序
2. 设置页面底部显示当前版本号
3. 添加"检查更新"按钮，检测 GitHub release 最新版本
4. 版本不一致时跳转到 GitHub 下载页面

## 设计方案

### 1. 版本号管理

#### CI/CD 流程修改

在 `.github/workflows/rust.yml` 中添加版本号注入步骤：

```yaml
- name: Inject version from tag
  if: startsWith(github.ref, 'refs/tags/v')
  run: |
    VERSION=${GITHUB_REF#refs/tags/v}
    sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
```

#### Tauri 配置

`src-tauri/tauri.conf.json` 中的 `version` 字段将作为当前版本号：

```json
{
  "version": "1.0.0"
}
```

### 2. Rust 层实现

#### 新增依赖

在 `src-tauri/Cargo.toml` 中添加 `reqwest` 依赖：

```toml
[dependencies]
reqwest = { version = "0.12", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

#### 新增数据结构

在 `src-tauri/src/commands.rs` 中添加更新信息结构：

```rust
#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub download_url: String,
}
```

#### 新增 Tauri 命令

```rust
#[tauri::command]
pub async fn check_for_updates(app_handle: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app_handle.package_info().version.to_string();
    
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.github.com/repos/IronManCantFix/AIGateway/releases/latest")
        .header("User-Agent", "AIGateway")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    
    if !resp.status().is_success() {
        return Err(format!("请求失败: {}", resp.status()));
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
    
    let has_update = compare_versions(&current_version, &latest_version);
    
    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        download_url,
    })
}

fn compare_versions(current: &str, latest: &str) -> bool {
    let current_parts: Vec<u32> = current.split('.').filter_map(|s| s.parse().ok()).collect();
    let latest_parts: Vec<u32> = latest.split('.').filter_map(|s| s.parse().ok()).collect();
    
    for i in 0..3 {
        let c = current_parts.get(i).unwrap_or(&0);
        let l = latest_parts.get(i).unwrap_or(&0);
        if l > c {
            return true;
        } else if l < c {
            return false;
        }
    }
    false
}
```

### 3. 前端实现

#### API 层

在 `src/api.js` 中添加更新检查 API：

```javascript
// --- Update check ---
checkForUpdates: () => invoke('check_for_updates'),
```

#### 设置页面修改

在 `src/pages/Settings/index.vue` 中添加更新检查功能：

```vue
<script setup>
// 新增状态
const updateInfo = ref(null)
const checkingUpdate = ref(false)

// 检查更新
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

// 打开下载页面
function openDownloadPage() {
  if (updateInfo.value?.downloadUrl) {
    window.open(updateInfo.value.downloadUrl, '_blank')
  }
}

// 页面加载时自动检查更新
onMounted(async () => {
  await loadSettings()
  await loadStats()
  await checkForUpdates()
})
</script>

<template>
  <!-- 更新提示 -->
  <div class="card" v-if="updateInfo">
    <div class="card-body">
      <div class="update-section">
        <div class="update-info">
          <span class="current-version">当前版本: {{ updateInfo.currentVersion }}</span>
          <span class="latest-version" v-if="updateInfo.hasUpdate">
            最新版本: {{ updateInfo.latestVersion }}
          </span>
        </div>
        <div class="update-actions">
          <button
            class="check-update-btn"
            @click="checkForUpdates"
            :disabled="checkingUpdate"
          >
            {{ checkingUpdate ? '检查中...' : '检查更新' }}
          </button>
          <button
            class="download-btn"
            v-if="updateInfo.hasUpdate"
            @click="openDownloadPage"
          >
            前往下载
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 关于 -->
  <div class="about">
    <p><strong>AIGateway</strong></p>
    <p>版本 {{ updateInfo?.currentVersion || '1.0.0' }}</p>
    <p>作者 Claude Code &amp; DeepSeek v4 Pro &amp; mimo-v2.5-pro</p>
    <p><a class="github-link" href="https://github.com/IronManCantFix/AIGateway" target="_blank"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg> GitHub</a></p>
  </div>
</template>

<style scoped>
.update-section {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.update-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.current-version {
  font-size: 14px;
  color: #334155;
  font-weight: 500;
}

.latest-version {
  font-size: 13px;
  color: #6366f1;
  font-weight: 600;
}

.update-actions {
  display: flex;
  gap: 8px;
}

.check-update-btn {
  padding: 8px 16px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  font-size: 13px;
  color: #64748b;
  cursor: pointer;
  transition: all .15s;
}

.check-update-btn:hover:not(:disabled) {
  background: #f1f5f9;
}

.check-update-btn:disabled {
  opacity: .6;
  cursor: default;
}

.download-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  background: #6366f1;
  font-size: 13px;
  color: #fff;
  font-weight: 500;
  cursor: pointer;
  transition: all .15s;
}

.download-btn:hover {
  background: #4f46e5;
}
</style>
```

### 4. 错误处理

- 网络请求失败：显示错误提示，允许重试
- JSON 解析失败：显示错误提示
- 版本号格式错误：显示错误提示

### 5. 测试计划

1. **CI/CD 测试**：
   - 推送 tag，验证版本号是否正确注入
   - 检查构建产物中的版本号

2. **功能测试**：
   - 打开设置页面，验证版本号显示
   - 点击"检查更新"按钮，验证更新检查功能
   - 有更新时，验证下载链接跳转

3. **错误处理测试**：
   - 网络断开时，验证错误提示
   - GitHub API 返回错误时，验证错误提示

## 实现步骤

1. 修改 CI/CD 流程，注入版本号
2. 在 Rust 层实现更新检查功能
3. 在前端实现更新检查 UI
4. 测试和验证

## 注意事项

1. 版本号格式必须是语义化版本号 (semver)
2. GitHub API 有请求频率限制，需要处理
3. 需要处理网络超时和错误情况
4. 下载链接应该直接指向 GitHub release 页面
