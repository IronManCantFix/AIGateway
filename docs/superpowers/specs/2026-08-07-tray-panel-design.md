# 托盘面板窗口设计（dev-1.7.0）

## 目标

去掉托盘图标点击后弹出的列表菜单，改为：

- **左键点击托盘图标** → 显示/隐藏一个紧凑的独立面板窗口
- **右键点击托盘图标** → 显示主窗口（保持当前页面）

面板窗口展示：运行状态、今日调用次数与 Token、最近调用的模型、代理开关、HTTP 代理开关，并提供"打开主窗口"和"退出"入口。

## 背景

- Tauri 2 + Vue 3 应用，macOS 菜单栏应用（`ActivationPolicy::Accessory`）
- 当前托盘使用 `build_tray_menu` 构建完整菜单（状态、地址、代理开关、开机自启、HTTP 代理、提供商、模型、显示窗口、退出）
- 统计数据存于 `aggregated-stats.json`，`getStats` 命令返回 `today.count` / `today.tokens` 等
- 日志 JSONL 含每次调用的 `timestamp` / `model` / `provider` / `statusCode` / `endpoint`
- 主窗口 Home 页已具备提供商切换、模型列表与复制功能

## 交互设计

| 操作 | 行为 |
| --- | --- |
| 左键点击托盘图标 | 面板窗口在托盘图标附近显示；若已显示则隐藏 |
| 右键点击托盘图标 | 显示并聚焦主窗口 |
| 点击面板外部 | 面板自动隐藏（窗口失焦） |
| 面板底部"打开主窗口" | 显示主窗口 |
| 面板底部"退出" | 停止代理并退出应用 |

原菜单中的提供商切换、模型复制由主窗口承担；开机自启开关仍保留在主窗口设置页（不改动）。

## 面板布局（约 360×520，无边框、置顶、不可缩放）

1. **顶部**：运行状态徽标（运行中/已停止）+ 代理地址（`http://127.0.0.1:{port}`）
2. **开关区**：两个大卡片开关 —— 代理（启动/停止）、HTTP 代理（启用/停用）
3. **统计区**：今日调用次数、今日 Token 两个卡片
4. **最近模型**：最近 8 个调用过的模型，按时间倒序、按模型名去重；显示模型名、提供商、相对时间；点击复制模型名
5. **底部**：打开主窗口、退出应用

## 数据与命令

- 状态：`getProxyStatus`；开关动作 `startProxy` / `stopProxy` / `getSettings` / `setSettings`
- 今日统计：`getStats`（`today.count`、`today.tokens`）
- 最近模型：`getLogs(50)`，前端过滤 `statusCode === 200` 且非中转接口（`/v1/models`、`count_tokens`），按模型去重取前 8
- 事件：面板监听 `proxy-status-changed`、`proxy-settings-changed` 刷新状态与设置
- 新增 Rust 命令：`quit_app`（停止代理并退出）、`show_main_window`（显示主窗口）、`toggle_panel`（显示/隐藏面板，供面板内按钮或测试用）

## 技术实现

### Tauri 配置（`src-tauri/tauri.conf.json`）

新增第二个窗口：

```json
{
  "label": "panel",
  "title": "AIGateway",
  "width": 360,
  "height": 520,
  "resizable": false,
  "decorations": false,
  "alwaysOnTop": true,
  "visible": false,
  "skipTaskbar": true,
  "shadow": true
}
```

初始 `visible: false`，避免启动闪现；由托盘事件控制显示。面板通过 `index.html#/panel` 加载前端路由。

### Rust（`src-tauri/src/tray.rs`、`main.rs`、`commands.rs`）

- 删除 `build_tray_menu` 及 `SubmenuBuilder` / `CheckMenuItemBuilder` 相关代码
- 保留 `lookup`（含新增面板文案）、`fmt_tokens`、`update_tray_stats`、图标渲染等函数
- 托盘事件：
  - 左键抬起：`toggle_panel_window(app)` —— 若面板可见则隐藏，否则定位到托盘图标附近（优先 `tray.rect()`，退化用主显示器右上角）并显示聚焦
  - 右键抬起：显示主窗口
- 移除 `.menu()` 与 `on_menu_event`，移除 `tray-menu-update` 监听（不再重建菜单）；`proxy-status-changed` 保留（面板与主窗口刷新数据）
- `on_window_event`：主窗口关闭请求仍隐藏到托盘；面板窗口失焦（`Focused(false)`）自动隐藏

### 前端（`src/App.vue`、`src/pages/Panel/index.vue`、`src/api.js`、i18n）

- `App.vue` 顶部按 `location.hash === '#/panel'` 分流：面板窗口渲染 `Panel` 组件，不渲染顶栏/标签页；主窗口渲染现有结构
- 新建 `src/pages/Panel/index.vue`：布局如上，复用现有 CSS 变量主题
- `api.js` 新增 `onSettingsChange`（监听 `proxy-settings-changed`），`getLogs` 已有
- i18n 新增 `panel.*` 文案（zh-CN / en-US）

## 不做的事（YAGNI）

- 不在面板显示趋势图、热力图、日志列表
- 不把开机自启、提供商管理搬进面板
- 不保留托盘菜单列表
