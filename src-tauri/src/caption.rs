//! 自绘标题栏的 Windows 原生命中测试。
//!
//! `decorations: false` 时 WebView 拿不到拖动语义，早先前端只能用 `startDragging()`
//! 模拟拖动，代价是 Win11 悬停「最大化」时的贴靠布局弹不出来（它只认系统
//! `HTMAXBUTTON` 命中）。这里在窗口 WndProc 上做一层命中覆盖：
//!
//! - 标题栏空白拖拽区 → `HTCAPTION`：系统自己跑非客户区拖动循环，
//!   于是 Win11 贴靠、Aero Snap、拖到顶部最大化、拖动中 WndProc 的窗口管理全部回归；
//! - 最大化按钮 → `HTMAXBUTTON`：系统据此在悬停时弹出贴靠布局；
//! - 其余位置不响应，原样交给 Tauri/tao 的 WndProc，WebView 照常收到鼠标事件。
//!
//! 区域由前端量测后通过 `window_caption_regions` 下发（CSS 像素 + devicePixelRatio），
//! 因为按钮、标签的横向占位只有 DOM 知道。

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, GetWindowLongW, IsZoomed, PostMessageW, SendMessageW, SetWindowLongPtrW,
    SetWindowPos, GWLP_WNDPROC, GWL_STYLE, HTCAPTION, HTMAXBUTTON, SC_MAXIMIZE, SC_RESTORE,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_NCHITTEST,
    WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SYSCOMMAND, WNDPROC,
    WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
};

/// 标题栏事件：最大化按钮的悬停/按下（HTMAXBUTTON 区域拿不到 DOM 鼠标事件，只能由这里转发）。
#[derive(Clone, serde::Serialize)]
pub struct CaptionEvent {
    pub hover: bool,
    pub press: bool,
}

#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn from(v: [f64; 4]) -> Self {
        Self {
            x: v[0],
            y: v[1],
            w: v[2],
            h: v[3],
        }
    }

    fn hit(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

struct State {
    caption: Vec<Rect>,
    maxbutton: Option<Rect>,
    scale: f64,
}

static STATE: Mutex<State> = Mutex::new(State {
    caption: Vec::new(),
    maxbutton: None,
    scale: 1.0,
});
static OLD_PROC: AtomicIsize = AtomicIsize::new(0);
static HOVER: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 由前端下发命中区域：`caption` 为可直接拖动的矩形，`maxbutton` 为最大化按钮。
pub fn set_regions(caption: Vec<[f64; 4]>, maxbutton: Option<[f64; 4]>, scale: f64) {
    if let Ok(mut state) = STATE.lock() {
        state.caption = caption.into_iter().take(96).map(Rect::from).collect();
        state.maxbutton = maxbutton.map(Rect::from);
        state.scale = if scale.is_finite() && scale > 0.25 { scale } else { 1.0 };
    }
}

/// 接管主窗口的消息处理。必须在窗口创建之后调用。
pub fn attach(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!(target: "window", "caption: main window not found");
        return;
    };
    let Ok(raw) = window.hwnd() else {
        tracing::warn!(target: "window", "caption: hwnd unavailable");
        return;
    };
    let hwnd = raw.0 as HWND;

    unsafe {
        // 贴靠布局要求窗口本身可最大化/可缩放；无边框窗口仍带这些 style 位时才认。
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let want = (WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX | WS_SYSMENU) as i32;
        if style & want != want {
            SetWindowLongPtrW(hwnd, GWL_STYLE, (style | want) as isize);
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            tracing::info!(target: "window", "caption: style patched {style:#x} -> {:#x}", style | want);
        }
        let prev = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, wndproc as *const () as usize as isize);
        OLD_PROC.store(prev, Ordering::Relaxed);
        tracing::info!(target: "window", "caption: hit-test installed");
    }
}

/// 屏幕坐标（lParam 打包）→ 客户端 CSS 像素下的命中判断。
unsafe fn hit_at(hwnd: HWND, lparam: LPARAM) -> Option<u32> {
    let packed = lparam as i32;
    let mut pt = POINT {
        x: (packed & 0xffff) as u16 as i16 as i32,
        y: ((packed >> 16) & 0xffff) as u16 as i16 as i32,
    };
    if ScreenToClient(hwnd, &mut pt) == 0 {
        return None;
    }
    let state = STATE.lock().ok()?;
    let scale = state.scale;
    let x = pt.x as f64 / scale;
    let y = pt.y as f64 / scale;
    if let Some(mb) = state.maxbutton {
        if mb.hit(x, y) {
            return Some(HTMAXBUTTON);
        }
    }
    if state.caption.iter().any(|r| r.hit(x, y)) {
        return Some(HTCAPTION);
    }
    None
}

unsafe fn toggle_maximize(hwnd: HWND) {
    let cmd = if IsZoomed(hwnd) != 0 { SC_RESTORE } else { SC_MAXIMIZE };
    PostMessageW(hwnd, WM_SYSCOMMAND, cmd as WPARAM, 0);
}

fn emit(event: CaptionEvent) {
    if let Some(app) = APP.get() {
        let _ = app.emit("shellora://caption", event);
    }
}

fn sync_hover(hover: bool) {
    if HOVER.swap(hover, Ordering::Relaxed) != hover {
        emit(CaptionEvent { hover, press: false });
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_NCHITTEST => {
            if let Some(hit) = hit_at(hwnd, lparam) {
                // 命中测试本身就跟鼠标位置同步，用它维护悬停态比 WM_NCMOUSEMOVE 更可靠
                sync_hover(hit == HTMAXBUTTON);
                return hit as LRESULT;
            }
            sync_hover(false);
        }
        WM_NCLBUTTONDOWN => {
            if wparam as u32 == HTMAXBUTTON {
                emit(CaptionEvent { hover: true, press: true });
                toggle_maximize(hwnd);
                return 0;
            }
        }
        WM_NCLBUTTONDBLCLK => {
            // 双击标题栏：系统默认只在有原生标题栏时才切换最大化，这里自己切一次，
            // 且返回 0 阻断 DefWindowProc 的二次处理。
            if wparam as u32 == HTCAPTION {
                toggle_maximize(hwnd);
                return 0;
            }
        }
        WM_NCMOUSEMOVE => {
            sync_hover(hit_at(hwnd, lparam) == Some(HTMAXBUTTON));
        }
        WM_NCMOUSELEAVE => {
            sync_hover(false);
        }
        _ => {}
    }
    let old = OLD_PROC.load(Ordering::Relaxed);
    if old == 0 {
        return 0;
    }
    let prev: WNDPROC = std::mem::transmute::<isize, WNDPROC>(old);
    CallWindowProcW(prev, hwnd, msg, wparam, lparam)
}

/// 供验证读取真实 WndProc 的命中结果：把客户端 CSS 坐标换算成屏幕坐标后
/// `SendMessage(WM_NCHITTEST)`，走的是与鼠标完全相同的消息链。
pub fn probe_native(window: &tauri::WebviewWindow, x_css: f64, y_css: f64, scale: f64) -> String {
    let Ok(raw) = window.hwnd() else {
        return "no-hwnd".into();
    };
    let hwnd = raw.0 as HWND;
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    unsafe {
        let mut pt = POINT {
            x: (x_css * scale).round() as i32,
            y: (y_css * scale).round() as i32,
        };
        if ClientToScreen(hwnd, &mut pt) == 0 {
            return "screen-map-failed".into();
        }
        let lp = (((pt.y as i32) << 16) | ((pt.x as i32) & 0xffff)) as LPARAM;
        let hit = SendMessageW(hwnd, WM_NCHITTEST, 0, lp);
        match hit as u32 {
            HTCAPTION => "HTCAPTION".into(),
            HTMAXBUTTON => "HTMAXBUTTON".into(),
            1 => "HTCLIENT".into(),
            other => format!("HT{other}"),
        }
    }
}

/// 调试用：报告窗口 style 与命中区域数量。
pub fn snapshot(window: &tauri::WebviewWindow) -> String {
    let Ok(raw) = window.hwnd() else {
        return "no-hwnd".into();
    };
    let hwnd = raw.0 as HWND;
    let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) };
    let state = STATE.lock().map(|s| (s.caption.len(), s.maxbutton.is_some(), s.scale)).unwrap_or((0, false, 0.0));
    format!(
        "style={style:#x} thick={} maxbox={} minbox={} sysmenu={} caption_rects={} max_btn={} scale={}",
        style & WS_THICKFRAME as i32 != 0,
        style & WS_MAXIMIZEBOX as i32 != 0,
        style & WS_MINIMIZEBOX as i32 != 0,
        style & WS_SYSMENU as i32 != 0,
        state.0,
        state.1,
        state.2
    )
}
