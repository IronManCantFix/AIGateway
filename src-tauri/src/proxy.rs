use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::{Emitter, Manager};
use tauri::image::Image;
use tauri::tray::TrayIcon;

use crate::config::{ConfigStore, LogEntry};

fn set_tray_icon(tray: &TrayIcon, running: bool) {
    let bytes = if running {
        include_bytes!("../icons/icon-running.png")
    } else {
        include_bytes!("../icons/icon-stopped.png")
    };
    if let Ok(img) = Image::from_bytes(bytes) {
        tray.set_icon(Some(img)).ok();
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProxyStatus {
    pub status: String, // "running" | "stopped" | "starting"
    pub port: u16,
}

struct ProxyInner {
    child: Option<Child>,
    status: String,
    port: u16,
    stopping: bool,
}

pub struct ProxyManager {
    inner: Arc<Mutex<ProxyInner>>,
    config_store: Arc<ConfigStore>,
    app_handle: tauri::AppHandle,
    tray: Arc<Mutex<Option<TrayIcon>>>,
}

impl Clone for ProxyManager {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            config_store: Arc::clone(&self.config_store),
            app_handle: self.app_handle.clone(),
            tray: Arc::clone(&self.tray),
        }
    }
}

impl ProxyManager {
    pub fn new(config_store: Arc<ConfigStore>, app_handle: tauri::AppHandle) -> Self {
        let port = config_store.get_settings().port;
        Self {
            inner: Arc::new(Mutex::new(ProxyInner {
                child: None,
                status: "stopped".to_string(),
                port,
                stopping: false,
            })),
            config_store,
            app_handle,
            tray: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_tray(&self, tray: TrayIcon) {
        *self.tray.lock().unwrap() = Some(tray);
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

        let sidecar_in_resource = self.app_handle.path().resource_dir()
            .ok()
            .map(|d| d.join("binaries").join(sidecar_name));
        let sidecar_in_source = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries").join(sidecar_name));

        let sidecar_path = [sidecar_in_resource, sidecar_in_source]
            .into_iter()
            .flatten()
            .find(|p| p.exists())
            .ok_or_else(|| format!("Sidecar not found: {}", sidecar_name))?;

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
            let line = serde_json::to_string(&msg).expect("json serialization");
            stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            stdin.write_all(b"\n").map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }

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
        let tray_clone = Arc::clone(&self.tray);

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
                        if let Some(tray) = tray_clone.lock().unwrap().as_ref() {
                            set_tray_icon(tray, true);
                        }
                        app_handle_clone
                            .emit("proxy-status-changed", serde_json::json!({"status": "running"}))
                            .ok();
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
            // Process exited — update state, then release lock before calling set_tray_icon
            let crashed = {
                let mut guard = inner_clone.lock().unwrap();
                guard.status = "stopped".to_string();
                let crashed = !guard.stopping;
                guard.child = None;
                crashed
            };
            // set_tray_icon may block on macOS (AppKit main-thread requirement),
            // so call it AFTER releasing the inner lock to avoid deadlocking the stop thread.
            if let Some(tray) = tray_clone.lock().unwrap().as_ref() {
                set_tray_icon(tray, false);
            }

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
            guard.child.take().map(|mut c| {
                let pid = c.id();
                let stdin = c.stdin.take();
                (c, pid, stdin)
            })
        };

        let inner = Arc::clone(&self.inner);
        let tray = Arc::clone(&self.tray);
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
            if let Some(tray) = tray.lock().unwrap().as_ref() {
                set_tray_icon(tray, false);
            }
        });
        Ok(())
    }

    pub fn reload(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap();
        if let Some(ref mut child) = guard.child {
            if let Some(ref mut stdin) = child.stdin {
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
        }
        Ok(())
    }
}
