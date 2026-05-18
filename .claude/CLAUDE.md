# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AIGateway — 跨平台桌面客户端，本地 AI API 统一代理/切换器。提供统一的本地 HTTP 代理入口（默认 `localhost:9999`），快速切换当前启用的 AI 服务配置，代理根据提供商类型做协议转换转发到上游 API。

## Commands

```bash
npm run tauri dev    # 启动开发模式（前端 + Rust + sidecar）
npm run tauri build  # 生产构建
npm run proxy:build  # 编译 sidecar（所有平台）
```

无测试框架、无 linter 配置。

## Architecture

三层架构，Tauri 框架连接前后端：

- **UI 层**（`src/`）：Vue 3 + Vite，原生 CSS。通过 `@tauri-apps/api` invoke 调用 Rust 命令
- **Rust 层**（`src-tauri/src/`）：配置存储（JSON 文件）、Sidecar 进程管理、系统托盘、Tauri invoke 命令
- **Proxy 层**（`proxy/`）：Node.js 原生 `http` 模块 Sidecar，bun compile 编译为独立二进制。通过 stdin/stdout JSON Lines 与 Rust 通信

### 数据存储

JSON 文件存储于平台标准应用数据目录（`dirs::data_dir()`/`aigateway/`）：
- `settings.json` — 代理设置（port, autoStart, logEnabled）
- `profiles.json` — 服务配置列表
- `models.json` — 全局模型列表
- `logs.json` — 请求日志

### 请求转换矩阵

代理对外暴露 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/models` 四种接口。根据客户端请求接口 × 当前启用配置的 `providerType`（`openai-chat`、`openai-response`、`anthropic-message`）做交叉协议转换。

## Key Files

- `src-tauri/src/main.rs` — Tauri 入口 + 命令注册 + 系统托盘
- `src-tauri/src/config.rs` — JSON 配置存储
- `src-tauri/src/proxy.rs` — Sidecar 进程管理
- `src-tauri/src/commands.rs` — Tauri invoke 命令
- `proxy/proxy-server.js` — 代理服务器 + 协议转换
- `docs/superpowers/specs/2026-05-17-tauri-migration-design.md` — 迁移设计文档
