//! 全局应用状态（Tauri `manage`）。

use std::sync::Arc;

use crate::session::SessionRegistry;
use crate::sftp::dir::DirListingRegistry;
use crate::transfer::TransferManager;

#[derive(Default)]
pub struct AppState {
    pub sessions: SessionRegistry,
    pub transfers: Arc<TransferManager>,
    pub listings: Arc<DirListingRegistry>,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}
