use std::sync::Arc;
use tauri::{Emitter, Manager, State};

use crate::config::{ConfigStore, ModelEntry, ModelMappings, Profile, Settings};
use crate::proxy::{ProxyManager, ProxyStatus};

#[derive(serde::Serialize)]
pub struct PortCheckResult {
    pub available: bool,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
}

pub struct AppState {
    pub config: Arc<ConfigStore>,
    pub proxy: ProxyManager,
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub download_url: String,
    pub download_asset_url: String,
    pub asset_name: String,
}

#[derive(serde::Serialize)]
pub struct UpdateResult {
    pub file_path: String,
    pub installed: bool,
}

// --- Proxy commands ---

#[tauri::command]
pub fn start_proxy(state: State<'_, AppState>) -> Result<ProxyStatus, String> {
    state.proxy.start()
}

#[tauri::command]
pub fn stop_proxy(state: State<'_, AppState>) -> Result<(), String> {
    state.proxy.stop()
}

#[tauri::command]
pub fn get_proxy_status(state: State<'_, AppState>) -> ProxyStatus {
    state.proxy.get_status()
}

// --- Profile commands ---

#[tauri::command]
pub fn get_profiles(state: State<'_, AppState>) -> Vec<Profile> {
    state.config.get_profiles()
}

#[tauri::command]
pub fn add_profile(app_handle: tauri::AppHandle, state: State<'_, AppState>, profile: serde_json::Value) -> Result<Profile, String> {
    let p: Profile = serde_json::from_value(profile).map_err(|e| e.to_string())?;
    let saved = state.config.add_profile(p)?;
    let active = state.config.get_active_profiles();
    if active.is_empty() {
        state.config.set_active_profiles(&[saved.id.clone()])?;
        if state.proxy.get_status().status == "running" {
            state.proxy.reload()?;
        }
    }
    app_handle.emit("tray-menu-update", ()).ok();
    Ok(saved)
}

#[tauri::command]
pub fn update_profile(app_handle: tauri::AppHandle, state: State<'_, AppState>, id: String, updates: serde_json::Value) -> Result<Profile, String> {
    let saved = state.config.update_profile(&id, updates)?;
    let active = state.config.get_active_profiles();
    if active.contains(&id) && state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    app_handle.emit("tray-menu-update", ()).ok();
    Ok(saved)
}

#[tauri::command]
pub fn delete_profile(app_handle: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let was_active = state.config.get_active_profiles().contains(&id);
    state.config.delete_profile(&id)?;
    if was_active && state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    app_handle.emit("tray-menu-update", ()).ok();
    Ok(())
}

#[tauri::command]
pub fn get_active_profiles(state: State<'_, AppState>) -> Vec<String> {
    state.config.get_active_profiles()
}

#[tauri::command]
pub fn set_active_profiles(app_handle: tauri::AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    state.config.set_active_profiles(&ids)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    app_handle.emit("tray-menu-update", ()).ok();
    Ok(())
}

#[tauri::command]
pub fn toggle_profile(app_handle: tauri::AppHandle, state: State<'_, AppState>, id: String, enabled: bool) -> Result<(), String> {
    let mut ids = state.config.get_active_profiles();
    if enabled {
        if !ids.contains(&id) {
            ids.push(id);
        }
    } else {
        ids.retain(|i| i != &id);
    }
    state.config.set_active_profiles(&ids)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    app_handle.emit("tray-menu-update", ()).ok();
    Ok(())
}

#[tauri::command]
pub fn reorder_profiles(app_handle: tauri::AppHandle, state: State<'_, AppState>, ordered_ids: Vec<String>) -> Result<(), String> {
    state.config.reorder_profiles(&ordered_ids)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    app_handle.emit("tray-menu-update", ()).ok();
    Ok(())
}

// --- Settings commands ---

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.config.get_settings()
}

#[tauri::command]
pub fn set_settings(app_handle: tauri::AppHandle, state: State<'_, AppState>, settings: serde_json::Value) -> Result<Settings, String> {
    let s: Settings = serde_json::from_value(settings).map_err(|e| e.to_string())?;
    state.config.set_settings(&s)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    let running = state.proxy.get_status().status == "running";
    crate::tray::update_tray_stats(&app_handle, &state.config, running);
    Ok(s)
}

// --- Models commands ---

#[tauri::command]
pub fn get_model_entries(state: State<'_, AppState>) -> Vec<ModelEntry> {
    state.config.get_model_entries()
}

#[tauri::command]
pub fn add_model(state: State<'_, AppState>, model_id: String) -> Result<Vec<ModelEntry>, String> {
    let mut entries = state.config.get_model_entries();
    if !entries.iter().any(|e| e.name == model_id) {
        entries.push(ModelEntry { name: model_id, strategy: "none".to_string() });
        let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
        state.config.set_models(&names)?;
        if state.proxy.get_status().status == "running" {
            state.proxy.reload()?;
        }
    }
    Ok(state.config.get_model_entries())
}

#[tauri::command]
pub fn remove_model(state: State<'_, AppState>, model_id: String) -> Result<Vec<ModelEntry>, String> {
    let mut entries = state.config.get_model_entries();
    entries.retain(|e| e.name != model_id);
    state.config.set_model_entries(&entries)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(entries)
}

#[tauri::command]
pub fn set_model_strategy(state: State<'_, AppState>, model_name: String, strategy: String) -> Result<(), String> {
    state.config.set_model_strategy(&model_name, &strategy)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(())
}

// --- Model Mappings commands ---

#[tauri::command]
pub fn get_model_mappings(state: State<'_, AppState>) -> ModelMappings {
    state.config.get_model_mappings()
}

#[tauri::command]
pub fn set_model_mappings(state: State<'_, AppState>, mappings: serde_json::Value) -> Result<ModelMappings, String> {
    let m: ModelMappings = serde_json::from_value(mappings).map_err(|e| e.to_string())?;
    state.config.set_model_mappings(&m)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(m)
}



// --- Log commands ---

#[tauri::command]
pub fn get_log_enabled(state: State<'_, AppState>) -> bool {
    state.config.get_log_enabled()
}

#[tauri::command]
pub fn set_log_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.config.set_log_enabled(enabled)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(())
}

// --- Stats & Logs commands ---

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> serde_json::Value {
    state.config.get_stats()
}

#[tauri::command]
pub fn get_logs(
    state: State<'_, AppState>,
    limit: Option<usize>,
    offset: Option<usize>,
    filter: Option<crate::config::LogFilter>,
) -> crate::config::LogsPage {
    state.config.get_logs(limit, offset, filter.unwrap_or_default())
}

#[tauri::command]
pub fn get_log_file_size(state: State<'_, AppState>) -> u64 {
    state.config.get_log_file_size()
}

#[tauri::command]
pub fn clear_logs(state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_logs()
}

#[tauri::command]
pub fn clear_all_data(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_all_data()?;
    let running = state.proxy.get_status().status == "running";
    crate::tray::update_tray_stats(&app_handle, &state.config, running);
    Ok(())
}

#[tauri::command]
pub fn clear_logs_bodies(state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_logs_bodies()
}

#[tauri::command]
pub fn clear_aggregated_stats(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_aggregated_stats()?;
    let running = state.proxy.get_status().status == "running";
    crate::tray::update_tray_stats(&app_handle, &state.config, running);
    Ok(())
}

// Clipboard is handled directly by tauri-plugin-clipboard-manager on the frontend.

// --- Fetch provider models ---

#[tauri::command]
pub async fn fetch_provider_models(profile: serde_json::Value) -> Result<Vec<String>, crate::error::AppError> {
    let base_url = profile.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = profile.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let provider_type = profile.get("providerType").and_then(|v| v.as_str()).unwrap_or("");

    let base_url = base_url.trim_end_matches('/').trim_end_matches("/v1");
    let is_gemini = provider_type == "google-gemini" || provider_type == "google-nano-banana";

    let url = if is_gemini {
        format!("{}/v1beta/models", base_url)
    } else {
        format!("{}/v1/models", base_url)
    };

    let client = reqwest::Client::new();
    let req_builder = client
        .get(&url)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10));

    let req_builder = if is_gemini {
        req_builder.header("x-goog-api-key", api_key)
    } else {
        req_builder.header("Authorization", format!("Bearer {}", api_key))
    };

    let resp = req_builder
        .send()
        .await
        .map_err(|e| crate::error::AppError::new("upstream.requestFailed").with_detail(e.to_string()))?;

    let status = resp.status();
    if !status.is_success() {
        let status_code = status.as_u16();
        let code = match status_code {
            401 => "upstream.unauthorized",
            403 => "upstream.forbidden",
            404 => "upstream.endpointNotFound",
            429 => "upstream.rateLimited",
            500 => "upstream.internalError",
            502 => "upstream.badGateway",
            503 => "upstream.unavailable",
            _ => "upstream.unknown",
        };
        let body = resp.text().await.unwrap_or_default();
        // Body excerpt logged to stderr for developer debugging; NOT sent to frontend
        // (upstream responses can contain echoed auth headers / partial tokens)
        let body_excerpt: String = body.chars().take(200).collect();
        eprintln!("[fetch_provider_models] upstream {} body excerpt: {}", status_code, body_excerpt);
        return Err(crate::error::AppError::new(code)
            .with_params(serde_json::json!({ "status": status_code })));
    }

    let body: serde_json::Value = resp.json().await?;

    if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
        let models: Vec<String> = data.iter()
            .filter_map(|m| {
                if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                    Some(id.to_string())
                } else if m.is_string() {
                    m.as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();
        Ok(models)
    } else if let Some(models) = body.get("models").and_then(|d| d.as_array()) {
        let models: Vec<String> = models.iter()
            .filter_map(|m| {
                // Gemini native format: { "name": "models/gemini-pro", ... }
                if let Some(name) = m.get("name").and_then(|v| v.as_str()) {
                    Some(name.strip_prefix("models/").unwrap_or(name).to_string())
                } else if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                    Some(id.to_string())
                } else if m.is_string() {
                    m.as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();
        Ok(models)
    } else {
        let body_excerpt: String = serde_json::to_string(&body).unwrap_or_default().chars().take(300).collect();
        eprintln!("[fetch_provider_models] unknown response format: {}", body_excerpt);
        Err(crate::error::AppError::new("upstream.unknownResponseFormat"))
    }
}

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
pub async fn check_for_updates(app_handle: tauri::AppHandle) -> Result<UpdateInfo, crate::error::AppError> {
    let current_version = app_handle.package_info().version.to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| crate::error::AppError::new("http.clientFailed").with_detail(e.to_string()))?;

    let resp = client
        .get("https://api.github.com/repos/IronManCantFix/AIGateway/releases/latest")
        .header("User-Agent", "AIGateway")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| crate::error::AppError::new("update.requestFailed").with_detail(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(crate::error::AppError::new("update.githubError")
            .with_params(serde_json::json!({ "status": resp.status().as_u16() })));
    }

    let body: serde_json::Value = resp.json().await?;

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
        return Err(crate::error::AppError::new("update.noVersionTag"));
    }

    let has_update = compare_versions(&current_version, &latest_version);

    // Find the asset URL for the current platform
    let assets = body.get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let (download_asset_url, asset_name) = find_platform_asset(&assets);

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        download_url,
        download_asset_url,
        asset_name,
    })
}

fn find_platform_asset(assets: &[serde_json::Value]) -> (String, String) {
    #[cfg(target_os = "macos")]
    let keywords = ["macos", "darwin", ".dmg", "aarch64-apple-darwin"];

    #[cfg(target_os = "windows")]
    let keywords = ["windows", "win", ".msi", ".exe", "x86_64-pc-windows"];

    #[cfg(target_os = "linux")]
    let keywords = ["linux", ".AppImage", ".deb", "x86_64-unknown-linux"];

    for asset in assets {
        let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let lower_name = name.to_lowercase();
        for keyword in &keywords {
            if lower_name.contains(keyword) {
                let url = asset.get("browser_download_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                return (url, name.to_string());
            }
        }
    }
    (String::new(), String::new())
}

#[tauri::command]
pub async fn download_and_install_update(
    app_handle: tauri::AppHandle,
    url: String,
    file_name: String,
) -> Result<UpdateResult, crate::error::AppError> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    if url.is_empty() {
        return Err(crate::error::AppError::new("update.noDownloadUrl"));
    }

    // Validate download URL to prevent arbitrary URL downloads
    if !url.starts_with("https://github.com/IronManCantFix/AIGateway/releases/") {
        return Err(crate::error::AppError::new("update.invalidUrl")
            .with_detail("Download URL must be from the official GitHub releases".to_string()));
    }

    // Download to temp directory
    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join(&file_name);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| crate::error::AppError::new("http.clientFailed").with_detail(e.to_string()))?;

    let resp = client
        .get(&url)
        .header("User-Agent", "AIGateway")
        .send()
        .await
        .map_err(|e| crate::error::AppError::new("update.downloadFailed").with_detail(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(crate::error::AppError::new("update.downloadFailed")
            .with_detail(format!("HTTP {}", resp.status())));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| crate::error::AppError::new("update.fileCreateFailed").with_detail(e.to_string()))?;

    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| crate::error::AppError::new("update.downloadFailed").with_detail(e.to_string()))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| crate::error::AppError::new("update.fileWriteFailed").with_detail(e.to_string()))?;
        downloaded += chunk.len() as u64;

        // Emit progress
        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64 * 100.0) as u32;
            app_handle.emit("update-download-progress", progress).ok();
        }
    }

    file.flush().await.map_err(|e| crate::error::AppError::new("update.fileWriteFailed").with_detail(e.to_string()))?;
    drop(file);

    // Platform-specific installation
    #[cfg(target_os = "macos")]
    {
        // Mount DMG silently (no Finder window, no sidebar entry)
        let mount_output = std::process::Command::new("hdiutil")
            .args(["attach", "-nobrowse", "-quiet", &file_path.to_string_lossy()])
            .output()
            .map_err(|e| crate::error::AppError::new("update.openFailed").with_detail(e.to_string()))?;

        if !mount_output.status.success() {
            return Err(crate::error::AppError::new("update.openFailed")
                .with_detail(format!("hdiutil attach failed: {}", String::from_utf8_lossy(&mount_output.stderr))));
        }

        // Parse mount point from stdout (last line: /dev/diskN  /Volumes/XXX)
        let mount_stdout = String::from_utf8_lossy(&mount_output.stdout);
        let mount_point = mount_stdout.lines().last()
            .and_then(|line| line.split_whitespace().last())
            .ok_or_else(|| crate::error::AppError::new("update.openFailed").with_detail("Cannot parse mount point".to_string()))?;

        // Find .app bundle in the mounted volume
        let app_path = std::fs::read_dir(mount_point)
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .find(|e| {
                        e.path().extension().map_or(false, |ext| ext == "app")
                    })
                    .map(|e| e.path())
            })
            .ok_or_else(|| crate::error::AppError::new("update.openFailed")
                .with_detail(format!("No .app found in mounted volume: {}", mount_point)))?;

        // Copy to /Applications (overwrite existing)
        let dest = std::path::PathBuf::from("/Applications").join(app_path.file_name().unwrap());
        let cp_status = std::process::Command::new("cp")
            .args(["-Rf", &app_path.to_string_lossy(), &dest.to_string_lossy()])
            .status()
            .map_err(|e| crate::error::AppError::new("update.openFailed").with_detail(e.to_string()))?;

        // Unmount DMG
        let _ = std::process::Command::new("hdiutil")
            .args(["detach", "-quiet", mount_point])
            .status();

        if !cp_status.success() {
            return Err(crate::error::AppError::new("update.openFailed")
                .with_detail("Failed to copy app to /Applications".to_string()));
        }
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &file_path.to_string_lossy()])
            .spawn()
            .map_err(|e| crate::error::AppError::new("update.openFailed").with_detail(e.to_string()))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| crate::error::AppError::new("update.openFailed").with_detail(e.to_string()))?;
    }

    Ok(UpdateResult {
        file_path: file_path.to_string_lossy().to_string(),
        installed: cfg!(target_os = "macos"),
    })
}

#[tauri::command]
pub fn get_app_version(app_handle: tauri::AppHandle) -> String {
    app_handle.package_info().version.to_string()
}

#[tauri::command]
pub fn restart_app(app_handle: tauri::AppHandle) {
    app_handle.restart();
}

#[tauri::command]
pub fn toggle_devtools(app_handle: tauri::AppHandle) -> bool {
    if let Some(window) = app_handle.get_webview_window("main") {
        window.open_devtools();
        return true;
    }
    false
}

// --- Port check commands ---

#[tauri::command]
pub fn check_port(port: u16) -> Result<PortCheckResult, String> {
    // Try to bind the port — if it fails, something is using it
    match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(_) => Ok(PortCheckResult { available: true, pid: None, process_name: None }),
        Err(_) => {
            // Port is in use, find out who owns it
            let (pid, name) = find_process_on_port(port);
            Ok(PortCheckResult { available: false, pid, process_name: name })
        }
    }
}

#[cfg(unix)]
fn find_process_on_port(port: u16) -> (Option<u32>, Option<String>) {
    let output = std::process::Command::new("lsof")
        .args(["-i", &format!("TCP:{}", port), "-sTCP:LISTEN", "-n", "-P"])
        .output();
    let stdout = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return (None, None),
    };
    for line in stdout.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            if let Ok(pid) = parts[1].parse::<u32>() {
                return (Some(pid), parts.first().map(|s| s.to_string()));
            }
        }
    }
    (None, None)
}

#[cfg(windows)]
fn find_process_on_port(port: u16) -> (Option<u32>, Option<String>) {
    let output = std::process::Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .output();
    let stdout = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return (None, None),
    };
    let port_suffix = format!(":{}", port);
    for line in stdout.lines() {
        if line.contains("LISTENING") && line.contains(&port_suffix) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if let Some(pid_str) = parts.last() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    // Try to get process name via tasklist
                    let name = get_windows_process_name(pid);
                    return (Some(pid), name);
                }
            }
        }
    }
    (None, None)
}

#[cfg(windows)]
fn get_windows_process_name(pid: u32) -> Option<String> {
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"])
        .output();
    let stdout = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return None,
    };
    for line in stdout.lines() {
        if let Some(name) = line.split(',').next() {
            let name = name.trim_matches('"');
            if !name.is_empty() && !name.contains("No tasks") {
                return Some(name.to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub fn kill_process(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        // SAFETY: libc::kill is an FFI call to the kernel's signal interface.
        // The kernel enforces permission checks (EPERM if the caller doesn't own the process).
        let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        if result == 0 {
            Ok(())
        } else {
            Err(format!("Failed to send SIGTERM to PID {}", pid))
        }
    }
    #[cfg(windows)]
    {
        let result = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
        match result {
            Ok(o) if o.status.success() => Ok(()),
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).to_string()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Update the user's language preference, persist it, and rebuild the tray menu.
///
/// No proxy reload needed: language is UI-only and doesn't affect proxy behavior.
#[tauri::command]
pub async fn set_language(
    app: tauri::AppHandle,
    lang: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), crate::error::AppError> {
    // Persist new language to settings
    let mut settings = state.config.get_settings();
    settings.language = lang;
    state.config.set_settings(&settings)
        .map_err(|e| crate::error::AppError::new("settings.saveFailed").with_detail(e))?;

    // Rebuild tray menu with the new language
    let menu = crate::tray::build_tray_menu(&app, &state.config, &state.proxy);
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu))
            .map_err(|e| crate::error::AppError::new("tray.setMenuFailed").with_detail(e.to_string()))?;
    }
    let running = state.proxy.get_status().status == "running";
    crate::tray::update_tray_stats(&app, &state.config, running);
    Ok(())
}
