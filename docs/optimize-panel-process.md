# 面板窗口进程优化方案（可执行）

> 目标：降低 AIGateway 双窗口（主窗口 + 托盘悬浮面板）的常驻资源占用。
> 现状：`tauri.conf.json` 静态声明两个窗口 → macOS 上每个窗口一个 WKWebView 渲染进程（`com.apple.WebKit.WebContent`），面板窗口即使隐藏也常驻渲染进程，且加载的是全量 264KB bundle。

---

## 任务 A：面板按需创建 + 失焦延迟销毁（常驻渲染进程 2 → 1）

### A1. 移除静态 panel 窗口声明

`src-tauri/tauri.conf.json` → `app.windows` 数组里删除 panel 那条，只保留 `main`。

### A2. Rust 运行时创建面板窗口

`src-tauri/src/tray.rs` 新增 `ensure_panel_window()`，把原来 tauri.conf.json 里的面板属性迁移到 builder：

```rust
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn ensure_panel_window(app: &tauri::AppHandle) -> WebviewWindow {
    if let Some(w) = app.get_webview_window("panel") {
        return w;
    }
    WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("panel.html".into()))
        .title("AIGateway")
        .inner_size(360.0, 480.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .visible(false)
        .skip_taskbar(true)
        .shadow(true)
        .build()
        .expect("failed to create panel window")
}
```

### A3. toggle 逻辑改为"不存在则创建"

`src-tauri/src/tray.rs` 的 `toggle_panel_window`：

```rust
pub fn toggle_panel_window(app: &tauri::AppHandle) {
    let window = ensure_panel_window(app);
    // ……原有定位逻辑保持不变……
    let _ = window.show();
    let _ = window.set_focus();
}
```

### A4. 失焦 → 隐藏 + 延迟销毁

`src-tauri/src/tray.rs` 新增延迟销毁调度（用"唤醒后复查窗口状态"代替计时器取消，简单可靠）：

```rust
use std::sync::atomic::{AtomicBool, Ordering};

static PANEL_DESTROY_SCHEDULED: AtomicBool = AtomicBool::new(false);

/// 面板隐藏后延迟 N 秒销毁窗口，释放 WebContent 渲染进程。
/// 期间用户重新打开面板 → 复查时窗口可见/聚焦 → 不销毁（零延迟复用）。
pub fn schedule_panel_destroy(app: &tauri::AppHandle) {
    if PANEL_DESTROY_SCHEDULED.swap(true, Ordering::SeqCst) {
        return; // 已有调度在途，避免线程堆积
    }
    const DELAY: u64 = 60; // 秒，可按体验调整
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(DELAY));
        PANEL_DESTROY_SCHEDULED.store(false, Ordering::SeqCst);
        if let Some(w) = app.get_webview_window("panel") {
            let hidden = !w.is_visible().unwrap_or(false);
            let unfocused = !w.is_focused().unwrap_or(false);
            if hidden && unfocused {
                let _ = w.destroy(); // 销毁后 get_webview_window("panel") 返回 None，下次点击自动重建
            }
        }
    });
}
```

`src-tauri/src/main.rs` 的 `on_window_event`，panel 失焦分支改为：

```rust
tauri::WindowEvent::Focused(false) if window.label() == "panel" => {
    window.hide().ok();
    crate::tray::schedule_panel_destroy(window.app_handle());
}
```

### A5. 验证（任务 A）

- `npm run tauri dev` 启动，活动监视器 / `ps` 确认 WebContent 渲染进程只有 1 个（主窗口）
- 托盘点开面板：正常显示、定位正确（托盘图标下方）、可操作
- 失焦后 60s：`ps -axo pid,ppid,comm | grep -iE "aigateway|WebKit"` 确认面板 WebContent 消失
- 再次点开面板：重新创建并正常显示（首次约 100~300ms 延迟属预期）
- 60s 内反复开关面板：无重建等待（窗口仍存活直接显示）
- 退出应用时无残留进程（`main.rs` 的 `RunEvent::Exit` 清理逻辑不受影响）

---

## 任务 B：面板独立入口代码分割（面板进程加载量 264KB → ~200KB）

> 诚实修正：`~100KB` 是乐观估计。vue + vue-i18n + tauri-api + api.js 是两窗口共享的底子（约 200KB），真正能省的是 Home/Stats/Logs/Settings 四个页面的组件代码（约 50~60KB JS + 面板 CSS 单独成包）。收益是**解析/执行量减少约 20~25%**，面板进程内存与启动开销下降，且主窗口 bundle 也同时变小。

### B1. 新建 `panel.html`（项目根，与 index.html 并列）

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AIGateway Panel</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/panel.js"></script>
  </body>
</html>
```

### B2. 新建 `src/panel.js`

```js
import { createApp } from 'vue'
import './main.css'
import Panel from './pages/Panel/index.vue'
import { i18n } from './i18n'
import { initTheme } from './theme.js'
import { bootstrap } from './bootstrap.js'

bootstrap({ app: Panel, i18n, initTheme, mount: (app) => createApp(app).use(i18n).mount('#app') })
```

（`bootstrap` 是下面 B3 抽取的公共初始化；如果不想抽，直接复制 `main.js` 里的 bootstrap 逻辑到 `panel.js` 也可，代价是两份初始化代码。）

### B3. 抽取公共初始化 `src/bootstrap.js`（消除 main.js / panel.js 重复）

把 `src/main.js` 里 `bootstrap()` 的"读设置 → 解析语言 → 初始化主题 → 挂载"逻辑抽成：

```js
// src/bootstrap.js
import { i18n, applyLocaleFromSetting, resolveLocale } from './i18n'
import { initTheme } from './theme.js'
import { api } from './api.js'

export async function bootstrap({ App, mount }) {
  let resolved = 'en-US'
  let setting = 'auto'
  try {
    const settings = await api.getSettings()
    setting = settings?.language ?? 'auto'
    resolved = await applyLocaleFromSetting(setting)
    initTheme(settings?.theme || 'auto')
  } catch (e) {
    console.error('i18n boot failed, falling back:', e)
    resolved = await applyLocaleFromSetting('auto')
    initTheme('auto')
  }
  if (setting === 'auto') {
    try { await api.setLanguage(resolved) } catch (e) { console.warn('Failed to sync resolved locale to Rust:', e) }
  }
  mount(App)
}
```

`src/main.js` 改为：

```js
import { createApp } from 'vue'
import './main.css'
import App from './App.vue'
import { i18n } from './i18n'
import { bootstrap } from './bootstrap.js'

// ……Cmd+Shift+D 快捷键逻辑保持不变……

bootstrap({ App, mount: () => createApp(App).use(i18n).mount('#app') })
```

### B4. vite 多入口

`vite.config.js`：

```js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        panel: resolve(__dirname, 'panel.html'),
      },
    },
  },
})
```

### B5. tauri.conf.json

- 面板 URL 指向 `panel.html`（任务 A 已完成时：运行时 builder 里已是 `panel.html`，无需再改）

### B6. 主窗口瘦身：删除 App.vue 的 panel 分支

`src/App.vue`：
- 删除 `import Panel from './pages/Panel/index.vue'`
- 删除 `const isPanel = computed(...)` 及其 import 依赖（`computed` 若仅此处使用一并移除）
- 模板删除 `<Panel v-if="isPanel" />` 与 `<template v-else>` 包裹层（原来 `isPanel` 三元的整个分支）

### B7. 验证（任务 B）

- `npm run build` → `dist/` 应出现 `index.html`、`panel.html` 及 `assets/index-*.js`、`assets/panel-*.js`
- 主窗口功能回归：Home / Stats / Logs / Settings / ProfileEdit 全部正常
- 面板功能回归：统计、开关代理、复制地址、i18n（中/英）、主题跟随正常
- dev 模式：`http://localhost:1420/panel.html` 可独立访问

---

## 实施顺序建议

1. **先做任务 B**（纯前端，低风险，独立可验证，不碰 Rust）
   - 提交 1：`panel.html` + `src/panel.js` + `src/bootstrap.js` + vite 多入口 + App.vue 瘦身
2. **再做任务 A**（Rust 窗口生命周期）
   - 提交 2：tauri.conf.json 移除静态 panel + `ensure_panel_window` + 延迟销毁

两个提交相互独立，各自可回滚。

## 风险与回滚

| 风险 | 应对 |
|---|---|
| 面板首次创建延迟（100~300ms） | 属预期；`visible(false)` 创建后再 show 避免闪烁；60s 复用窗口兜底 |
| 销毁线程误判（窗口被外部重新显示） | 唤醒后复查 `is_visible && is_focused` 才销毁 |
| `App.vue` 删 panel 分支后主窗口异常 | 提交 1 可整体 revert |
| 多入口构建产物路径变化 | `base: './'` 已保证相对路径，Tauri 打包不受影响 |

## 收益汇总

| 指标 | 现状 | 任务 A 后 | A+B 后 |
|---|---|---|---|
| 常驻 WebContent 渲染进程 | 2 | 1 | 1（面板弹出时临时 2） |
| 面板进程 bundle | 264KB | 264KB | ~200KB |
| 面板每次打开延迟 | 0（常驻） | 0（60s 内）/ ~200ms（超时后） | 同上（重建更快） |
| 面板隐藏时的内存 | 常驻不释放 | 60s 后归零 | 60s 后归零 |
