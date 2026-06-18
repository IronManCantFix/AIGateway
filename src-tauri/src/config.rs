use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
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
pub struct HttpProxyConfig {
    pub enabled: bool,
    pub url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(rename = "excludeProfiles", default)]
    pub exclude_profiles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(rename = "autoStart", default)]
    pub auto_start: bool,
    #[serde(rename = "logEnabled", default)]
    pub log_enabled: bool,
    #[serde(rename = "httpProxy", default)]
    pub http_proxy: Option<HttpProxyConfig>,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_port() -> u16 { 9999 }
fn default_language() -> String { "auto".to_string() }
fn default_theme() -> String { "auto".to_string() }

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: 9999,
            auto_start: false,
            log_enabled: false,
            http_proxy: None,
            language: "auto".to_string(),
            theme: "auto".to_string(),
        }
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

// --- Load Balancer ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadBalancerGroup {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default = "default_lb_strategy")]
    pub strategy: String,
    #[serde(rename = "profileIds", default)]
    pub profile_ids: Vec<String>,
}

fn default_lb_strategy() -> String { "round-robin".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LoadBalancerConfig {
    #[serde(default)]
    pub groups: Vec<LoadBalancerGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: u64,
    pub endpoint: String,
    #[serde(default)]
    pub method: Option<String>,
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
    #[serde(rename = "upstreamUrl", default)]
    pub upstream_url: Option<String>,
    #[serde(default)]
    pub proxy: Option<bool>,
    #[serde(rename = "modelMapping", default)]
    pub model_mapping: Option<String>,
    #[serde(rename = "originalModel", default)]
    pub original_model: Option<String>,
    #[serde(rename = "bodySizeBefore", default)]
    pub body_size_before: Option<u64>,
    #[serde(rename = "bodySizeAfter", default)]
    pub body_size_after: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StatsSnapshot {
    #[serde(default)]
    pub logs: Vec<LogEntry>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LogFilter {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(rename = "statusClass", default)]
    pub status_class: Option<String>,
    #[serde(rename = "dateFrom", default)]
    pub date_from: Option<u64>,
    #[serde(rename = "dateTo", default)]
    pub date_to: Option<u64>,
}

impl LogFilter {
    fn matches(&self, e: &LogEntry) -> bool {
        if let Some(p) = self.provider.as_ref().filter(|s| !s.is_empty()) {
            if !e.provider.eq_ignore_ascii_case(p) {
                return false;
            }
        }
        if let Some(m) = self.model.as_ref().filter(|s| !s.is_empty()) {
            let ml = m.to_lowercase();
            let model_match = e.model.to_lowercase().contains(&ml);
            let orig_match = e.original_model.as_ref()
                .map(|o| o.to_lowercase().contains(&ml))
                .unwrap_or(false);
            if !model_match && !orig_match {
                return false;
            }
        }
        if let Some(sc) = self.status_class.as_ref().filter(|s| !s.is_empty()) {
            let c = e.status_code;
            let ok = match sc.as_str() {
                "2xx" => (200..300).contains(&c),
                "4xx" => (400..500).contains(&c),
                "5xx" => (500..600).contains(&c),
                _ => true,
            };
            if !ok {
                return false;
            }
        }
        if let Some(from) = self.date_from {
            if e.timestamp < from {
                return false;
            }
        }
        if let Some(to) = self.date_to {
            if e.timestamp >= to {
                return false;
            }
        }
        true
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LogsPage {
    pub logs: Vec<LogEntry>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AggregatedStats {
    #[serde(default)]
    pub total_requests: u64,
    #[serde(default)]
    pub total_tokens: u64,
    #[serde(default)]
    pub total_prompt_tokens: u64,
    #[serde(default)]
    pub total_completion_tokens: u64,
    #[serde(default)]
    pub provider_counts: std::collections::HashMap<String, u64>,
    #[serde(default)]
    pub provider_tokens: std::collections::HashMap<String, u64>,
    #[serde(default)]
    pub model_counts: std::collections::HashMap<String, u64>,
    #[serde(default)]
    pub model_tokens: std::collections::HashMap<String, (u64, u64, u64)>,
    #[serde(default)]
    pub provider_model_counts: std::collections::HashMap<String, std::collections::HashMap<String, u64>>,
    #[serde(default)]
    pub daily_counts: std::collections::HashMap<String, u64>,
    #[serde(default)]
    pub daily_tokens: std::collections::HashMap<String, u64>,
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

    // --- Load Balancer Groups ---

    pub fn get_lb_groups(&self) -> Vec<LoadBalancerGroup> {
        let config: LoadBalancerConfig = self.read_json("load-balancer.json");
        config.groups
    }

    fn save_lb_groups(&self, groups: &[LoadBalancerGroup]) -> Result<(), String> {
        let config = LoadBalancerConfig { groups: groups.to_vec() };
        self.write_json("load-balancer.json", &config)
    }

    pub fn add_lb_group(&self, mut group: LoadBalancerGroup) -> Result<LoadBalancerGroup, String> {
        if group.id.is_empty() {
            group.id = uuid::Uuid::new_v4().to_string();
        }
        let mut groups = self.get_lb_groups();
        groups.push(group.clone());
        self.save_lb_groups(&groups)?;
        Ok(group)
    }

    pub fn update_lb_group(&self, id: &str, updates: serde_json::Value) -> Result<LoadBalancerGroup, String> {
        let mut groups = self.get_lb_groups();
        let idx = groups.iter().position(|g| g.id == id)
            .ok_or_else(|| "Load balancer group not found".to_string())?;
        let mut group_json = serde_json::to_value(&groups[idx]).map_err(|e| e.to_string())?;
        if let (Some(obj), Some(upd)) = (group_json.as_object_mut(), updates.as_object()) {
            for (k, v) in upd {
                obj.insert(k.clone(), v.clone());
            }
        }
        let updated: LoadBalancerGroup = serde_json::from_value(group_json).map_err(|e| e.to_string())?;
        groups[idx] = updated.clone();
        self.save_lb_groups(&groups)?;
        Ok(updated)
    }

    pub fn delete_lb_group(&self, id: &str) -> Result<(), String> {
        let mut groups = self.get_lb_groups();
        groups.retain(|g| g.id != id);
        self.save_lb_groups(&groups)
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

    fn logs_jsonl_path(&self) -> PathBuf {
        self.path("logs.jsonl")
    }

    fn read_legacy_logs_filtered(&self, filter: &LogFilter, limit: Option<usize>, offset: Option<usize>) -> LogsPage {
        let snapshot: StatsSnapshot = self.read_json("stats-snapshot.json");
        // 旧存储是按 append 顺序，反转后是最新优先
        let mut entries: Vec<LogEntry> = snapshot.logs.into_iter().rev().collect();
        entries.retain(|e| filter.matches(e));
        let total = entries.len();
        let offset = offset.unwrap_or(0).min(total);
        let limit = limit.unwrap_or(total.saturating_sub(offset));
        let end = (offset + limit).min(total);
        LogsPage { logs: entries[offset..end].to_vec(), total }
    }

    fn read_logs_jsonl_filtered(&self, filter: &LogFilter, limit: Option<usize>, offset: Option<usize>) -> Result<LogsPage, String> {
        let path = self.logs_jsonl_path();
        let file = fs::File::open(&path).map_err(|e| e.to_string())?;
        // 一次读完，按时间倒序（最新在前），再筛选，再分页
        let mut entries: Vec<LogEntry> = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<LogEntry>(&line).ok())
            .collect();
        entries.reverse();
        entries.retain(|e| filter.matches(e));
        let total = entries.len();
        let offset = offset.unwrap_or(0).min(total);
        let limit = limit.unwrap_or(total.saturating_sub(offset));
        let end = (offset + limit).min(total);
        Ok(LogsPage { logs: entries[offset..end].to_vec(), total })
    }

    fn append_log_jsonl(&self, entry: &LogEntry) -> Result<(), String> {
        let path = self.logs_jsonl_path();
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
        writeln!(file, "{}", line).map_err(|e| e.to_string())?;
        self.trim_logs_jsonl_if_large(50 * 1024 * 1024, 5000)
    }

    fn trim_logs_jsonl_if_large(&self, max_bytes: u64, keep_lines: usize) -> Result<(), String> {
        let path = self.logs_jsonl_path();
        let Ok(meta) = fs::metadata(&path) else { return Ok(()); };
        if meta.len() <= max_bytes {
            return Ok(());
        }
        let file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut lines: Vec<String> = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter(|line| !line.trim().is_empty())
            .collect();
        if lines.len() > keep_lines {
            let drain_count = lines.len() - keep_lines;
            lines.drain(0..drain_count);
        }
        let tmp = path.with_extension("jsonl.tmp");
        {
            let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
            for line in lines {
                writeln!(file, "{}", line).map_err(|e| e.to_string())?;
            }
        }
        fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    pub fn get_logs(&self, limit: Option<usize>, offset: Option<usize>, filter: LogFilter) -> LogsPage {
        if self.logs_jsonl_path().exists() {
            return self.read_logs_jsonl_filtered(&filter, limit, offset)
                .unwrap_or(LogsPage { logs: vec![], total: 0 });
        }
        self.read_legacy_logs_filtered(&filter, limit, offset)
    }

    pub fn get_log_file_size(&self) -> u64 {
        let jsonl = self.logs_jsonl_path();
        if let Ok(meta) = fs::metadata(&jsonl) {
            return meta.len();
        }
        let legacy = self.path("stats-snapshot.json");
        if let Ok(meta) = fs::metadata(&legacy) {
            return meta.len();
        }
        0
    }

    pub fn add_log(&self, entry: &LogEntry) -> Result<(), String> {
        self.append_log_jsonl(entry)?;

        // Update aggregated stats
        let mut stats: AggregatedStats = self.read_json("aggregated-stats.json");
        stats.total_requests += 1;
        stats.total_tokens += entry.total_tokens.unwrap_or(0);
        stats.total_prompt_tokens += entry.prompt_tokens.unwrap_or(0);
        stats.total_completion_tokens += entry.completion_tokens.unwrap_or(0);

        let provider = if entry.provider.is_empty() { "-".to_string() } else { entry.provider.clone() };
        let model = if entry.model.is_empty() { "-".to_string() } else { entry.model.clone() };

        *stats.provider_counts.entry(provider.clone()).or_insert(0) += 1;
        *stats.provider_model_counts.entry(provider).or_default().entry(model.clone()).or_insert(0) += 1;
        *stats.model_counts.entry(model.clone()).or_insert(0) += 1;

        if let Some(t) = entry.total_tokens {
            let e = stats.model_tokens.entry(model.clone()).or_insert((0, 0, 0));
            e.0 += t;
            e.1 += entry.prompt_tokens.unwrap_or(0);
            e.2 += entry.completion_tokens.unwrap_or(0);
            // provider_tokens uses the provider key from above (already consumed by provider_counts entry)
            // Re-derive provider string for tokens map
            let prov = if entry.provider.is_empty() { "-" } else { &entry.provider };
            *stats.provider_tokens.entry(prov.to_string()).or_insert(0) += t;
        }

        let date = chrono_date(entry.timestamp);
        *stats.daily_counts.entry(date.clone()).or_insert(0) += 1;
        *stats.daily_tokens.entry(date).or_insert(0) += entry.total_tokens.unwrap_or(0);

        self.write_json("aggregated-stats.json", &stats)
    }

    pub fn clear_logs(&self) -> Result<(), String> {
        fs::remove_file(self.logs_jsonl_path()).ok();
        let snapshot = StatsSnapshot { logs: vec![] };
        self.write_json("stats-snapshot.json", &snapshot)
    }

    pub fn clear_logs_bodies(&self) -> Result<(), String> {
        let path = self.logs_jsonl_path();
        if path.exists() {
            let file = fs::File::open(&path).map_err(|e| e.to_string())?;
            let tmp = path.with_extension("jsonl.tmp");
            {
                let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
                for line in BufReader::new(file).lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(mut entry) = serde_json::from_str::<LogEntry>(&line) {
                        entry.request_body = None;
                        entry.response_body = None;
                        let json = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
                        writeln!(out, "{}", json).map_err(|e| e.to_string())?;
                    }
                }
            }
            return fs::rename(&tmp, &path).map_err(|e| e.to_string());
        }
        let mut snapshot: StatsSnapshot = self.read_json("stats-snapshot.json");
        for log in &mut snapshot.logs {
            log.request_body = None;
            log.response_body = None;
        }
        self.write_json("stats-snapshot.json", &snapshot)
    }

    pub fn clear_all_data(&self) -> Result<(), String> {
        fs::remove_file(self.logs_jsonl_path()).ok();
        fs::remove_file(self.path("stats-snapshot.json")).ok();
        fs::remove_file(self.path("aggregated-stats.json")).ok();
        Ok(())
    }

    pub fn clear_aggregated_stats(&self) -> Result<(), String> {
        fs::remove_file(self.path("aggregated-stats.json")).ok();
        Ok(())
    }

    // --- Stats aggregation ---

    pub fn get_stats(&self) -> serde_json::Value {
        let stats: AggregatedStats = self.read_json("aggregated-stats.json");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let day_ms: u64 = 86400000;
        let mut trend = Vec::new();
        for i in (0..30).rev() {
            let day_end = now - i * day_ms;
            let date = chrono_date(day_end);
            let count = stats.daily_counts.get(&date).copied().unwrap_or(0);
            let tokens = stats.daily_tokens.get(&date).copied().unwrap_or(0);
            trend.push(serde_json::json!({ "date": date, "count": count, "tokens": tokens }));
        }

        let by_provider_model: Vec<serde_json::Value> = stats.provider_model_counts.iter().map(|(provider, models)| {
            let models_arr: Vec<serde_json::Value> = models.iter().map(|(model, count)| {
                serde_json::json!({ "model": model, "count": count })
            }).collect();
            serde_json::json!({
                "provider": provider,
                "count": stats.provider_counts.get(provider).unwrap_or(&0),
                "models": models_arr
            })
        }).collect();

        let by_provider_tokens: Vec<serde_json::Value> = stats.provider_tokens.iter().map(|(provider, total)| {
            serde_json::json!({ "provider": provider, "total": total })
        }).collect();

        let by_model: Vec<serde_json::Value> = stats.model_counts.iter().map(|(model, count)| {
            let tokens = stats.model_tokens.get(model);
            serde_json::json!({
                "model": model,
                "count": count,
                "tokens": tokens.map(|(t, p, c)| serde_json::json!({ "total": t, "prompt": p, "completion": c }))
            })
        }).collect();

        serde_json::json!({
            "totalRequests": stats.total_requests,
            "totalTokens": stats.total_tokens,
            "totalPromptTokens": stats.total_prompt_tokens,
            "totalCompletionTokens": stats.total_completion_tokens,
            "trend": trend,
            "yearMap": stats.daily_counts,
            "yearMapTokens": stats.daily_tokens,
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
        let lb_groups = self.get_lb_groups();

        serde_json::json!({
            "profiles": active_profiles,
            "settings": {
                "port": settings.port,
                "logEnabled": log_enabled,
                "httpProxy": settings.http_proxy,
            },
            "models": models,
            "modelMappings": model_mappings,
            "loadBalancerGroups": lb_groups,
        })
    }
}

fn chrono_date(ts_ms: u64) -> String {
    let secs = (ts_ms / 1000) as i64;
    let dt = chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or_default();
    dt.format("%Y-%m-%d").to_string()
}
