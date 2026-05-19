# HTTP 代理功能设计文档

**日期**: 2026-05-19
**状态**: 已确认
**作者**: Claude Code & mimo-v2.5-pro

## 背景

部分 AI 中转站需要翻墙才能访问，因此需要为代理服务器添加 HTTP 代理功能，让用户可以通过代理访问这些中转站。

## 需求概述

1. 在设置页的代理端口下方新增 HTTP 代理配置：
   - 开关（启用/禁用）
   - 代理地址
   - 账号密码（可选）
2. 所有提供商的 API 调用通过代理转发
3. 支持设置不需要代理的提供商列表
4. 托盘菜单可快速开启/关闭 HTTP 代理，与界面状态同步

## 数据结构设计

### Settings 结构体扩展

```rust
// config.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(rename = "autoStart", default)]
    pub auto_start: bool,
    #[serde(rename = "logEnabled", default)]
    pub log_enabled: bool,
    // 新增：HTTP 代理配置
    #[serde(rename = "httpProxy", default)]
    pub http_proxy: Option<HttpProxyConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpProxyConfig {
    pub enabled: bool,
    pub url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(rename = "excludeProfiles", default)]
    pub exclude_profiles: Vec<String>,
}
```

### 配置示例

```json
{
  "port": 9999,
  "autoStart": false,
  "logEnabled": false,
  "httpProxy": {
    "enabled": true,
    "url": "http://127.0.0.1:7890",
    "username": null,
    "password": null,
    "excludeProfiles": ["profile-id-1", "profile-id-2"]
  }
}
```

## 架构设计

### 1. 配置层 (config.rs)

**修改内容**：
- 扩展 `Settings` 结构体，添加 `http_proxy: Option<HttpProxyConfig>`
- 更新 `build_proxy_config()` 方法，将代理配置传给 sidecar

**传递给 sidecar 的配置格式**：
```json
{
  "profiles": [...],
  "settings": {
    "port": 9999,
    "logEnabled": false,
    "httpProxy": {
      "enabled": true,
      "url": "http://127.0.0.1:7890",
      "username": null,
      "password": null,
      "excludeProfiles": ["profile-id-1"]
    }
  },
  "models": [...],
  "modelMappings": {...}
}
```

### 2. Proxy 层 (proxy-server.js)

**依赖安装**：
```bash
npm install https-proxy-agent
```

**修改内容**：

修改 `forwardRequest()` 函数，支持代理：

```javascript
const { HttpProxyAgent } = require('http-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')

function forwardRequest(clientReq, clientRes, upstreamUrl, apiKey, body, 
                        sseConverter, onResponseBody, responseBodyConverter, 
                        sourceFormat, profileId) {
  const parsed = new URL(upstreamUrl)
  const isHttps = parsed.protocol === 'https:'
  const transport = isHttps ? https : http

  // 检查是否需要使用代理
  let agent = undefined
  const proxyConfig = currentConfig?.settings?.httpProxy
  if (proxyConfig?.enabled && proxyConfig?.url) {
    // 检查当前 profile 是否在排除列表中
    const isExcluded = proxyConfig.excludeProfiles?.includes(profileId)
    if (!isExcluded) {
      // 创建代理 agent
      const proxyUrl = new URL(proxyConfig.url)
      if (proxyConfig.username) {
        proxyUrl.username = proxyConfig.username
      }
      if (proxyConfig.password) {
        proxyUrl.password = proxyConfig.password
      }
      agent = isHttps 
        ? new HttpsProxyAgent(proxyUrl.toString())
        : new HttpProxyAgent(proxyUrl.toString())
    }
  }

  const bodyStr = JSON.stringify(body)
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: clientReq.method,
    agent,  // 添加 agent
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(bodyStr)
    }
  }

  // ... 其余代码不变
}
```

修改 `handleApiRequest()` 函数，传递 profileId：

```javascript
async function handleApiRequest(req, res) {
  // ... 现有代码

  // 找到 profile 后
  req._providerName = profile.name
  req._profileId = profile.id  // 新增

  // ... 调用 forwardRequest 时传递 profileId
  forwardRequest(req, res, upstreamUrl, profile.apiKey, body, sseConverter,
    req._onResponseBody || null,
    responseBodyConverter,
    sourceFormat,
    profile.id  // 新增参数
  )
}
```

### 3. UI 层 (Settings/index.vue)

**新增状态**：
```javascript
const httpProxyEnabled = ref(false)
const httpProxyUrl = ref('')
const httpProxyUsername = ref('')
const httpProxyPassword = ref('')
const httpProxyExcludeProfiles = ref([])
const showProxyAuth = ref(false)

// 从首页读取的提供商列表
const profiles = ref([])
```

**UI 布局**（在代理端口卡片下方）：

```vue
<!-- HTTP 代理 -->
<div class="card">
  <div class="card-header"><h3>HTTP 代理</h3></div>
  <div class="card-body">
    <label class="check-field">
      <input type="checkbox" v-model="httpProxyEnabled" @change="saveProxySettings" />
      <span>启用 HTTP 代理</span>
    </label>
    
    <div class="proxy-config" v-if="httpProxyEnabled">
      <div class="field-row">
        <label>代理地址</label>
        <input v-model="httpProxyUrl" placeholder="http://127.0.0.1:7890" @change="saveProxySettings" />
      </div>
      
      <div class="proxy-auth-toggle" @click="showProxyAuth = !showProxyAuth">
        {{ showProxyAuth ? '隐藏认证信息' : '显示认证信息（可选）' }}
      </div>
      
      <div class="proxy-auth" v-if="showProxyAuth">
        <div class="field-row">
          <label>用户名</label>
          <input v-model="httpProxyUsername" placeholder="可选" @change="saveProxySettings" />
        </div>
        <div class="field-row">
          <label>密码</label>
          <input v-model="httpProxyPassword" type="password" placeholder="可选" @change="saveProxySettings" />
        </div>
      </div>
      
      <div class="proxy-exclude">
        <label>不需要代理的提供商</label>
        <div class="exclude-list">
          <label v-for="p in profiles" :key="p.id" class="check-field">
            <input type="checkbox" 
              :value="p.id" 
              v-model="httpProxyExcludeProfiles" 
              @change="saveProxySettings" />
            <span>{{ p.name }}</span>
          </label>
        </div>
      </div>
    </div>
  </div>
</div>
```

**数据加载**：
```javascript
async function loadSettings() {
  const s = await api.getSettings()
  port.value = s.port || 9999
  autoStart.value = s.autoStart || false
  logEnabled.value = await api.getLogEnabled()
  
  // 加载代理配置
  if (s.httpProxy) {
    httpProxyEnabled.value = s.httpProxy.enabled || false
    httpProxyUrl.value = s.httpProxy.url || ''
    httpProxyUsername.value = s.httpProxy.username || ''
    httpProxyPassword.value = s.httpProxy.password || ''
    httpProxyExcludeProfiles.value = s.httpProxy.excludeProfiles || []
  }
}

async function loadProfiles() {
  profiles.value = await api.getProfiles()
}
```

**保存代理设置**：
```javascript
async function saveProxySettings() {
  const settings = {
    port: parseInt(port.value, 10),
    autoStart: autoStart.value,
    logEnabled: logEnabled.value,
    httpProxy: {
      enabled: httpProxyEnabled.value,
      url: httpProxyUrl.value,
      username: httpProxyUsername.value || null,
      password: httpProxyPassword.value || null,
      excludeProfiles: httpProxyExcludeProfiles.value
    }
  }
  await api.setSettings(settings)
}
```

### 4. 托盘菜单 (main.rs)

**菜单构建**：

在 `build_tray_menu()` 函数中添加 HTTP 代理开关：

```rust
fn build_tray_menu(app: &tauri::AppHandle, config_store: &ConfigStore, 
                   proxy_manager: &ProxyManager) -> tauri::menu::Menu<tauri::Wry> {
  // ... 现有代码

  let settings = config_store.get_settings();
  let http_proxy_enabled = settings.http_proxy
    .as_ref()
    .map(|p| p.enabled)
    .unwrap_or(false);

  // HTTP 代理开关
  let http_proxy_toggle = CheckMenuItemBuilder::with_id(
    "toggle_http_proxy", 
    "HTTP 代理"
  )
  .checked(http_proxy_enabled)
  .build(app)
  .unwrap();

  // ... 构建菜单
  let menu_builder = MenuBuilder::new(app)
    .item(&status_item)
    .item(&addr_item)
    .separator()
    .item(&proxy_toggle)
    .item(&autostart_toggle)
    .item(&http_proxy_toggle)  // 新增
    .separator()
    // ... 其余代码
}
```

**事件处理**：

在 `on_menu_event` 中添加处理：

```rust
match event_id {
  // ... 现有代码

  "toggle_http_proxy" => {
    let mut settings = state.config.get_settings();
    if let Some(ref mut proxy) = settings.http_proxy {
      proxy.enabled = !proxy.enabled;
    } else {
      settings.http_proxy = Some(HttpProxyConfig {
        enabled: true,
        url: String::new(),
        username: None,
        password: None,
        exclude_profiles: vec![],
      });
    }
    state.config.set_settings(&settings).ok();
    
    // 如果代理正在运行，重新加载配置
    if state.proxy.get_status().status == "running" {
      state.proxy.reload().ok();
    }
    
    // 重建菜单
    rebuild_tray_menu(app, &state);
    
    // 通知前端刷新
    app.emit("proxy-settings-changed", ()).ok();
  }

  // ... 其余代码
}
```

### 5. 命令层 (commands.rs)

**修改 `set_settings` 命令**：

```rust
#[tauri::command]
pub fn set_settings(state: State<'_, AppState>, settings: serde_json::Value) -> Result<Settings, String> {
  let s: Settings = serde_json::from_value(settings).map_err(|e| e.to_string())?;
  state.config.set_settings(&s)?;
  if state.proxy.get_status().status == "running" {
    state.proxy.reload()?;
  }
  // 通知托盘菜单更新
  // 注意：这里需要 app_handle，但当前命令没有
  // 可以通过 state 中的 app_handle 来 emit
  Ok(s)
}
```

**添加获取提供商列表的命令**（如果不存在）：

```rust
#[tauri::command]
pub fn get_all_profiles(state: State<'_, AppState>) -> Vec<Profile> {
  state.config.get_profiles()
}
```

## 同步机制

### UI → 托盘
1. 用户在 UI 修改代理设置
2. 调用 `api.setSettings()` → Rust `set_settings` 命令
3. 保存到 `settings.json`
4. 如果代理运行中，调用 `reload()`
5. emit `tray-menu-update` 事件
6. 托盘菜单重建，显示最新状态

### 托盘 → UI
1. 用户点击托盘菜单 "HTTP 代理"
2. 更新 `settings.json`
3. 如果代理运行中，调用 `reload()`
4. emit `proxy-settings-changed` 事件
5. UI 监听事件，刷新设置页面

## 测试方案

### 手动测试
1. 配置 HTTP 代理（如 Clash: http://127.0.0.1:7890）
2. 启用代理，验证请求是否通过代理
3. 设置排除提供商，验证该提供商不走代理
4. 测试托盘菜单开关同步
5. 测试账号密码认证

### 验证方法
- 使用代理工具（如 Clash）查看流量日志
- 检查请求是否经过代理服务器

## 依赖

- `https-proxy-agent`: Node.js HTTP/HTTPS 代理支持
- `http-proxy-agent`: Node.js HTTP 代理支持

## 风险与注意事项

1. **代理 URL 格式**：必须是完整的 URL，如 `http://127.0.0.1:7890`
2. **认证安全**：密码明文存储在 settings.json 中，用户需注意安全
3. **代理失败**：如果代理不可用，请求会超时或失败
4. **性能影响**：通过代理会增加网络延迟

## 设计决策

1. **使用 proxy-agent 库**：最成熟、最可靠的 Node.js 代理方案
2. **存储在 Settings 中**：保持配置集中，便于管理
3. **按提供商排除**：灵活控制哪些提供商走代理
4. **托盘菜单同步**：提供便捷的快速开关方式
