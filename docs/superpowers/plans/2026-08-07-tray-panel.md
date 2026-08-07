# 托盘面板窗口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用独立的紧凑面板窗口取代托盘列表菜单：左键托盘开/关面板，右键显示主窗口；面板展示运行状态、今日统计、最近模型与两个代理开关。

**Architecture:** Tauri 2 新增第二个无边框置顶小窗口 `panel`（加载 `index.html#/panel`），前端 `App.vue` 按 hash 分流渲染 `Panel` 组件；`tray.rs` 删除菜单构建，改为左键 toggle 面板、右键显示主窗口；`commands.rs` 新增 `quit_app` / `show_main_window` / `toggle_panel_window`；面板数据复用现有命令（`getProxyStatus` / `getStats` / `getLogs` / `setSettings`）。

**Tech Stack:** Tauri 2 (Rust), Vue 3, vue-i18n, Vite。

---

### Task 1: 新增 panel 窗口配置与权限

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: tauri.conf.json 添加 panel 窗口**

在 `app.windows` 数组内、主窗口之后添加：

```json
{
  "label": "panel",
  "title": "AIGateway",
  "width": 360,
  "height": 560,
  "resizable": false,
  "decorations": false,
  "transparent": true,
  "alwaysOnTop": true,
  "visible": false,
  "skipTaskbar": true,
  "shadow": true
}
```

- [ ] **Step 2: capabilities/default.json 允许 panel 窗口**

`"windows": ["main"]` 改为 `"windows": ["main", "panel"]`（面板需要 `core:default` 中的事件监听与 invoke 权限）。

- [ ] **Step 3: 验证**

Run: `cd src-tauri && cargo check`
Expected: 编译通过（窗口配置改动不需要代码配合）。

---

### Task 2: Rust 命令（quit_app / show_main_window / toggle_panel_window）

**Files:**
- Modify: `src-tauri/src/commands.rs`（在文件末尾 `// --- Port check ---` 之前新增一节）

- [ ] **Step 1: 新增窗口控制命令**

在 `kill_process` 命令附近新增：

```rust
// --- Window control ---

#[tauri::command]
pub fn quit_app(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.proxy.stop().ok();
    app_handle.exit(0);
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn toggle_panel_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    crate::tray::toggle_panel_window(&app_handle);
    Ok(())
}
```

- [ ] **Step 2: 注册命令**

在 `main.rs` 的 `invoke_handler` 中追加 `commands::quit_app, commands::show_main_window, commands::toggle_panel_window,`。

- [ ] **Step 3: 验证**

Run: `cd src-tauri && cargo check`
Expected: 编译报错（`tray::toggle_panel_window` 尚未定义）——这是预期的红，下一步补上。

---

### Task 3: tray.rs 改造（删除菜单、新增面板控制）

**Files:**
- Modify: `src-tauri/src/tray.rs`

- [ ] **Step 1: 精简 imports**

`use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};` 整行删除（菜单构建代码全部删除后不再使用）。

- [ ] **Step 2: 删除菜单相关代码**

删除 `build_tray_menu` 整个函数（从 `pub fn build_tray_menu(` 到文件末尾的 `}`），以及 zh/en 表中仅菜单使用的 key：`toggle.proxy`、`toggle.autostart`、`toggle.httpProxy`、`submenu.providers`、`submenu.models`、`submenu.modelsEmpty`、`show`、`quit`、`toast.modelCopied.prefix`、`status.running`、`status.stopped`。保留 `tray.todayTooltip` 与 `lookup` / `resolve_language` / `fmt_tokens` / `update_tray_stats` / `render_stats_icon` / `glyph` / `paste_resized_logo` / `set_status_icon` / `LAST_TRAY_STATS`。

- [ ] **Step 3: 新增 toggle_panel_window**

在文件末尾新增：

```rust
/// 显示/隐藏面板窗口；显示时定位到主显示器右上角（菜单栏下方）。
pub fn toggle_panel_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("panel") else { return };
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let win_w = window.outer_size().unwrap_or(tauri::PhysicalSize::new(360, 560)).width;
        let margin = (16.0 * scale) as i32;
        let x = size.width as i32 - win_w as i32 - margin;
        let y = (30.0 * scale) as i32; // 菜单栏下方
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = window.show();
    let _ = window.set_focus();
}
```

- [ ] **Step 4: 验证**

Run: `cd src-tauri && cargo check`
Expected: 编译通过（命令引用已定义）。

---

### Task 4: main.rs 托盘与窗口事件改造

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: setup 中移除菜单构建与菜单事件**

- 删除 `let menu = tray::build_tray_menu(...)` 两行
- `TrayIconBuilder` 链删除 `.menu(&menu)`
- 删除 `.on_menu_event(move |app, event| { ... })` 整个闭包
- 删除 `.show_menu_on_left_click(true)`
- 托盘事件改为：

```rust
.on_tray_icon_event(|tray, event| {
    match event {
        TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
            tray::toggle_panel_window(tray.app_handle());
        }
        TrayIconEvent::Click { button: MouseButton::Right, button_state: MouseButtonState::Up, .. } => {
            let app = tray.app_handle();
            if let Some(window) = app.get_webview_window("main") {
                window.show().ok();
                window.set_focus().ok();
            }
        }
        _ => {}
    }
})
```

- [ ] **Step 2: 删除菜单重建监听**

- 删除 `app.listen("proxy-status-changed", ...)` 整块（其唯一作用是重建托盘菜单；前端自行监听该事件）
- 删除 `app.listen("tray-menu-update", ...)` 整块
- 删除文件底部 `fn rebuild_tray_menu(...)` 函数
- 保留后台线程 `update_tray_stats`（60s 刷新托盘图标统计）

- [ ] **Step 3: 面板失焦自动隐藏**

`on_window_event` 闭包改为：

```rust
.on_window_event(|window, event| {
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            window.hide().ok();
            api.prevent_close();
        }
        tauri::WindowEvent::Focused(false) if window.label() == "panel" => {
            window.hide().ok();
        }
        _ => {}
    }
})
```

- [ ] **Step 4: 验证**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，无未使用警告（`Emitter` / `Listener` import 若不再使用需从 use 中移除——`Listener` 仍被 `app.listen` 使用则保留；检查后清理）。

---

### Task 5: 前端 api.js 与 App.vue 分流

**Files:**
- Modify: `src/api.js`
- Modify: `src/App.vue`

- [ ] **Step 1: api.js 新增事件封装**

在 `onStatusChange` 附近新增：

```js
  onSettingsChange: (fn) => {
    return listen('proxy-settings-changed', () => fn())
  },
```

- [ ] **Step 2: App.vue hash 分流**

- 引入 `computed`、`Panel` 组件，新增 `const isPanel = computed(() => window.location.hash.startsWith('#/panel'))`
- `onMounted` 开头加 `if (isPanel.value) return`
- 模板顶部加 `<Panel v-if="isPanel" />`，其余现有内容（nav + 页面 + toast）包进 `<template v-else>` 中
- 底部追加 panel 专用样式（面板页为独立页面，不需要 scoped 样式继承）

- [ ] **Step 3: 验证**

Run: `npm run build`
Expected: Vite 构建成功。

---

### Task 6: 新建 Panel 页面组件

**Files:**
- Create: `src/pages/Panel/index.vue`

- [ ] **Step 1: 实现组件**

组件职责：
- `onMounted` 并行加载 `getSettings` / `getProxyStatus` / `getStats` / `getLogs(50)`；监听 `proxy-status-changed`（`api.onStatusChange`）与 `proxy-settings-changed`（`api.onSettingsChange`）刷新
- 代理开关：`proxyBusy` 防抖，调用 `api.startProxy()` / `api.stopProxy()`
- HTTP 代理开关：改写 `settings.http_proxy.enabled` 后 `api.setSettings(next)`
- 最近模型：过滤 `statusCode === 200` 且 endpoint 非 `/v1/models`、非 `count_tokens`，按 `model` 去重，取前 8，展示 `model` / `provider` / 相对时间，点击 `api.copyText(model)` 后显示轻提示
- 底部按钮：`api.showMainWindow()`、`api.quitApp()`
- 相对时间函数 `fmtRelative(ts)`：<1min「刚刚」、<60min「N 分钟前」、<24h「N 小时前」、否则「N 天前」，文案走 i18n `panel.relative.*`
- 样式：根容器 `border-radius: 14px`、`padding: 14px`、背景 `var(--bg-base)`，卡片复用 `--bg-card` / `--border`，开关用大号 toggle，最近模型列表可滚动

- [ ] **Step 2: 验证**

Run: `npm run build`
Expected: 构建成功（未引用不存在 i18n key 时 vue-i18n 仅警告）。

---

### Task 7: i18n 文案

**Files:**
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/en-US.json`

- [ ] **Step 1: 添加 `panel` 文案节**

zh-CN：

```json
"panel": {
  "proxy": "代理",
  "httpProxy": "HTTP 代理",
  "todayCalls": "今日调用",
  "todayTokens": "今日 Token",
  "recentModels": "最近调用的模型",
  "emptyModels": "暂无调用记录",
  "openMain": "打开主窗口",
  "quit": "退出",
  "copied": "已复制: {model}",
  "relative": {
    "justNow": "刚刚",
    "minutesAgo": "{n} 分钟前",
    "hoursAgo": "{n} 小时前",
    "daysAgo": "{n} 天前"
  }
}
```

en-US 对应翻译：

```json
"panel": {
  "proxy": "Proxy",
  "httpProxy": "HTTP Proxy",
  "todayCalls": "Today Calls",
  "todayTokens": "Today Tokens",
  "recentModels": "Recent Models",
  "emptyModels": "No calls yet",
  "openMain": "Open Main Window",
  "quit": "Quit",
  "copied": "Copied: {model}",
  "relative": {
    "justNow": "just now",
    "minutesAgo": "{n}m ago",
    "hoursAgo": "{n}h ago",
    "daysAgo": "{n}d ago"
  }
}
```

- [ ] **Step 2: 验证**

Run: `node -e "const z=require('./src/i18n/locales/zh-CN.json');const e=require('./src/i18n/locales/en-US.json');if(!z.panel||!e.panel)process.exit(1);console.log('ok')"`
Expected: `ok`

---

### Task 8: 全量验证与收尾

- [ ] **Step 1: 构建**

Run: `npm run build && cd src-tauri && cargo check && cargo test`
Expected: 全部通过。

- [ ] **Step 2: 冒烟运行**

Run: `npm run tauri dev`
Expected: 启动后托盘图标左键弹出面板（右上角、无边框），右键显示主窗口；面板显示状态/统计/最近模型；开关可用；点击外部面板收起。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "feat: 托盘改为面板窗口（左键面板/右键主窗口）"
```
