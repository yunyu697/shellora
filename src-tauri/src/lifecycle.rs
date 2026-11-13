//! 退出诊断：把「启动 / 退出 / 异常」落成一行一条的 JSON，用来定性进程无声消失。
//!
//! 记录级别刻意压得很低：只在启动、退出、panic 时写盘，运行期最多改一个内存里的
//! 全局 `LAST_ACTION`，由窗口事件和少量关键命令更新，退出时连同运行时长一起写出。
//!
//! 判定规则：每次启动写 `start`，正常退出写 `exit`。若下一条 `start` 之前没有
//! `exit`，就在启动时补一条 `unclean_previous`——这就是「上次没走正常退出路径」。
//! 因为当前没有单实例插件，多开时也会出现该提示，故记录里带 `prev_pid` 供区分。

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;

/// 日志超过该体量时在启动阶段裁掉旧行，避免无限增长。
const MAX_BYTES: u64 = 512 * 1024;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static STARTED_AT: OnceLock<Instant> = OnceLock::new();
static LAST_ACTION: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static REASON: Mutex<Option<String>> = Mutex::new(None);
static EXIT_WRITTEN: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 启动时调用一次：建目录、裁旧日志、补记上次的非正常退出、写 `start`。
pub fn init(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    let path = dir.join("lifecycle.log");
    LOG_PATH.set(path.clone()).ok();
    STARTED_AT.set(Instant::now()).ok();

    trim_if_large(&path);
    if let Some(prev) = last_record(&path) {
        match prev.get("event").and_then(|v| v.as_str()) {
            Some("start") => write(json!({
                "event": "unclean_previous",
                "ts_ms": now_ms(),
                "prev_pid": prev.get("pid").cloned().unwrap_or(json!(null)),
                "prev_start_ms": prev.get("ts_ms").cloned().unwrap_or(json!(null)),
                "prev_version": prev.get("version").cloned().unwrap_or(json!(null)),
                "note": "上次启动后没有写 exit；可能是被结束进程/崩溃/断电，也可能是另一个实例仍在运行",
            })),
            Some("relaunch_intent") => write(json!({
                "event": "previous_exit",
                "ts_ms": now_ms(),
                "reason": "relaunch",
                "detail": prev.get("action").cloned().unwrap_or(json!(null)),
            })),
            _ => {}
        }
    }
    write(json!({
        "event": "start",
        "ts_ms": now_ms(),
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    }));

    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info.to_string();
        write(json!({
            "event": "panic",
            "ts_ms": now_ms(),
            "uptime_ms": uptime_ms(),
            "last_action": last_action_text(),
            "message": msg.lines().next().unwrap_or("").to_string(),
        }));
        prev_hook(info);
    }));
}

fn trim_if_large(path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= MAX_BYTES {
        return;
    }
    let Ok(file) = fs::File::open(path) else { return };
    let lines: Vec<String> = BufReader::new(file).lines().map_while(Result::ok).collect();
    let keep = lines.len().saturating_sub(lines.len() / 2);
    let body = lines[keep..].join("\n") + "\n";
    let _ = fs::write(path, body);
}

fn last_record(path: &Path) -> Option<serde_json::Value> {
    let file = fs::File::open(path).ok()?;
    let mut last = String::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.trim().is_empty() {
            last = line;
        }
    }
    serde_json::from_str(&last).ok()
}

fn write(record: serde_json::Value) {
    let Some(path) = LOG_PATH.get() else { return };
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "{record}");
}

fn uptime_ms() -> u64 {
    STARTED_AT
        .get()
        .map(|t| t.elapsed().as_millis() as u64)
        .unwrap_or(0)
}

fn last_action_text() -> Option<String> {
    let guard = lock(&LAST_ACTION);
    guard.as_ref().map(|(name, at)| {
        format!("{name} (+{}ms)", at.elapsed().as_millis())
    })
}

/// 记录最近一次动作（只在内存里保留最后一条，退出时写盘）。
pub fn note(action: impl Into<String>) {
    *lock(&LAST_ACTION) = Some((action.into(), Instant::now()));
}

/// 提前落一条「即将重启」意图；进程被安装器直接结束时不会再有 exit，
/// 下次启动据此把它归因为重启，而不是异常终止。
pub fn relaunch_intent(action: &str) {
    note(action);
    write(json!({
        "event": "relaunch_intent",
        "ts_ms": now_ms(),
        "pid": std::process::id(),
        "uptime_ms": uptime_ms(),
        "action": action,
    }));
}

/// 记录退出原因；先到者优先（窗口关闭早于 `ExitRequested`）。
pub fn set_reason(reason: impl Into<String>) {
    let mut guard = lock(&REASON);
    if guard.is_none() {
        *guard = Some(reason.into());
    }
}

/// 写 `exit` 记录；只生效一次，可被 `RunEvent::Exit` 与 panic/重启路径共同调用。
pub fn finish(default_reason: &str) {
    if EXIT_WRITTEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let reason = lock(&REASON)
        .clone()
        .unwrap_or_else(|| default_reason.to_string());
    let last = lock(&LAST_ACTION).clone();
    write(json!({
        "event": "exit",
        "ts_ms": now_ms(),
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
        "reason": reason,
        "uptime_ms": uptime_ms(),
        "last_action": last.as_ref().map(|(a, _)| a.clone()),
        "last_action_age_ms": last.as_ref().map(|(_, t)| t.elapsed().as_millis() as u64),
    }));
}
