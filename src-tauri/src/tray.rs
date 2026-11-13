//! 系统托盘：图标、菜单、左键/右键交互、退出语义。
//!
//! 设计口径：
//! - 默认**不驻留**：关闭窗口仍走原来的退出路径；只有设置里勾了
//!   「关闭窗口时最小化到托盘」才会在关闭时隐藏窗口（见 `hide_to_tray`）。
//! - 左键单击 / 双击 = 显示并前移窗口（不做单击切换显隐，避免误触）；
//!   右键 = 菜单（`show_menu_on_left_click(false)`）。
//! - 菜单里的「退出」与主窗口关闭走同一条清理路径：先给每个 SSH 会话发
//!   `Ctrl::Close`（优雅断开），再 `app.exit(0)`，`lifecycle.log` 记 `reason=tray_quit`。
//! - 托盘图标按**系统主题**选深浅两版（浅色任务栏配深色图标，反之），
//!   图标由品牌图派生，尺寸 16/24/32/48。

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::app::AppState;
use crate::lifecycle;
use crate::session::Ctrl;
use crate::settings::SettingsStore;

const TRAY_ID: &str = "shellora";
const ID_SHOW_HIDE: &str = "show_hide";
const ID_NEW_CONNECTION: &str = "new_connection";
const ID_QUIT: &str = "quit";
const ID_SESSION_PREFIX: &str = "session:";
/// 首次驻留时让应用内提示可见的停留时间（毫秒）。
const FIRST_HIDE_HINT_MS: u64 = 1_400;
/// 退出前给 SSH 优雅断开留出的时间（毫秒）。
const QUIT_GRACE_MS: u64 = 400;

const ICON_LIGHT: [&[u8]; 4] = [
    include_bytes!("../icons/tray/tray-light-16.png"),
    include_bytes!("../icons/tray/tray-light-24.png"),
    include_bytes!("../icons/tray/tray-light-32.png"),
    include_bytes!("../icons/tray/tray-light-48.png"),
];
const ICON_DARK: [&[u8]; 4] = [
    include_bytes!("../icons/tray/tray-dark-16.png"),
    include_bytes!("../icons/tray/tray-dark-24.png"),
    include_bytes!("../icons/tray/tray-dark-32.png"),
    include_bytes!("../icons/tray/tray-dark-48.png"),
];

/// 前端同步过来的一个活动会话（用于菜单与 tooltip）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySession {
    pub key: String,
    pub label: String,
    pub state: String,
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Clone, Default)]
struct Model {
    sessions: Vec<TraySession>,
    connected: Option<String>,
}

#[derive(Default)]
pub struct TrayState {
    model: Mutex<Model>,
}

fn model(app: &AppHandle) -> Model {
    app.state::<TrayState>()
        .model
        .lock()
        .map(|m| m.clone())
        .unwrap_or_default()
}

fn tooltip(model: &Model) -> String {
    let status = match &model.connected {
        Some(target) => crate::i18n::t_args("已连接 {who}", &[("who", target)]),
        None => crate::i18n::t("未连接"),
    };
    format!("Shellora — {status}")
}

/// 选中与当前缩放接近的那一档位图（16/24/32/48），避免系统缩放糊成一团。
fn tray_image(app: &AppHandle, dark_taskbar: bool) -> Option<tauri::image::Image<'static>> {
    let scale = app
        .get_webview_window("main")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let target = (16.0 * scale).round() as i32;
    let set = if dark_taskbar { ICON_LIGHT } else { ICON_DARK };
    let idx = match target {
        0..=19 => 0,
        20..=27 => 1,
        28..=39 => 2,
        _ => 3,
    };
    [idx, 2, 3, 1, 0]
        .iter()
        .find_map(|i| tauri::image::Image::from_bytes(set[*i]).ok())
}

fn system_is_dark(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.theme().ok())
        .map(|t| t == tauri::Theme::Dark)
        .unwrap_or(false)
}

/// 按当前系统主题刷新图标（系统在深浅之间切换时由窗口事件触发）。
pub fn refresh_icon(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Some(icon) = tray_image(app, system_is_dark(app)) {
            let _ = tray.set_icon(Some(icon));
        }
    }
}

fn build_menu(app: &AppHandle, model: &Model) -> tauri::Result<Menu<tauri::Wry>> {
    let toggle = MenuItem::with_id(
        app,
        ID_SHOW_HIDE,
        crate::i18n::t("显示/隐藏主窗口"),
        true,
        None::<&str>,
    )?;
    let new_connection = MenuItem::with_id(
        app,
        ID_NEW_CONNECTION,
        crate::i18n::t("新建连接"),
        true,
        None::<&str>,
    )?;

    let mut session_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    if model.sessions.is_empty() {
        session_items.push(MenuItem::with_id(
            app,
            "session_none",
            crate::i18n::t("（暂无活动会话）"),
            false,
            None::<&str>,
        )?);
    } else {
        for s in &model.sessions {
            let text = if s.active {
                format!("● {}", s.label)
            } else {
                format!("   {}", s.label)
            };
            session_items.push(MenuItem::with_id(
                app,
                format!("{ID_SESSION_PREFIX}{}", s.key),
                text,
                true,
                None::<&str>,
            )?);
        }
    }
    let session_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = session_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    let sessions = Submenu::with_items(app, crate::i18n::t("活动会话"), true, &session_refs)?;

    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        ID_QUIT,
        crate::i18n::t("退出 Shellora"),
        true,
        None::<&str>,
    )?;
    Menu::with_items(app, &[&toggle, &new_connection, &sessions, &sep, &quit])
}

fn apply_model(app: &AppHandle) {
    let model = model(app);
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    if let Ok(menu) = build_menu(app, &model) {
        // 菜单被替换后由 Tauri 持有，不需要额外缓存。
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(tooltip(&model)));
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    if let Some(saved) = app.state::<SettingsStore>().get().locale {
        crate::i18n::set(&saved);
    }
    let menu = build_menu(app, &Model::default())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(&Model::default()))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().0.as_str()))
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    lifecycle::note("tray.show");
                    show_window(app);
                }
                _ => {}
            }
        });
    if let Some(icon) = tray_image(app, system_is_dark(app)) {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_window(app: &AppHandle) {
    let visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        lifecycle::note("tray.hide");
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    } else {
        lifecycle::note("tray.show");
        show_window(app);
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        ID_SHOW_HIDE => toggle_window(app),
        ID_NEW_CONNECTION => {
            lifecycle::note("tray.new_connection");
            show_window(app);
            let _ = app.emit("tray://new-connection", ());
        }
        ID_QUIT => quit(app),
        other => {
            if let Some(key) = other.strip_prefix(ID_SESSION_PREFIX) {
                lifecycle::note("tray.activate_session");
                show_window(app);
                let _ = app.emit("tray://activate-session", key.to_string());
            }
        }
    }
}

/// 关闭窗口时驻留：首次多留 1.4s 让应用内提示可见，之后直接隐藏。
pub fn hide_to_tray(app: &AppHandle) {
    let store = app.state::<SettingsStore>();
    let first = !store.get().tray_hint_shown;
    if first {
        store.mark_hint_shown();
    }
    lifecycle::note("window.hide_to_tray");
    let _ = app.emit("tray://hidden", serde_json::json!({ "first": first }));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if first {
            tokio::time::sleep(Duration::from_millis(FIRST_HIDE_HINT_MS)).await;
        }
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.hide();
        }
    });
}

/// 与主窗口关闭相同的清理语义：优雅关闭全部 SSH 会话，再正常退出。
fn quit(app: &AppHandle) {
    lifecycle::set_reason("tray_quit");
    lifecycle::note("tray.quit");
    for entry in app.state::<AppState>().sessions.all() {
        if let Ok(channels) = entry.channels.lock() {
            let _ = channels.ctrl_tx.try_send(Ctrl::Close);
        }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(QUIT_GRACE_MS)).await;
        handle.exit(0);
    });
}

// ---- 供 IPC 命令调用的入口 ----

pub fn sync(app: &AppHandle, sessions: Vec<TraySession>, connected: Option<String>) {
    let state = app.state::<TrayState>();
    if let Ok(mut guard) = state.model.lock() {
        *guard = Model {
            sessions,
            connected,
        };
    }
    apply_model(app);
}

pub fn settings_snapshot(app: &AppHandle) -> (bool, bool) {
    let s = app.state::<SettingsStore>().get();
    (s.close_to_tray, s.tray_hint_shown)
}

pub fn set_close_to_tray(app: &AppHandle, value: bool) {
    app.state::<SettingsStore>().set_close_to_tray(value);
}

/// 语言切换后重建菜单与提示（前端调用 `set_locale` 时触发）。
pub fn refresh_language(app: &AppHandle) {
    apply_model(app);
}
