//! 远端目录流式分页（M3）。
//!
//! `russh_sftp` 的 `SftpSession::read_dir` 会把整个目录先缓冲到内存；这里改用
//! `RawSftpSession` 的 `opendir` / `readdir`，按服务端返回批次消费，再按
//! `SFTP_DIR_PAGE_SIZE` 切页推送，避免万级目录一次性拉全量。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::StatusCode;

use super::{interrupted, map_sftp_err, open_raw_session, open_session, SharedSsh};
use crate::error::{ErrorCode, ErrorDto};
use crate::ipc::dto::DirEntryDto;

/// 目录列表取消标记注册表：前端切目录时按 listingId 置位。
#[derive(Default)]
pub struct DirListingRegistry {
    inner: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DirListingRegistry {
    pub fn begin(&self, listing_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.inner.lock() {
            map.insert(listing_id.to_string(), flag.clone());
        }
        flag
    }

    pub fn cancel(&self, listing_id: &str) {
        if let Ok(map) = self.inner.lock() {
            if let Some(flag) = map.get(listing_id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn end(&self, listing_id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(listing_id);
        }
    }
}

/// 逐批读取远端目录，凑满 `page_size` 就回调一页；返回总条数。
/// 回调返回 `false` 表示前端已关闭通道/取消，立即停止。
pub async fn list_dir<F>(
    ssh: SharedSsh,
    path: String,
    page_size: usize,
    cancel: Arc<AtomicBool>,
    mut on_page: F,
) -> Result<u64, ErrorDto>
where
    F: FnMut(Vec<DirEntryDto>) -> bool,
{
    let page_size = page_size.max(1);
    let raw = open_raw_session(&ssh).await?;
    let opened = raw.opendir(path.clone()).await.map_err(map_sftp_err)?;
    let handle = opened.handle;

    let result = stream_pages(&raw, &path, &handle, page_size, &cancel, &mut on_page).await;
    raw.close(handle).await.ok();
    result
}

async fn stream_pages<F>(
    raw: &russh_sftp::client::rawsession::RawSftpSession,
    dir: &str,
    handle: &str,
    page_size: usize,
    cancel: &AtomicBool,
    on_page: &mut F,
) -> Result<u64, ErrorDto>
where
    F: FnMut(Vec<DirEntryDto>) -> bool,
{
    let mut buffer: Vec<DirEntryDto> = Vec::with_capacity(page_size);
    let mut total = 0u64;

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(interrupted());
        }
        match raw.readdir(handle.to_string()).await {
            Ok(name) => {
                for file in name.files {
                    if file.filename == "." || file.filename == ".." {
                        continue;
                    }
                    let attrs = &file.attrs;
                    buffer.push(DirEntryDto {
                        path: join_remote(dir, &file.filename),
                        name: file.filename,
                        is_dir: attrs.is_dir(),
                        is_symlink: attrs.is_symlink(),
                        size: attrs.size.unwrap_or(0),
                        mtime: attrs.mtime.map(|v| v as i64 * 1000).unwrap_or(0),
                    });
                }
            }
            Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
            Err(err) => return Err(map_sftp_err(err)),
        }

        while buffer.len() >= page_size {
            let page: Vec<DirEntryDto> = buffer.drain(..page_size).collect();
            total += page.len() as u64;
            if !on_page(page) {
                return Err(interrupted());
            }
        }
    }

    if !buffer.is_empty() {
        total += buffer.len() as u64;
        if !on_page(buffer) {
            return Err(interrupted());
        }
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// M3.5：递归目录扫描与目录创建
// ---------------------------------------------------------------------------

/// 扫描结果里的一个普通文件；`relative` 是相对扫描根、以 `/` 分隔的路径。
#[derive(Debug, Clone)]
pub struct RemoteFile {
    pub absolute: String,
    pub relative: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default)]
pub struct RemoteTree {
    pub files: Vec<RemoteFile>,
    /// 相对目录路径（不含扫描根），父目录一定排在子目录之前。
    pub dirs: Vec<String>,
    pub total_bytes: u64,
}

fn limit_exceeded(message: impl Into<String>) -> ErrorDto {
    ErrorDto::new(ErrorCode::TransferLimitExceeded, message)
}

fn join_rel(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

/// 在一个原始 SFTP 会话内 DFS 遍历远端目录树。
///
/// - 跳过符号链接（避免环）；
/// - 目录层级超过 `max_depth` 或文件数超过 `max_files` 时返回
///   `TRANSFER_LIMIT_EXCEEDED`，由 UI 提示调大上限，而不是继续卡住。
pub async fn walk_tree(
    ssh: SharedSsh,
    root: String,
    max_depth: usize,
    max_files: usize,
) -> Result<RemoteTree, ErrorDto> {
    let raw = open_raw_session(&ssh).await?;
    let mut stack: Vec<(String, String, usize)> = vec![(root, String::new(), 0)];
    let mut tree = RemoteTree::default();

    while let Some((dir_abs, dir_rel, depth)) = stack.pop() {
        let opened = raw.opendir(dir_abs.clone()).await.map_err(map_sftp_err)?;
        let handle = opened.handle;
        let mut names: Vec<(String, bool, u64)> = Vec::new();
        loop {
            match raw.readdir(handle.clone()).await {
                Ok(name) => {
                    for file in name.files {
                        if file.filename == "." || file.filename == ".." {
                            continue;
                        }
                        let attrs = &file.attrs;
                        if attrs.is_symlink() {
                            continue;
                        }
                        names.push((
                            file.filename,
                            attrs.is_dir(),
                            attrs.size.unwrap_or(0),
                        ));
                    }
                }
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
                Err(err) => return Err(map_sftp_err(err)),
            }
        }
        raw.close(handle).await.ok();
        names.sort_by(|a, b| a.0.cmp(&b.0));

        for (name, is_dir, size) in names {
            let rel = join_rel(&dir_rel, &name);
            if is_dir {
                let child_depth = depth + 1;
                if child_depth > max_depth {
                    return Err(limit_exceeded(crate::i18n::t_args(
                        "目录层级超过上限 {max_depth}（在 {rel}）",
                        &[("max_depth", &max_depth.to_string()), ("rel", &rel)],
                    )));
                }
                tree.dirs.push(rel.clone());
                stack.push((join_remote(&dir_abs, &name), rel, child_depth));
            } else {
                if tree.files.len() >= max_files {
                    return Err(limit_exceeded(crate::i18n::t_args(
                        "文件数超过上限 {max_files}（在 {rel}）",
                        &[("max_files", &max_files.to_string()), ("rel", &rel)],
                    )));
                }
                tree.files.push(RemoteFile {
                    absolute: join_remote(&dir_abs, &name),
                    relative: rel,
                    size,
                });
                tree.total_bytes += size;
            }
        }
    }

    Ok(tree)
}

/// 按父目录优先顺序创建远端目录；返回新建数量（已存在的不计）。
pub async fn create_dirs(
    ssh: SharedSsh,
    paths: Vec<String>,
) -> Result<usize, ErrorDto> {
    if paths.is_empty() {
        return Ok(0);
    }
    let session = open_session(&ssh).await?;
    let mut created = 0;
    for path in paths {
        match session.try_exists(path.clone()).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(err) => return Err(map_sftp_err(err)),
        }
        session.create_dir(path).await.map_err(map_sftp_err)?;
        created += 1;
    }
    Ok(created)
}

/// SFTP 路径始终用 `/` 拼接；根目录 `/` 直接追加。
pub fn join_remote(base: &str, name: &str) -> String {
    if base.is_empty() || base == "/" {
        format!("/{name}")
    } else if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}
