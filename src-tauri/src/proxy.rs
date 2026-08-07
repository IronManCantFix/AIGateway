use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{Emitter, Manager};

use crate::config::{ConfigStore, LogEntry};

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProxyStatus {
    pub status: String, // "running" | "stopped" | "starting"
    pub port: u16,
}

struct ProxyInner {
    child: Option<Child>,
    // stdin 独立加锁，避免 reload / config_request 回复 / shutdown 并发写管道时交错
    stdin: Mutex<Option<std::process::ChildStdin>>,
    status: String,
    port: u16,
    stopping: bool,
}

pub struct ProxyManager {
    inner: Arc<Mutex<ProxyInner>>,
    config_store: Arc<ConfigStore>,
    app_handle: tauri::AppHandle,
}

impl Clone for ProxyManager {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            config_store: Arc::clone(&self.config_store),
            app_handle: self.app_handle.clone(),
        }
    }
}

impl ProxyManager {
    pub fn new(config_store: Arc<ConfigStore>, app_handle: tauri::AppHandle) -> Self {
        let port = config_store.get_settings().port;
        Self {
            inner: Arc::new(Mutex::new(ProxyInner {
                child: None,
                stdin: Mutex::new(None),
                status: "stopped".to_string(),
                port,
                stopping: false,
            })),
            config_store,
            app_handle,
        }
    }

    pub fn get_status(&self) -> ProxyStatus {
        let guard = self.inner.lock().unwrap();
        ProxyStatus {
            status: guard.status.clone(),
            port: guard.port,
        }
    }

    pub fn start(&self) -> Result<ProxyStatus, String> {
        let mut guard = self.inner.lock().unwrap();
        if guard.child.is_some() {
            return Ok(ProxyStatus {
                status: guard.status.clone(),
                port: guard.port,
            });
        }

        let config = self.config_store.build_proxy_config();
        let port = self.config_store.get_settings().port;

        // Resolve sidecar path using Tauri's path resolution
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

        // Bundler strips target triple, so sidecar name becomes "proxy-server[.exe]"
        let base_name = if cfg!(target_os = "windows") {
            "proxy-server.exe"
        } else {
            "proxy-server"
        };

        let candidates: Vec<PathBuf> = [
            // Packaged app: Tauri copies sidecar to <resource_dir>/binaries/
            self.app_handle.path().resource_dir().ok()
                .map(|d| d.join("binaries").join(sidecar_name)),
            // Packaged app: resource_dir might be the exe directory itself
            self.app_handle.path().resource_dir().ok()
                .map(|d| d.join(sidecar_name)),
            // macOS: bundler places sidecar next to the main exe (stripped name)
            std::env::current_exe().ok()
                .and_then(|e| e.parent().map(|d| d.join(base_name))),
            // Fallback: check next to the exe with full triple name
            std::env::current_exe().ok()
                .and_then(|e| e.parent().map(|d| d.join("binaries").join(sidecar_name))),
            std::env::current_exe().ok()
                .and_then(|e| e.parent().map(|d| d.join(sidecar_name))),
            // Dev build: sidecar in source tree
            Some(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries").join(sidecar_name)),
        ].into_iter().flatten().collect();

        let dev_proxy_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|d| d.join("proxy").join("proxy-server.js"));
        let mut cmd = if cfg!(debug_assertions)
            && dev_proxy_script.as_ref().is_some_and(|p| p.exists())
        {
            let mut cmd = Command::new("node");
            cmd.arg(dev_proxy_script.unwrap());
            cmd
        } else {
            let sidecar_path = candidates.iter()
                .find(|p| p.exists())
                .cloned()
                .ok_or_else(|| {
                    let tried = candidates.iter()
                        .map(|p| format!("  - {}", p.display()))
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!("Sidecar not found: {}\nTried paths:\n{}", sidecar_name, tried)
                })?;
            Command::new(&sidecar_path)
        };
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        // Send init config via stdin
        let mut stdin = child.stdin.take().ok_or("Failed to open sidecar stdin")?;
        let msg = serde_json::json!({
            "type": "init",
            "config": config,
        });
        let line = serde_json::to_string(&msg).expect("json serialization");
        stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;

        // Spawn stderr reader thread
        let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    eprintln!("Sidecar stderr: {}", line);
                }
            }
        });

        // Spawn stdout reader thread
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        let inner_clone = Arc::clone(&self.inner);
        let config_store_clone = Arc::clone(&self.config_store);
        let app_handle_clone = self.app_handle.clone();

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
                            if let Ok(port) = u16::try_from(p) {
                                inner_clone.lock().unwrap().port = port;
                            }
                        }
                        inner_clone.lock().unwrap().status = "running".to_string();
                        crate::tray::update_tray_stats(&app_handle_clone, &config_store_clone, true);
                        app_handle_clone
                            .emit("proxy-status-changed", serde_json::json!({"status": "running"}))
                            .ok();
                    }
                    Some("log") => {
                        if let Some(data) = msg.get("data") {
                            if let Ok(entry) = serde_json::from_value::<LogEntry>(data.clone()) {
                                if config_store_clone.add_log(&entry).is_ok() {
                                    crate::tray::update_tray_stats(&app_handle_clone, &config_store_clone, true);
                                }
                            }
                        }
                    }
                    Some("config_request") => {
                        // Sidecar 请求最新配置（例如 GET /v1/models 时），
                        // 从磁盘重新构建并回复，保证接口始终反映最新可用模型。
                        let config = config_store_clone.build_proxy_config();
                        let id = msg.get("id").cloned();
                        let guard = inner_clone.lock().unwrap();
                        let mut stdin_guard = guard.stdin.lock().unwrap();
                        if let Some(ref mut stdin) = *stdin_guard {
                            let reply = serde_json::json!({
                                "type": "config_update",
                                "id": id,
                                "config": config,
                            });
                            let line = serde_json::to_string(&reply).expect("json serialization");
                            let _ = stdin.write_all(line.as_bytes());
                            let _ = stdin.write_all(b"\n");
                            let _ = stdin.flush();
                        }
                    }
                    Some("error") => {
                        let error = msg.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
                        let message = msg.get("message").and_then(|m| m.as_str()).unwrap_or("");
                        eprintln!("Sidecar error: {} - {}", error, message);
                        // EADDRINUSE: port occupied, clean up and notify frontend
                        if error == "EADDRINUSE" {
                            {
                                let mut guard = inner_clone.lock().unwrap();
                                guard.status = "stopped".to_string();
                                if let Some(mut child) = guard.child.take() {
                                    child.kill().ok();
                                }
                            }
                            crate::tray::update_tray_stats(&app_handle_clone, &config_store_clone, false);
                            app_handle_clone
                                .emit("proxy-status-changed", serde_json::json!({
                                    "status": "stopped",
                                    "error": "EADDRINUSE",
                                    "message": message
                                }))
                                .ok();
                        }
                    }
                    _ => {}
                }
            }
            // Process exited — update state, then release lock before calling set_tray_icon
            let crashed = {
                let mut guard = inner_clone.lock().unwrap();
                guard.status = "stopped".to_string();
                let crashed = !guard.stopping;
                guard.child = None;
                crashed
            };
            crate::tray::update_tray_stats(&app_handle_clone, &config_store_clone, false);

            if crashed {
                app_handle_clone
                    .emit("proxy-status-changed", serde_json::json!({"status": "stopped", "crashed": true}))
                    .ok();
            } else {
                app_handle_clone
                    .emit("proxy-status-changed", serde_json::json!({"status": "stopped"}))
                    .ok();
            }
        });

        guard.child = Some(child);
        *guard.stdin.lock().unwrap() = Some(stdin);
        guard.status = "starting".to_string();
        guard.port = port;

        Ok(ProxyStatus { status: "starting".to_string(), port })
    }

    pub fn stop(&self) -> Result<(), String> {
        // Extract what we need before spawning thread, then release the lock
        let child_info = {
            let mut guard = self.inner.lock().unwrap();
            guard.stopping = true;
            guard.status = "stopping".to_string();
            let stdin = guard.stdin.lock().unwrap().take();
            guard.child.take().map(|c| {
                let pid = c.id();
                (c, pid, stdin)
            })
        };

        let inner = Arc::clone(&self.inner);
        let app_handle = self.app_handle.clone();
        let config_store = Arc::clone(&self.config_store);
        thread::spawn(move || {
            if let Some((mut child, pid, mut stdin)) = child_info {
                // send shutdown via stdin
                if let Some(ref mut s) = stdin {
                    let msg = serde_json::json!({ "type": "shutdown" });
                    let line = serde_json::to_string(&msg).expect("json serialization");
                    s.write_all(line.as_bytes()).ok();
                    s.write_all(b"\n").ok();
                    s.flush().ok();
                }
                // SIGTERM on Unix
                #[cfg(unix)]
                {
                    // SAFETY: pid comes from a successfully spawned process.
                    unsafe { libc::kill(pid as i32, libc::SIGTERM); }
                }
                std::thread::sleep(std::time::Duration::from_secs(3));
                child.kill().ok();
                child.wait().ok();
            }
            {
                let mut guard = inner.lock().unwrap();
                guard.child = None;
                guard.status = "stopped".to_string();
                guard.stopping = false;
            }
            // 统一走统计图标刷新：代理停止后恢复显示今日统计（或纯状态 logo）
            crate::tray::update_tray_stats(&app_handle, &config_store, false);
        });
        Ok(())
    }

    pub fn reload(&self) -> Result<(), String> {
        let guard = self.inner.lock().unwrap();
        let mut stdin_guard = guard.stdin.lock().unwrap();
        if let Some(ref mut stdin) = *stdin_guard {
            let config = self.config_store.build_proxy_config();
            let msg = serde_json::json!({
                "type": "reload",
                "config": config,
            });
            let line = serde_json::to_string(&msg).expect("json serialization");
            stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            stdin.write_all(b"\n").map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
