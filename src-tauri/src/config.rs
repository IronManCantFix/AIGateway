use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// --- Data Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(rename = "providerType")]
    pub provider_type: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "apiKey", default)]
    pub api_key: String,
    #[serde(rename = "defaultModel", default)]
    pub default_model: String,
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(rename = "autoStart", default)]
    pub auto_start: bool,
    #[serde(rename = "logEnabled", default)]
    pub log_enabled: bool,
}

fn default_port() -> u16 { 9999 }

impl Default for Settings {
    fn default() -> Self {
        Self { port: 9999, auto_start: false, log_enabled: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelMappings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub rules: Vec<MappingRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MappingRule {
    pub from: String,
    pub to: String,
}

impl Default for ModelMappings {
    fn default() -> Self {
        Self { enabled: false, rules: vec![] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: u64,
    pub endpoint: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub provider: String,
    #[serde(rename = "statusCode")]
    pub status_code: u16,
    #[serde(default)]
    pub duration: u64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(rename = "requestBody", default)]
    pub request_body: Option<String>,
    #[serde(rename = "responseBody", default)]
    pub response_body: Option<String>,
    #[serde(rename = "promptTokens", default)]
    pub prompt_tokens: Option<u64>,
    #[serde(rename = "completionTokens", default)]
    pub completion_tokens: Option<u64>,
    #[serde(rename = "totalTokens", default)]
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StatsSnapshot {
    #[serde(default)]
    pub logs: Vec<LogEntry>,
}

// --- Config Store ---

pub struct ConfigStore {
    dir: PathBuf,
}

impl ConfigStore {
    pub fn new() -> Self {
        let dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("aigateway");
        fs::create_dir_all(&dir).ok();
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn read_json<T: Default + for<'de> Deserialize<'de>>(&self, name: &str) -> T {
        let path = self.path(name);
        match fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str(&s) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("Failed to parse {}: {}", name, e);
                    T::default()
                }
            },
            Err(_) => T::default(),
        }
    }

    fn write_json<T: Serialize>(&self, name: &str, value: &T) -> Result<(), String> {
        let path = self.path(name);
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        fs::write(&tmp, &json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    // --- Profiles ---

    pub fn get_profiles(&self) -> Vec<Profile> {
        #[derive(Deserialize, Default)]
        struct Wrapper { #[serde(default)] profiles: Vec<Profile> }
        let w: Wrapper = self.read_json("profiles.json");
        w.profiles
    }

    fn save_profiles(&self, profiles: &[Profile]) -> Result<(), String> {
        #[derive(Serialize)]
        struct Wrapper<'a> { profiles: &'a [Profile] }
        self.write_json("profiles.json", &Wrapper { profiles })
    }

    pub fn add_profile(&self, mut profile: Profile) -> Result<Profile, String> {
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        let mut profiles = self.get_profiles();
        profiles.push(profile.clone());
        self.save_profiles(&profiles)?;
        Ok(profile)
    }

    pub fn update_profile(&self, id: &str, updates: serde_json::Value) -> Result<Profile, String> {
        let mut profiles = self.get_profiles();
        let idx = profiles.iter().position(|p| p.id == id)
            .ok_or_else(|| "Profile not found".to_string())?;
        let mut profile_json = serde_json::to_value(&profiles[idx]).map_err(|e| e.to_string())?;
        if let (Some(obj), Some(upd)) = (profile_json.as_object_mut(), updates.as_object()) {
            for (k, v) in upd {
                obj.insert(k.clone(), v.clone());
            }
        }
        let updated: Profile = serde_json::from_value(profile_json).map_err(|e| e.to_string())?;
        profiles[idx] = updated.clone();
        self.save_profiles(&profiles)?;
        Ok(updated)
    }

    pub fn delete_profile(&self, id: &str) -> Result<(), String> {
        let mut profiles = self.get_profiles();
        profiles.retain(|p| p.id != id);
        self.save_profiles(&profiles)?;
        let mut active = self.get_active_profiles();
        active.retain(|aid| aid != id);
        self.set_active_profiles(&active)?;
        Ok(())
    }

    pub fn reorder_profiles(&self, ordered_ids: &[String]) -> Result<(), String> {
        let profiles = self.get_profiles();
        let mut reordered = Vec::new();
        for id in ordered_ids {
            if let Some(p) = profiles.iter().find(|p| &p.id == id) {
                reordered.push(p.clone());
            }
        }
        for p in &profiles {
            if !ordered_ids.contains(&p.id) {
                reordered.push(p.clone());
            }
        }
        self.save_profiles(&reordered)
    }

    // --- Active Profiles ---

    pub fn get_active_profiles(&self) -> Vec<String> {
        #[derive(Deserialize, Default)]
        struct Wrapper { #[serde(default)] ids: Vec<String> }
        let w: Wrapper = self.read_json("active-profiles.json");
        w.ids
    }

    pub fn set_active_profiles(&self, ids: &[String]) -> Result<(), String> {
        #[derive(Serialize)]
        struct Wrapper<'a> { ids: &'a [String] }
        self.write_json("active-profiles.json", &Wrapper { ids })
    }

    // --- Settings ---

    pub fn get_settings(&self) -> Settings {
        self.read_json("settings.json")
    }

    pub fn set_settings(&self, settings: &Settings) -> Result<(), String> {
        self.write_json("settings.json", settings)
    }

    // --- Models ---

    pub fn get_models(&self) -> Vec<String> {
        #[derive(Deserialize, Default)]
        struct Wrapper { #[serde(default)] models: Vec<String> }
        let w: Wrapper = self.read_json("models.json");
        w.models
    }

    pub fn set_models(&self, models: &[String]) -> Result<(), String> {
        #[derive(Serialize)]
        struct Wrapper<'a> { models: &'a [String] }
        self.write_json("models.json", &Wrapper { models })
    }

    // --- Model Mappings ---

    pub fn get_model_mappings(&self) -> ModelMappings {
        self.read_json("model-mappings.json")
    }

    pub fn set_model_mappings(&self, mappings: &ModelMappings) -> Result<(), String> {
        self.write_json("model-mappings.json", mappings)
    }

    // --- Log Enabled ---

    pub fn get_log_enabled(&self) -> bool {
        self.get_settings().log_enabled
    }

    pub fn set_log_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut settings = self.get_settings();
        settings.log_enabled = enabled;
        self.set_settings(&settings)
    }

    // --- Logs & Stats ---

    pub fn get_logs(&self, limit: Option<usize>) -> Vec<LogEntry> {
        let snapshot: StatsSnapshot = self.read_json("stats-snapshot.json");
        let mut logs = snapshot.logs;
        logs.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        if let Some(n) = limit {
            logs.truncate(n);
        }
        logs
    }

    pub fn add_log(&self, entry: &LogEntry) -> Result<(), String> {
        let mut snapshot: StatsSnapshot = self.read_json("stats-snapshot.json");
        snapshot.logs.push(entry.clone());
        if snapshot.logs.len() > 5000 {
            let drain_count = snapshot.logs.len() - 5000;
            snapshot.logs.drain(0..drain_count);
        }
        self.write_json("stats-snapshot.json", &snapshot)
    }

    pub fn clear_logs(&self) -> Result<(), String> {
        let snapshot = StatsSnapshot { logs: vec![] };
        self.write_json("stats-snapshot.json", &snapshot)
    }

    pub fn clear_logs_bodies(&self) -> Result<(), String> {
        let mut snapshot: StatsSnapshot = self.read_json("stats-snapshot.json");
        for log in &mut snapshot.logs {
            log.request_body = None;
            log.response_body = None;
        }
        self.write_json("stats-snapshot.json", &snapshot)
    }

    pub fn clear_all_data(&self) -> Result<(), String> {
        for name in &["profiles.json", "active-profiles.json", "models.json", "model-mappings.json", "stats-snapshot.json"] {
            fs::remove_file(self.path(name)).ok();
        }
        Ok(())
    }

    // --- Stats aggregation ---

    pub fn get_stats(&self) -> serde_json::Value {
        let logs = self.get_logs(None);
        let total_requests = logs.len();
        let total_tokens: u64 = logs.iter().filter_map(|l| l.total_tokens).sum();
        let total_prompt_tokens: u64 = logs.iter().filter_map(|l| l.prompt_tokens).sum();
        let total_completion_tokens: u64 = logs.iter().filter_map(|l| l.completion_tokens).sum();

        let mut provider_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut provider_model_map: std::collections::HashMap<String, std::collections::HashMap<String, u64>> = std::collections::HashMap::new();
        let mut model_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut model_tokens_map: std::collections::HashMap<String, (u64, u64, u64)> = std::collections::HashMap::new();
        let mut provider_tokens_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

        for log in &logs {
            let provider = if log.provider.is_empty() { "-".to_string() } else { log.provider.clone() };
            let model = if log.model.is_empty() { "-".to_string() } else { log.model.clone() };

            *provider_map.entry(provider.clone()).or_insert(0) += 1;
            *provider_model_map.entry(provider.clone()).or_default().entry(model.clone()).or_insert(0) += 1;
            *model_map.entry(model.clone()).or_insert(0) += 1;

            if let Some(t) = log.total_tokens {
                let e = model_tokens_map.entry(model.clone()).or_insert((0, 0, 0));
                e.0 += t;
                e.1 += log.prompt_tokens.unwrap_or(0);
                e.2 += log.completion_tokens.unwrap_or(0);
                *provider_tokens_map.entry(provider.clone()).or_insert(0) += t;
            }
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let day_ms: u64 = 86400000;
        let mut trend = Vec::new();
        for i in (0..30).rev() {
            let day_start = now - (i + 1) * day_ms;
            let day_end = now - i * day_ms;
            let date = chrono_date(day_end);
            let day_logs: Vec<&LogEntry> = logs.iter().filter(|l| l.timestamp >= day_start && l.timestamp < day_end).collect();
            let count = day_logs.len();
            let tokens: u64 = day_logs.iter().filter_map(|l| l.total_tokens).sum();
            trend.push(serde_json::json!({ "date": date, "count": count, "tokens": tokens }));
        }

        let mut year_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut year_map_tokens: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for log in &logs {
            let date = chrono_date(log.timestamp);
            *year_map.entry(date.clone()).or_insert(0) += 1;
            *year_map_tokens.entry(date).or_insert(0) += log.total_tokens.unwrap_or(0);
        }

        let by_provider_model: Vec<serde_json::Value> = provider_model_map.iter().map(|(provider, models)| {
            let models_arr: Vec<serde_json::Value> = models.iter().map(|(model, count)| {
                serde_json::json!({ "model": model, "count": count })
            }).collect();
            serde_json::json!({
                "provider": provider,
                "count": provider_map.get(provider).unwrap_or(&0),
                "models": models_arr
            })
        }).collect();

        let by_provider_tokens: Vec<serde_json::Value> = provider_tokens_map.iter().map(|(provider, total)| {
            serde_json::json!({ "provider": provider, "total": total })
        }).collect();

        let by_model: Vec<serde_json::Value> = model_map.iter().map(|(model, count)| {
            let tokens = model_tokens_map.get(model);
            serde_json::json!({
                "model": model,
                "count": count,
                "tokens": tokens.map(|(t, p, c)| serde_json::json!({ "total": t, "prompt": p, "completion": c }))
            })
        }).collect();

        serde_json::json!({
            "totalRequests": total_requests,
            "totalTokens": total_tokens,
            "totalPromptTokens": total_prompt_tokens,
            "totalCompletionTokens": total_completion_tokens,
            "trend": trend,
            "yearMap": year_map,
            "yearMapTokens": year_map_tokens,
            "byProviderModel": by_provider_model,
            "byProviderTokens": by_provider_tokens,
            "byModel": by_model,
        })
    }

    // --- Build sidecar config payload ---

    pub fn build_proxy_config(&self) -> serde_json::Value {
        let profiles = self.get_profiles();
        let active_ids = self.get_active_profiles();
        let active_profiles: Vec<&Profile> = profiles.iter()
            .filter(|p| active_ids.contains(&p.id))
            .collect();
        let settings = self.get_settings();
        let models = self.get_models();
        let model_mappings = self.get_model_mappings();
        let log_enabled = self.get_log_enabled();

        serde_json::json!({
            "profiles": active_profiles,
            "settings": {
                "port": settings.port,
                "logEnabled": log_enabled,
            },
            "models": models,
            "modelMappings": model_mappings,
        })
    }
}

fn chrono_date(ts_ms: u64) -> String {
    let secs = (ts_ms / 1000) as i64;
    let dt = chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or_default();
    dt.format("%Y-%m-%d").to_string()
}
