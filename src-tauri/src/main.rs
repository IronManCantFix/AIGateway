#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod proxy;
mod commands;

use std::sync::Arc;
use tauri::{Emitter, Listener, Manager};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_clipboard_manager::ClipboardExt;

use commands::AppState;
use config::ConfigStore;
use proxy::ProxyManager;

fn build_tray_menu(app: &tauri::AppHandle, config_store: &ConfigStore, proxy_manager: &ProxyManager) -> tauri::menu::Menu<tauri::Wry> {
    let status = proxy_manager.get_status();
    let settings = config_store.get_settings();
    let profiles = config_store.get_profiles();
    let active_ids = config_store.get_active_profiles();
    let is_running = status.status == "running";

    // 代理状态信息
    let status_text = if is_running {
        "代理运行中".to_string()
    } else {
        "代理已停止".to_string()
    };
    let status_item = MenuItemBuilder::with_id("status", &status_text)
        .enabled(false)
        .build(app)
        .unwrap();

    // 代理地址（运行时显示，点击复制）
    let port = settings.port;
    let addr_text = format!("http://127.0.0.1:{}", port);
    let addr_item = MenuItemBuilder::with_id("address", &addr_text)
        .enabled(is_running)
        .build(app)
        .unwrap();

    // 代理启动/停止开关
    let proxy_toggle = CheckMenuItemBuilder::with_id("toggle_proxy", "启动代理")
        .checked(is_running)
        .build(app)
        .unwrap();

    // 开机自启开关
    let autostart_toggle = CheckMenuItemBuilder::with_id("toggle_autostart", "开机自启")
        .checked(settings.auto_start)
        .build(app)
        .unwrap();

    // 提供商子菜单
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

    let profiles_submenu = SubmenuBuilder::new(app, "提供商")
        .items(&profile_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect::<Vec<_>>())
        .build()
        .unwrap();

    // 从已启用的 profiles 中聚合模型列表
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

    // 模型子菜单
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
        SubmenuBuilder::new(app, "模型 (无)")
            .build()
            .unwrap()
    } else {
        SubmenuBuilder::new(app, "模型")
            .items(&model_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect::<Vec<_>>())
            .build()
            .unwrap()
    };

    // 显示窗口和退出
    let show_item = MenuItemBuilder::with_id("show", "显示窗口").build(app).unwrap();
    let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app).unwrap();

    // 构建完整菜单
    let menu_builder = MenuBuilder::new(app)
        .item(&status_item)
        .item(&addr_item)
        .separator()
        .item(&proxy_toggle)
        .item(&autostart_toggle)
        .separator()
        .item(&profiles_submenu)
        .item(&models_submenu)
        .separator()
        .item(&show_item)
        .item(&quit_item);

    menu_builder.build().unwrap()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            // On macOS, hide dock icon to run as menu bar only app
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let config_store = Arc::new(ConfigStore::new());
            let proxy_manager = ProxyManager::new(Arc::clone(&config_store), app.handle().clone());

            // Build initial tray menu
            let menu = build_tray_menu(app.handle(), &config_store, &proxy_manager);

            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("AIGateway")
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    let event_id = event.id().as_ref();
                    let state = app.state::<AppState>();

                    match event_id {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                window.show().ok();
                                window.set_focus().ok();
                            }
                        }
                        "quit" => {
                            state.proxy.stop().ok();
                            app.exit(0);
                        }
                        "toggle_proxy" => {
                            let status = state.proxy.get_status();
                            if status.status == "running" {
                                state.proxy.stop().ok();
                            } else {
                                state.proxy.start().ok();
                            }
                            // Rebuild menu to update state
                            rebuild_tray_menu(app, &state);
                        }
                        "toggle_autostart" => {
                            let mut settings = state.config.get_settings();
                            settings.auto_start = !settings.auto_start;
                            state.config.set_settings(&settings).ok();
                            // Enable/disable autostart using plugin
                            use tauri_plugin_autostart::ManagerExt;
                            let autostart_manager = app.autolaunch();
                            if settings.auto_start {
                                autostart_manager.enable().ok();
                            } else {
                                autostart_manager.disable().ok();
                            }
                            // Rebuild menu to update state
                            rebuild_tray_menu(app, &state);
                        }
                        "address" => {
                            let status = state.proxy.get_status();
                            let addr = format!("http://127.0.0.1:{}", status.port);
                            // Use clipboard plugin
                            app.clipboard().write_text(addr).ok();
                        }
                        id if id.starts_with("profile_") => {
                            let profile_id = &id[8..]; // Remove "profile_" prefix
                            let active_ids = state.config.get_active_profiles();
                            let is_active = active_ids.contains(&profile_id.to_string());
                            let mut new_ids = active_ids;
                            if is_active {
                                new_ids.retain(|i| i != profile_id);
                            } else {
                                new_ids.push(profile_id.to_string());
                            }
                            state.config.set_active_profiles(&new_ids).ok();
                            // Reload proxy if running
                            if state.proxy.get_status().status == "running" {
                                state.proxy.reload().ok();
                            }
                            // Rebuild menu to update state
                            rebuild_tray_menu(app, &state);
                            // Notify frontend to refresh data
                            app.emit("refresh-data", ()).ok();
                        }
                        id if id.starts_with("model_") => {
                            let model_id = &id[6..]; // Remove "model_" prefix
                            app.clipboard().write_text(model_id.to_string()).ok();
                            // Notify frontend to show toast
                            app.emit("show-toast", format!("已复制: {}", model_id)).ok();
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                window.show().ok();
                                window.set_focus().ok();
                            }
                        }
                        _ => {}
                    }
                })
                .show_menu_on_left_click(true)
                .build(app)?;

            proxy_manager.set_tray(tray);

            app.manage(AppState {
                config: Arc::clone(&config_store),
                proxy: proxy_manager,
            });

            // Listen for proxy status changes and rebuild tray menu
            let app_handle = app.handle().clone();
            app.listen("proxy-status-changed", move |_event| {
                let state = app_handle.state::<AppState>();
                rebuild_tray_menu(&app_handle, &state);
            });

            // Listen for tray menu update events (provider/profile changes)
            let app_handle = app.handle().clone();
            app.listen("tray-menu-update", move |_event| {
                let state = app_handle.state::<AppState>();
                rebuild_tray_menu(&app_handle, &state);
            });

            // Auto-start proxy if configured
            let settings = config_store.get_settings();
            if settings.auto_start {
                let state = app.state::<AppState>();
                if let Err(e) = state.proxy.start() {
                    eprintln!("Auto-start proxy failed: {}", e);
                }
                // Enable autostart plugin
                use tauri_plugin_autostart::ManagerExt;
                let autostart_manager = app.autolaunch();
                autostart_manager.enable().ok();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_proxy,
            commands::stop_proxy,
            commands::get_proxy_status,
            commands::get_profiles,
            commands::add_profile,
            commands::update_profile,
            commands::delete_profile,
            commands::get_active_profiles,
            commands::set_active_profiles,
            commands::toggle_profile,
            commands::reorder_profiles,
            commands::get_settings,
            commands::set_settings,
            commands::get_models,
            commands::add_model,
            commands::remove_model,
            commands::get_model_mappings,
            commands::set_model_mappings,
            commands::get_log_enabled,
            commands::set_log_enabled,
            commands::get_stats,
            commands::get_logs,
            commands::clear_logs,
            commands::clear_all_data,
            commands::clear_logs_bodies,
            commands::clear_aggregated_stats,
            commands::fetch_provider_models,
            commands::check_for_updates,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Hide to tray instead of closing
                window.hide().ok();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn rebuild_tray_menu(app: &tauri::AppHandle, state: &AppState) {
    let menu = build_tray_menu(app, &state.config, &state.proxy);
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu)).ok();
    }
}
