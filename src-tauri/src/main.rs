#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod proxy;
mod commands;
mod error;
mod tray;

use std::sync::Arc;
use tauri::Manager;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_autostart::MacosLauncher;

use commands::AppState;
use config::ConfigStore;
use proxy::ProxyManager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // On macOS, hide dock icon to run as menu bar only app
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Clean up old update installers from temp directory
            cleanup_old_installers();

            let config_store = Arc::new(ConfigStore::new());
            let proxy_manager = ProxyManager::new(Arc::clone(&config_store), app.handle().clone());

            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("AIGateway")
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            tray::toggle_panel_window(tray.app_handle());
                        }
                        TrayIconEvent::Click {
                            button: MouseButton::Right,
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
                .build(app)?;

            proxy_manager.set_tray(tray);

            app.manage(AppState {
                config: Arc::clone(&config_store),
                proxy: proxy_manager,
            });

            // Refresh tray stats from a background thread: the first pass ~1s after
            // launch, then every 60s (covers midnight rollover). Tray updates must
            // NOT be dispatched synchronously from the setup callback (which runs on
            // the main thread) because they block on the main-thread event loop.
            {
                let app_handle = app.handle().clone();
                let config_store = Arc::clone(&config_store);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    loop {
                        if config_store.get_settings().tray_stats_enabled {
                            let running = app_handle
                                .state::<AppState>()
                                .proxy
                                .get_status()
                                .status == "running";
                            tray::update_tray_stats(&app_handle, &config_store, running);
                        }
                        std::thread::sleep(std::time::Duration::from_secs(60));
                    }
                });
            }

            // Auto-start proxy if configured
            let settings = config_store.get_settings();
            if settings.auto_start {
                let state = app.state::<AppState>();
                if let Err(e) = state.proxy.start() {
                    eprintln!("Auto-start proxy failed: {}", e);
                }
                // Enable autostart plugin (only if not already enabled, to avoid macOS "background item added" notification)
                use tauri_plugin_autostart::ManagerExt;
                let autostart_manager = app.autolaunch();
                if !autostart_manager.is_enabled().unwrap_or(false) {
                    autostart_manager.enable().ok();
                }
                // Hide window on autostart (run in background)
                if let Some(window) = app.get_webview_window("main") {
                    window.hide().ok();
                }
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
            commands::get_model_entries,
            commands::add_model,
            commands::remove_model,
            commands::get_model_mappings,
            commands::set_model_mappings,
            commands::set_model_strategy,
            commands::get_log_enabled,
            commands::set_log_enabled,
            commands::get_stats,
            commands::get_logs,
            commands::get_log_file_size,
            commands::clear_logs,
            commands::clear_all_data,
            commands::clear_logs_bodies,
            commands::clear_aggregated_stats,
            commands::fetch_provider_models,
            commands::check_for_updates,
            commands::download_and_install_update,
            commands::get_app_version,
            commands::restart_app,
            commands::toggle_devtools,
            commands::set_language,
            commands::check_port,
            commands::kill_process,
            commands::quit_app,
            commands::show_main_window,
            commands::toggle_panel_window,
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Hide to tray instead of closing
                    window.hide().ok();
                    api.prevent_close();
                }
                tauri::WindowEvent::Focused(false) if window.label() == "panel" => {
                    window.hide().ok();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


/// Clean up old update installers from temp directory
fn cleanup_old_installers() {
    let temp_dir = std::env::temp_dir();

    // File patterns to clean up
    let patterns = [
        "AIGateway",
        "aigateway",
    ];

    let extensions = [
        ".dmg", ".msi", ".exe", ".AppImage", ".deb",
        ".msi.zip", ".exe.zip", ".dmg.zip",
    ];

    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let name_str = file_name.to_string_lossy();

            // Check if file matches our patterns
            let is_installer = patterns.iter().any(|p| name_str.starts_with(p))
                && extensions.iter().any(|e| name_str.ends_with(e));

            if is_installer {
                // Try to remove the file, ignore errors (file may be in use)
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
