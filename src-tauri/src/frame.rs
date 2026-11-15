//! 窗口外框（圆角 + 明暗）交给系统，前端不再自绘窗口边框。
//!
//! Windows 11：圆角由 DWM 画（`DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND`），
//! 描边与圆角抗锯齿的配色由 `DWMWA_USE_IMMERSIVE_DARK_MODE` 决定。应用是深色界面
//! 却没告诉 DWM，DWM 会按浅色画那圈 1px 描边 —— 这就是圆角处「白边」的根因。
//! 成因与取证见 `docs/design/ui-spec.md` §5.3。
//!
//! macOS：窗口用系统装饰（`titleBarStyle: Overlay`），圆角本来就由 AppKit 画，这里不做事。
//! Linux：X11 下没有系统圆角，保持直角；Wayland 由合成器决定，不做自绘（见规范）。

use tauri::WebviewWindow;

/// `DWMWA_USE_IMMERSIVE_DARK_MODE`
const ATTR_DARK: u32 = 20;
/// `DWMWA_WINDOW_CORNER_PREFERENCE`
const ATTR_CORNER: u32 = 33;
/// `DWMWA_BORDER_COLOR`
const ATTR_BORDER: u32 = 34;
/// `DWMWCP_ROUND`
const CORNER_ROUND: i32 = 2;

#[cfg(windows)]
fn set_attr(window: &WebviewWindow, attr: u32, value: i32) -> bool {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    let Ok(raw) = window.hwnd() else {
        return false;
    };
    let hwnd = raw.0 as windows_sys::Win32::Foundation::HWND;
    let hr = unsafe {
        DwmSetWindowAttribute(hwnd, attr, &value as *const i32 as *const core::ffi::c_void, 4)
    };
    hr >= 0
}

/// 窗口创建后调用：显式声明圆角交给 DWM，不依赖系统默认值。
pub fn init(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        if !set_attr(window, ATTR_CORNER, CORNER_ROUND) {
            tracing::warn!(target: "window", "frame: corner preference not applied");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
    }
}

/// 主题切换时调用：让 DWM 按同一明暗绘制窗口描边与圆角。
/// `border` 取 CSS 的 `--border` 十六进制值，保证窗口最外那圈 1px 与界面内分隔线同色。
pub fn set_theme(window: &WebviewWindow, dark: bool, border: Option<&str>) {
    #[cfg(windows)]
    {
        let value = i32::from(dark);
        if !set_attr(window, ATTR_DARK, value) {
            tracing::warn!(target: "window", "frame: immersive dark mode not applied");
        }
        if let Some(color) = border.and_then(colorref) {
            if !set_attr(window, ATTR_BORDER, color) {
                tracing::warn!(target: "window", "frame: border color not applied");
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, dark, border);
    }
}

/// `#rrggbb` → COLORREF（`0x00BBGGRR`，按 i32 传）。
#[cfg(windows)]
fn colorref(hex: &str) -> Option<i32> {
    let s = hex.trim().trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    let r = i32::from_str_radix(&s[0..2], 16).ok()?;
    let g = i32::from_str_radix(&s[2..4], 16).ok()?;
    let b = i32::from_str_radix(&s[4..6], 16).ok()?;
    Some((b << 16) | (g << 8) | r)
}
