//! 会话注册表与 actor 的持有结构。

pub mod actor;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tokio::sync::{mpsc, Semaphore};

use crate::config::{TERM_PERMIT_BYTES, TERM_WINDOW_BYTES};
use crate::ipc::dto::{ConnStateDto, ConnectionInput, StreamMsg};
use crate::ssh::connect::SshHandle;

/// 运行期控制消息（不占用终端数据通道）。
#[derive(Debug, Clone, Copy)]
pub enum Ctrl {
    Resize { cols: u16, rows: u16 },
    Close,
}

/// 当前 actor 的输入/控制句柄；重连时整体替换。
pub struct Channels {
    pub input_tx: mpsc::Sender<Vec<u8>>,
    pub ctrl_tx: mpsc::Sender<Ctrl>,
}

pub struct SessionEntry {
    pub tab_id: String,
    pub input: ConnectionInput,
    pub ipc: Channel<StreamMsg>,
    pub state: Arc<Mutex<ConnStateDto>>,
    pub permits: Arc<Semaphore>,
    pub channels: Mutex<Channels>,
    /// 已认证的 SSH 连接句柄：actor 连接成功后放入，SFTP 在其上开独立 channel。
    /// 用 tokio Mutex 是因为 `channel_open_session` 需要 await，且句柄不可 Clone；
    /// 外层 Arc 便于 SFTP worker 克隆持有。
    pub ssh: Arc<tokio::sync::Mutex<Option<SshHandle>>>,
}

impl SessionEntry {
    pub fn new(tab_id: String, input: ConnectionInput, ipc: Channel<StreamMsg>) -> Arc<Self> {
        let (input_tx, _) = mpsc::channel(64);
        let (ctrl_tx, _) = mpsc::channel(8);
        Arc::new(Self {
            tab_id,
            input,
            ipc,
            state: Arc::new(Mutex::new(ConnStateDto::connecting())),
            permits: Arc::new(Semaphore::new(TERM_WINDOW_BYTES / TERM_PERMIT_BYTES)),
            channels: Mutex::new(Channels { input_tx, ctrl_tx }),
            ssh: Arc::new(tokio::sync::Mutex::new(None)),
        })
    }

    pub fn state_snapshot(&self) -> ConnStateDto {
        self.state.lock().map(|g| g.clone()).unwrap_or_else(|_| ConnStateDto::connecting())
    }
}

/// 标签注册表：单进程、单窗口，用 `std::sync::Mutex` 足够（持锁时间 < 1µs）。
#[derive(Default)]
pub struct SessionRegistry {
    inner: Mutex<HashMap<String, Arc<SessionEntry>>>,
}

impl SessionRegistry {
    pub fn count(&self) -> usize {
        self.inner.lock().map(|m| m.len()).unwrap_or(0)
    }

    pub fn insert(&self, entry: Arc<SessionEntry>) {
        if let Ok(mut m) = self.inner.lock() {
            m.insert(entry.tab_id.clone(), entry);
        }
    }

    pub fn get(&self, tab_id: &str) -> Option<Arc<SessionEntry>> {
        self.inner.lock().ok().and_then(|m| m.get(tab_id).cloned())
    }

    pub fn remove(&self, tab_id: &str) -> Option<Arc<SessionEntry>> {
        self.inner.lock().ok().and_then(|mut m| m.remove(tab_id))
    }
}
