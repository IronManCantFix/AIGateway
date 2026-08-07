use std::collections::HashMap;
use std::sync::Mutex;
use tauri::tray::TrayIcon;

use crate::config::ConfigStore;

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
    m.insert("tray.todayTooltip", "今日调用 {count} 次 · Token {tokens}");
    m
}

fn en_us_table() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::new();
    m.insert("tray.todayTooltip", "Today: {count} calls · {tokens} tokens");
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

/// Compact token formatting matching the frontend's fmtTok (e.g. 1.5K / 2.3M).
pub fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        let v = n as f64 / 1_000_000.0;
        if v >= 10.0 { format!("{:.0}M", v) } else { format!("{:.1}M", v) }
    } else if n >= 1_000 {
        let v = n as f64 / 1_000.0;
        if v >= 10.0 { format!("{:.0}K", v) } else { format!("{:.1}K", v) }
    } else {
        n.to_string()
    }
}

/// Last stats rendered into the tray icon, used to skip redundant rebuilds.
static LAST_TRAY_STATS: Mutex<Option<(u64, u64)>> = Mutex::new(None);

fn set_status_icon(tray: &TrayIcon, running: bool) {
    let bytes: &[u8] = if running {
        include_bytes!("../icons/icon-running.png")
    } else {
        include_bytes!("../icons/icon-stopped.png")
    };
    if let Ok(img) = tauri::image::Image::from_bytes(bytes) {
        // Atomically swap back to the non-template status logo
        tray.set_icon_with_as_template(Some(img), false).ok();
    }
}

/// 5x7 bitmap font (digits, K/M suffix, decimal dot) used for the compact
/// two-line tray icon. Each entry is 5 columns x 7 rows packed as bytes.
fn glyph(c: char) -> Option<[u8; 7]> {
    match c {
        '0' => Some([0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110]),
        '1' => Some([0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110]),
        '2' => Some([0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111]),
        '3' => Some([0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110]),
        '4' => Some([0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010]),
        '5' => Some([0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110]),
        '6' => Some([0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110]),
        '7' => Some([0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000]),
        '8' => Some([0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110]),
        '9' => Some([0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100]),
        'K' => Some([0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001]),
        'M' => Some([0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001]),
        '.' => Some([0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00110, 0b00110]),
        _ => None,
    }
}

/// Premultiplied-alpha bilinear resize of the logo, pasted at (dst_x, 0).
/// The alpha-aware interpolation avoids dark fringes on transparent edges.
fn paste_resized_logo(dst: &mut [u8], dst_w: usize, dst_x: usize, src: &[u8], src_w: usize, src_h: usize, dst_h: usize) {
    for dy in 0..dst_h {
        let sy = (dy as f64 + 0.5) * src_h as f64 / dst_h as f64 - 0.5;
        let y0 = if sy < 0.0 { 0 } else { sy.floor() as usize };
        let y1 = (y0 + 1).min(src_h - 1);
        let wy = (sy - y0 as f64).clamp(0.0, 1.0);
        for dx in 0..dst_h {
            let sx = (dx as f64 + 0.5) * src_w as f64 / dst_h as f64 - 0.5;
            let x0 = if sx < 0.0 { 0 } else { sx.floor() as usize };
            let x1 = (x0 + 1).min(src_w - 1);
            let wx = (sx - x0 as f64).clamp(0.0, 1.0);
            let p00 = (y0 * src_w + x0) * 4;
            let p01 = (y0 * src_w + x1) * 4;
            let p10 = (y1 * src_w + x0) * 4;
            let p11 = (y1 * src_w + x1) * 4;
            let w00 = (1.0 - wx) * (1.0 - wy);
            let w01 = wx * (1.0 - wy);
            let w10 = (1.0 - wx) * wy;
            let w11 = wx * wy;
            let alpha = src[p00 + 3] as f64 * w00
                + src[p01 + 3] as f64 * w01
                + src[p10 + 3] as f64 * w10
                + src[p11 + 3] as f64 * w11;
            let out = (dy * dst_w + dst_x + dx) * 4;
            if alpha <= 0.0 {
                dst[out + 3] = 0;
                continue;
            }
            for c in 0..3 {
                let v = src[p00 + c] as f64 * src[p00 + 3] as f64 * w00
                    + src[p01 + c] as f64 * src[p01 + 3] as f64 * w01
                    + src[p10 + c] as f64 * src[p10 + 3] as f64 * w10
                    + src[p11 + c] as f64 * src[p11 + 3] as f64 * w11;
                dst[out + c] = (v / alpha).round() as u8;
            }
            dst[out + 3] = alpha.round() as u8;
        }
    }
}

/// Render today's stats as a tray icon image that keeps the colored status logo
/// on the left and shows two lines of small black text on the right: top line =
/// call count, bottom line = tokens. The 5x7 bitmap glyphs are drawn at 1x with
/// thin 1px strokes on an 18px-tall canvas (displayed at 18pt), so the text
/// stays the same size but looks finer than a 2x-scaled pixel font.
fn render_stats_icon(count: &str, tokens: &str, running: bool) -> tauri::image::Image<'static> {
    const H: usize = 18;   // canvas height == displayed points (menu bar height)
    const LOGO_H: usize = 18; // logo resized to fill the canvas height
    const GAP: usize = 5;  // gap between logo and text
    const PITCH: usize = 6; // 5px glyph + 1px tracking

    let logo_bytes: &[u8] = if running {
        include_bytes!("../icons/icon-running.png")
    } else {
        include_bytes!("../icons/icon-stopped.png")
    };
    let line1 = count.chars().map(|c| glyph(c).unwrap_or([0; 7])).collect::<Vec<_>>();
    let line2 = tokens.chars().map(|c| glyph(c).unwrap_or([0; 7])).collect::<Vec<_>>();
    let text_w1 = line1.len().saturating_mul(PITCH).saturating_sub(1);
    let text_w2 = line2.len().saturating_mul(PITCH).saturating_sub(1);
    let text_w = text_w1.max(text_w2);
    let w = LOGO_H + GAP + text_w;
    let mut rgba = vec![0u8; H * w * 4];

    if let Ok(logo) = tauri::image::Image::from_bytes(logo_bytes) {
        let lpx = logo.rgba();
        let src_w = logo.width() as usize;
        let src_h = logo.height() as usize;
        paste_resized_logo(&mut rgba, w, 0, lpx, src_w, src_h, LOGO_H);
    }

    if text_w == 0 { return tauri::image::Image::new_owned(rgba, w as u32, H as u32); }

    let text_x0 = LOGO_H + GAP;

    // Draw a left-aligned line of 5x7 glyphs (1x, thin strokes) in solid black.
    let draw_line = |rgba: &mut [u8], glyphs: &[[u8; 7]], y_top: usize| {
        let x_base = text_x0;
        for (gi, g) in glyphs.iter().enumerate() {
            for row in 0..7 {
                let bits = g[row];
                for col in 0..5 {
                    if bits & (1 << (4 - col)) == 0 { continue; }
                    let x = x_base + gi * PITCH + col;
                    let y = y_top + row;
                    if x < w && y < H {
                        let idx = (y * w + x) * 4;
                        rgba[idx] = 0;
                        rgba[idx + 1] = 0;
                        rgba[idx + 2] = 0;
                        rgba[idx + 3] = 255;
                    }
                }
            }
        }
    };

    draw_line(&mut rgba, &line1, 1);  // rows 1..7
    draw_line(&mut rgba, &line2, 10); // rows 10..16 (2px gap between lines)

    tauri::image::Image::new_owned(rgba, w as u32, H as u32)
}

/// Show today's call count and tokens in the tray icon when the
/// `trayStatsEnabled` setting is on: a small two-line icon (count on top,
/// tokens below). Restores the status logo otherwise. `running` selects the
/// running/stopped logo when the stats icon is not in use.
pub fn update_tray_stats(app: &tauri::AppHandle, config_store: &ConfigStore, running: bool) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let settings = config_store.get_settings();
    if !settings.tray_stats_enabled {
        // Only touch the icon when we were showing the stats icon before
        if LAST_TRAY_STATS.lock().unwrap().take().is_some() {
            set_status_icon(&tray, running);
            tray.set_title(None::<&str>).ok();
            tray.set_tooltip(Some("AIGateway")).ok();
        }
        return;
    }
    let (count, tokens) = config_store.get_today_stats();
    {
        let mut last = LAST_TRAY_STATS.lock().unwrap();
        if *last == Some((count, tokens)) { return; }
        *last = Some((count, tokens));
    }
    let lang = resolve_language(&settings.language);
    let count_str = count.to_string();
    let tok_str = fmt_tokens(tokens);
    // Compact numbers on the icon keep it narrow; the tooltip keeps exact values
    let icon = render_stats_icon(&fmt_tokens(count), &tok_str, running);
    // Not a template: keeps the colored logo and the black text as-is
    tray.set_icon_with_as_template(Some(icon), false).ok();
    tray.set_title(None::<&str>).ok();
    let tooltip = lookup(&lang, "tray.todayTooltip")
        .replace("{count}", &count_str)
        .replace("{tokens}", &tok_str);
    tray.set_tooltip(Some(tooltip)).ok();
}

/// 显示/隐藏面板窗口；显示时定位在托盘图标正下方，取不到图标位置时退化为
/// 主显示器右上角（菜单栏下方）。
pub fn toggle_panel_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("panel") else { return };
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    let outer = window
        .outer_size()
        .unwrap_or(tauri::PhysicalSize::new(360, 560));
    let win_w = outer.width as i32;

    let mut target: Option<(i32, i32)> = None;
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(Some(rect)) = tray.rect() {
            if let (tauri::Position::Physical(pos), tauri::Size::Physical(sz)) =
                (rect.position, rect.size)
            {
                // Linux 上 rect() 可能返回全屏区域，需排除；仅 macOS/Windows 使用图标矩形
                if sz.width < 800 && sz.height < 800 {
                    target = Some((
                        pos.x + sz.width as i32 / 2 - win_w / 2,
                        pos.y + sz.height as i32 + 4,
                    ));
                }
            }
        }
    }
    let (x, y) = match target {
        Some((x, y)) => (x, y),
        None => {
            if let Some(monitor) = app.primary_monitor().ok().flatten() {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                let margin = (16.0 * scale) as i32;
                (
                    size.width as i32 - win_w - margin,
                    (30.0 * scale) as i32, // 菜单栏下方
                )
            } else {
                (0, 0)
            }
        }
    };
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = window.show();
    let _ = window.set_focus();
}
