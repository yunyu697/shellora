//! 本地磁盘目录分页（M3 左栏）。
//!
//! 每页按文件名排序后切片，保证分页顺序稳定；只对当前页条目取元数据。

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, ErrorDto};
use crate::ipc::dto::{DirEntryDto, LocalDirPageDto, LocalStatDto};

/// 默认每页条数（与远端保持一致）。
pub const LOCAL_PAGE_SIZE: usize = 500;

fn map_io(err: std::io::Error) -> ErrorDto {
    ErrorDto::new(ErrorCode::FsIo, err.to_string())
}

/// 用户主目录（本地左栏初始路径）。
pub fn home_dir() -> String {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

/// 读取单路径元数据（供外部文件拖入时判断文件/目录）。
pub async fn stat(path: String) -> Result<LocalStatDto, ErrorDto> {
    let p = PathBuf::from(&path);
    let meta = fs::symlink_metadata(&p).map_err(map_io)?;
    let is_symlink = meta.file_type().is_symlink();
    let is_dir = if is_symlink {
        // 跟随 symlink 判断
        fs::metadata(&p).map(|m| m.file_type().is_dir()).unwrap_or(false)
    } else {
        meta.file_type().is_dir()
    };
    let size = meta.len();
    Ok(LocalStatDto {
        is_dir,
        is_symlink,
        size,
    })
}

/// 读取本地目录的一页。`offset` 从 0 开始，返回 `has_more` 供前端继续拉取。
pub async fn list_dir(
    path: String,
    offset: usize,
    limit: usize,
) -> Result<LocalDirPageDto, ErrorDto> {
    let limit = limit.clamp(1, 2000);
    let dir = PathBuf::from(&path);

    let mut reader = tokio::fs::read_dir(&dir).await.map_err(map_io)?;
    let mut names: Vec<PathBuf> = Vec::new();
    while let Some(entry) = reader.next_entry().await.map_err(map_io)? {
        names.push(entry.path());
    }
    names.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .cmp(b.file_name().unwrap_or_default())
    });

    let selected: Vec<PathBuf> = names.iter().skip(offset).take(limit + 1).cloned().collect();
    let has_more = selected.len() > limit;
    let mut entries = Vec::with_capacity(selected.len().min(limit));
    for p in selected.into_iter().take(limit) {
        entries.push(entry_dto(&p).await);
    }

    Ok(LocalDirPageDto {
        path,
        offset,
        next_offset: offset + entries.len(),
        has_more,
        entries,
    })
}

// ---------------------------------------------------------------------------
// M3.5：递归目录扫描与目录创建
// ---------------------------------------------------------------------------

/// 本地扫描出的普通文件；`relative` 相对扫描根、以 `/` 分隔。
#[derive(Debug, Clone)]
pub struct ScanFile {
    pub abs: PathBuf,
    pub relative: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default)]
pub struct LocalTree {
    pub files: Vec<ScanFile>,
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

/// 递归扫描本地目录；跳过符号链接，超过深度/文件数上限返回
/// `TRANSFER_LIMIT_EXCEEDED` 而不是卡死。
pub async fn walk_tree(
    root: &Path,
    max_depth: usize,
    max_files: usize,
) -> Result<LocalTree, ErrorDto> {
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.to_path_buf(), String::new(), 0)];
    let mut tree = LocalTree::default();

    while let Some((dir, dir_rel, depth)) = stack.pop() {
        let mut entries: Vec<(String, PathBuf, bool, u64)> = Vec::new();
        let mut reader = tokio::fs::read_dir(&dir).await.map_err(map_io)?;
        while let Some(entry) = reader.next_entry().await.map_err(map_io)? {
            let name = entry.file_name().to_string_lossy().to_string();
            let abs = entry.path();
            let Ok(link_meta) = tokio::fs::symlink_metadata(&abs).await else {
                continue;
            };
            if link_meta.file_type().is_symlink() {
                continue;
            }
            entries.push((name, abs, link_meta.is_dir(), link_meta.len()));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        for (name, abs, is_dir, size) in entries {
            let rel = join_rel(&dir_rel, &name);
            if is_dir {
                let child_depth = depth + 1;
                if child_depth > max_depth {
                    return Err(limit_exceeded(format!(
                        "目录层级超过上限 {max_depth}（在 {rel}）"
                    )));
                }
                tree.dirs.push(rel.clone());
                stack.push((abs, rel, child_depth));
            } else {
                if tree.files.len() >= max_files {
                    return Err(limit_exceeded(format!(
                        "文件数超过上限 {max_files}（在 {rel}）"
                    )));
                }
                tree.files.push(ScanFile {
                    abs,
                    relative: rel,
                    size,
                });
                tree.total_bytes += size;
            }
        }
    }

    Ok(tree)
}

/// 按父目录优先顺序创建本地目录；返回新建数量。
pub async fn create_dirs(paths: &[PathBuf]) -> Result<usize, ErrorDto> {
    let mut created = 0;
    for path in paths {
        if tokio::fs::try_exists(path).await.unwrap_or(false) {
            continue;
        }
        tokio::fs::create_dir_all(path).await.map_err(map_io)?;
        created += 1;
    }
    Ok(created)
}

/// 新建单层本地目录；父目录不存在时返回 `FS_IO`（与远端 `mkdir` 一致）。
pub async fn create_dir(path: String) -> Result<(), ErrorDto> {
    let target = PathBuf::from(&path);
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Err(ErrorDto::new(ErrorCode::FsIo, format!("已存在：{path}")));
    }
    tokio::fs::create_dir(&target).await.map_err(map_io)
}

/// 本地重命名 / 移动；目标已存在时拒绝，避免静默覆盖。
pub async fn rename_path(from: String, to: String) -> Result<(), ErrorDto> {
    let target = PathBuf::from(&to);
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Err(ErrorDto::new(ErrorCode::FsIo, format!("目标已存在：{to}")));
    }
    tokio::fs::rename(PathBuf::from(&from), &target)
        .await
        .map_err(map_io)
}

/// 删除本地文件或空目录。
///
/// 符号链接一律按文件处理（只删链接本身，不跟进目标）；
/// 目录使用 `remove_dir`，非空目录会返回 `FS_IO` 错误，与远端语义一致。
pub async fn remove_path(path: String, is_dir: bool) -> Result<(), ErrorDto> {
    let target = PathBuf::from(&path);
    let meta = tokio::fs::symlink_metadata(&target).await.map_err(map_io)?;
    if is_dir && meta.is_dir() && !meta.file_type().is_symlink() {
        tokio::fs::remove_dir(&target).await.map_err(map_io)
    } else {
        tokio::fs::remove_file(&target).await.map_err(map_io)
    }
}

async fn entry_dto(path: &Path) -> DirEntryDto {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let Ok(link_meta) = tokio::fs::symlink_metadata(path).await else {
        return DirEntryDto {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: false,
            is_symlink: false,
            size: 0,
            mtime: 0,
        };
    };
    let is_symlink = link_meta.file_type().is_symlink();
    // 符号链接按目标类型展示，便于进入链接目录。
    let meta = if is_symlink {
        tokio::fs::metadata(path).await.unwrap_or(link_meta)
    } else {
        link_meta
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    DirEntryDto {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir: meta.is_dir(),
        is_symlink,
        size: if meta.is_file() { meta.len() } else { 0 },
        mtime,
    }
}
