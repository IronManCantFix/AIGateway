// src/panel.js — 悬浮面板窗口独立入口。
// 只打包 Panel 组件，不加载主界面的 Home/Stats/Logs/Settings 等页面，
// 减少面板 WebView 进程的解析/内存开销。启动流程与主窗口共用 bootstrap.js。
import { createApp } from 'vue'
import './main.css'
import Panel from './pages/Panel/index.vue'
import { i18n } from './i18n'
import { bootstrap } from './bootstrap.js'

bootstrap({
  App: Panel,
  mount: () => createApp(Panel).use(i18n).mount('#app')
})
