use std::collections::HashMap;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

use crate::config::ConfigStore;
use crate::proxy::ProxyManager;

/// Tray menu string lookup. To avoid bringing full vue-i18n into Rust, this table
/// is a lightweight per-language map of menu-only strings.
pub fn lookup(lang: &str, key: &str) -> String {
    let table = match lang {
        "en-US" => en_us_table(),
        _ => zh_cn_table(),
    };
    table.get(key).copied().unwrap_or(key).to_string()
}

fn zh_cn_table() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::new();
    m.insert("status.running", "代理运行中");
    m.insert("status.stopped", "代理已停止");
    m.insert("toggle.proxy", "启动代理");
    m.insert("toggle.autostart", "开机自启");
    m.insert("toggle.httpProxy", "HTTP 代理");
    m.insert("submenu.providers", "提供商");
    m.insert("submenu.models", "模型");
    m.insert("submenu.modelsEmpty", "模型 (无)");
    m.insert("show", "显示窗口");
    m.insert("quit", "退出");
    m.insert("toast.modelCopied.prefix", "已复制: ");
    m
}

fn en_us_table() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::new();
    m.insert("status.running", "Proxy running");
    m.insert("status.stopped", "Proxy stopped");
    m.insert("toggle.proxy", "Start proxy");
    m.insert("toggle.autostart", "Auto-start on boot");
    m.insert("toggle.httpProxy", "HTTP proxy");
    m.insert("submenu.providers", "Providers");
    m.insert("submenu.models", "Models");
    m.insert("submenu.modelsEmpty", "Models (empty)");
    m.insert("show", "Show window");
    m.insert("quit", "Quit");
    m.insert("toast.modelCopied.prefix", "Copied: ");
    m
}

/// Resolve a Settings.language value ("auto" / "zh-CN" / "en-US") to a concrete locale.
/// "auto" or unknown values fall back via LANG env detection then en-US.
pub fn resolve_language(setting: &str) -> String {
    if setting != "auto" {
        return setting.to_string();
    }
    let raw = std::env::var("LANG").unwrap_or_default().to_lowercase();
    if raw.starts_with("zh") { "zh-CN".to_string() } else { "en-US".to_string() }
}

pub fn build_tray_menu(
    app: &tauri::AppHandle,
    config_store: &ConfigStore,
    proxy_manager: &ProxyManager,
) -> tauri::menu::Menu<tauri::Wry> {
    let settings = config_store.get_settings();
    let lang = resolve_language(&settings.language);

    let status = proxy_manager.get_status();
    let profiles = config_store.get_profiles();
    let active_ids = config_store.get_active_profiles();
    let is_running = status.status == "running";

    let status_text = if is_running {
        lookup(&lang, "status.running")
    } else {
        lookup(&lang, "status.stopped")
    };
    let status_item = MenuItemBuilder::with_id("status", &status_text)
        .enabled(false)
        .build(app)
        .unwrap();

    let port = settings.port;
    let addr_text = format!("http://127.0.0.1:{}", port);
    let addr_item = MenuItemBuilder::with_id("address", &addr_text)
        .enabled(is_running)
        .build(app)
        .unwrap();

    let proxy_toggle = CheckMenuItemBuilder::with_id("toggle_proxy", &lookup(&lang, "toggle.proxy"))
        .checked(is_running)
        .build(app)
        .unwrap();

    let autostart_toggle = CheckMenuItemBuilder::with_id("toggle_autostart", &lookup(&lang, "toggle.autostart"))
        .checked(settings.auto_start)
        .build(app)
        .unwrap();

    let http_proxy_enabled = settings.http_proxy
        .as_ref()
        .map(|p| p.enabled)
        .unwrap_or(false);

    let http_proxy_toggle = CheckMenuItemBuilder::with_id("toggle_http_proxy", &lookup(&lang, "toggle.httpProxy"))
        .checked(http_proxy_enabled)
        .build(app)
        .unwrap();

    let mut profile_items: Vec<tauri::menu::CheckMenuItem<tauri::Wry>> = Vec::new();
    for p in &profiles {
        let item = CheckMenuItemBuilder::with_id(
            format!("profile_{}", p.id),
            &p.name,
        )
        .checked(active_ids.contains(&p.id))
        .build(app)
        .unwrap();
        profile_items.push(item);
    }

    let profiles_submenu = SubmenuBuilder::new(app, &lookup(&lang, "submenu.providers"))
        .items(&profile_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect::<Vec<_>>())
        .build()
        .unwrap();

    let mut all_models: Vec<String> = Vec::new();
    for p in &profiles {
        if active_ids.contains(&p.id) {
            for m in &p.models {
                if !all_models.contains(m) {
                    all_models.push(m.clone());
                }
            }
        }
    }

    let mut model_items: Vec<tauri::menu::MenuItem<tauri::Wry>> = Vec::new();
    for m in &all_models {
        let item = MenuItemBuilder::with_id(
            format!("model_{}", m),
            m,
        )
        .build(app)
        .unwrap();
        model_items.push(item);
    }

    let models_submenu = if all_models.is_empty() {
        SubmenuBuilder::new(app, &lookup(&lang, "submenu.modelsEmpty"))
            .build()
            .unwrap()
    } else {
        SubmenuBuilder::new(app, &lookup(&lang, "submenu.models"))
            .items(&model_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect::<Vec<_>>())
            .build()
            .unwrap()
    };

    let show_item = MenuItemBuilder::with_id("show", &lookup(&lang, "show")).build(app).unwrap();
    let quit_item = MenuItemBuilder::with_id("quit", &lookup(&lang, "quit")).build(app).unwrap();

    MenuBuilder::new(app)
        .item(&status_item)
        .item(&addr_item)
        .separator()
        .item(&proxy_toggle)
        .item(&autostart_toggle)
        .item(&http_proxy_toggle)
        .separator()
        .item(&profiles_submenu)
        .item(&models_submenu)
        .separator()
        .item(&show_item)
        .item(&quit_item)
        .build()
        .unwrap()
}
