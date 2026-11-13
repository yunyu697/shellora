//! 应用设置：落盘到 `<app_data_dir>/settings.json`。
//!
//! 目前只有一条：`close_to_tray`（关闭窗口时最小化到托盘，默认 false）。
//! 放在 Rust 侧读取，是因为窗口关闭事件发生时前端可能已经不可用；
//! `tray_hint_shown` 只用来保证「后台运行」提示一辈子只出现一次。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 关闭窗口时最小化到托盘（默认关闭：关闭即退出）。
    pub close_to_tray: bool,
    /// 首次驻留提示是否已展示。
    pub tray_hint_shown: bool,
}

pub struct SettingsStore {
    path: PathBuf,
    data: Mutex<Settings>,
}

impl SettingsStore {
    pub fn open(dir: &Path) -> Self {
        let path = dir.join("settings.json");
        let data = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            data: Mutex::new(data),
        }
    }

    pub fn get(&self) -> Settings {
        *self.data.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_close_to_tray(&self, value: bool) {
        self.mutate(|s| s.close_to_tray = value);
    }

    pub fn mark_hint_shown(&self) {
        self.mutate(|s| s.tray_hint_shown = true);
    }

    fn mutate(&self, f: impl FnOnce(&mut Settings)) {
        let snapshot = {
            let mut guard = self.data.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut guard);
            *guard
        };
        if let Ok(raw) = serde_json::to_string_pretty(&snapshot) {
            let _ = fs::write(&self.path, raw);
        }
    }
}
