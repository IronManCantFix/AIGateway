use std::sync::Arc;
use tauri::{Emitter, State};

use crate::config::{ConfigStore, ModelMappings, Profile, Settings};
use crate::proxy::{ProxyManager, ProxyStatus};

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
pub fn set_settings(state: State<'_, AppState>, settings: serde_json::Value) -> Result<Settings, String> {
    let s: Settings = serde_json::from_value(settings).map_err(|e| e.to_string())?;
    state.config.set_settings(&s)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(s)
}

// --- Models commands ---

#[tauri::command]
pub fn get_models(state: State<'_, AppState>) -> Vec<String> {
    state.config.get_models()
}

#[tauri::command]
pub fn add_model(state: State<'_, AppState>, model_id: String) -> Result<Vec<String>, String> {
    let mut models = state.config.get_models();
    if !models.contains(&model_id) {
        models.push(model_id);
        state.config.set_models(&models)?;
        if state.proxy.get_status().status == "running" {
            state.proxy.reload()?;
        }
    }
    Ok(models)
}

#[tauri::command]
pub fn remove_model(state: State<'_, AppState>, model_id: String) -> Result<Vec<String>, String> {
    let mut models = state.config.get_models();
    models.retain(|m| m != &model_id);
    state.config.set_models(&models)?;
    if state.proxy.get_status().status == "running" {
        state.proxy.reload()?;
    }
    Ok(models)
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
pub fn get_logs(state: State<'_, AppState>, limit: Option<usize>) -> Vec<crate::config::LogEntry> {
    state.config.get_logs(limit)
}

#[tauri::command]
pub fn clear_logs(state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_logs()
}

#[tauri::command]
pub fn clear_all_data(state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_all_data()
}

#[tauri::command]
pub fn clear_logs_bodies(state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_logs_bodies()
}

#[tauri::command]
pub fn clear_aggregated_stats(state: State<'_, AppState>) -> Result<(), String> {
    state.config.clear_aggregated_stats()
}

// Clipboard is handled directly by tauri-plugin-clipboard-manager on the frontend.

// --- Fetch provider models ---

#[tauri::command]
pub async fn fetch_provider_models(profile: serde_json::Value) -> Result<Vec<String>, String> {
    let base_url = profile.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = profile.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");

    let base_url = base_url.trim_end_matches('/').trim_end_matches("/v1");
    let url = format!("{}/v1/models", base_url);

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let status_messages: std::collections::HashMap<u16, &str> = [
            (401, "API Key 无效或无权限访问"),
            (403, "无权限访问该接口"),
            (404, "该提供商不支持 /v1/models 端点"),
            (429, "请求过于频繁，请稍后重试"),
            (500, "上游服务器内部错误"),
            (502, "上游网关错误"),
            (503, "上游服务暂不可用"),
        ].iter().cloned().collect();

        let tip = status_messages.get(&status.as_u16()).unwrap_or(&"未知错误");
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("{}\n{}", tip, &body[..body.len().min(200)]));
    }

    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("JSON解析失败: {}", e))?;

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
    } else {
        Err(format!("未知响应格式: {}", serde_json::to_string(&body).unwrap_or_default().chars().take(300).collect::<String>()))
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
pub async fn check_for_updates(app_handle: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app_handle.package_info().version.to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;

    let resp = client
        .get("https://api.github.com/repos/IronManCantFix/AIGateway/releases/latest")
        .header("User-Agent", "AIGateway")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回错误: {}", resp.status()));
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

    if latest_version.is_empty() {
        return Err("无法获取最新版本号".to_string());
    }

    let has_update = compare_versions(&current_version, &latest_version);

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        download_url,
    })
}
