//! IPC 命令集合。约束：函数体不做阻塞 I/O，返回耗时 ≤ 5ms。

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::app::AppState;
use crate::config::{MAX_TABS, SFTP_DIR_PAGE_SIZE, TERM_PERMIT_BYTES};
use crate::error::ErrorDto;
use crate::ipc::dto::{
    ConnStateDto, ConnectionInput, DataClearReport, DirListMsg, LocalDirPageDto, OpenTabDto,
    QueueMsg, SecretProbeDto, StreamMsg, TransferEnqueueItem, TransferGroupDto, TransferMsg,
    TransferResultDto, TransferTaskDto, TreeEnqueueRequest, TreeGroupStartedDto,
};
use crate::session::{actor, Ctrl, SessionEntry};
use crate::sftp::{SharedSsh, TransferRequest};
use crate::terminal::coalesce::permits_for;
use crate::transfer::{ConflictChoice, EnqueueItem};

/// 打开一个终端标签：立即返回 tabId，连接过程在后台推进。
#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ConnectionInput,
    channel: Channel<StreamMsg>,
) -> Result<OpenTabDto, ErrorDto> {
    if state.sessions.count() >= MAX_TABS {
        return Err(ErrorDto::internal(format!(
            "标签已达上限 {MAX_TABS}，请先关闭标签"
        )));
    }
    let tab_id = uuid::Uuid::now_v7().to_string();
    let entry = SessionEntry::new(tab_id.clone(), input, channel);
    state.sessions.insert(entry.clone());
    actor::spawn(app, entry);
    Ok(OpenTabDto { tab_id })
}

/// 写入键盘输入（UTF-8 字符串，单次 ≤ 64KB 由前端保证）。
#[tauri::command]
pub fn terminal_input(
    state: State<'_, AppState>,
    tab_id: String,
    data: String,
) -> Result<(), ErrorDto> {
    let entry = state
        .sessions
        .get(&tab_id)
        .ok_or_else(|| ErrorDto::internal("标签不存在"))?;
    let tx = entry
        .channels
        .lock()
        .map(|c| c.input_tx.clone())
        .map_err(|_| ErrorDto::internal("会话锁失效"))?;
    if tx.try_send(data.into_bytes()).is_err() {
        tracing::warn!(target: "ipc", %tab_id, "input queue full or closed");
    }
    Ok(())
}

/// 视口尺寸变化：Rust 侧按 60ms 合并后再发 SSH `window_change`。
#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    tab_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), ErrorDto> {
    let entry = state
        .sessions
        .get(&tab_id)
        .ok_or_else(|| ErrorDto::internal("标签不存在"))?;
    let tx = entry
        .channels
        .lock()
        .map(|c| c.ctrl_tx.clone())
        .map_err(|_| ErrorDto::internal("会话锁失效"))?;
    tx.try_send(Ctrl::Resize { cols, rows }).ok();
    Ok(())
}

/// 前端消费完一帧后归还信用窗口。
#[tauri::command]
pub fn terminal_ack(
    state: State<'_, AppState>,
    tab_id: String,
    bytes: u32,
) -> Result<(), ErrorDto> {
    let entry = state
        .sessions
        .get(&tab_id)
        .ok_or_else(|| ErrorDto::internal("标签不存在"))?;
    let permits = permits_for(bytes as usize, TERM_PERMIT_BYTES) as usize;
    entry.permits.add_permits(permits);
    Ok(())
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, tab_id: String) -> Result<(), ErrorDto> {
    if let Some(entry) = state.sessions.remove(&tab_id) {
        if let Ok(ch) = entry.channels.lock() {
            ch.ctrl_tx.try_send(Ctrl::Close).ok();
        }
    }
    Ok(())
}

/// 手工重连（重置退避，M1 接入指数退避自动重连）。
#[tauri::command]
pub fn terminal_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), ErrorDto> {
    let entry = state
        .sessions
        .get(&tab_id)
        .ok_or_else(|| ErrorDto::internal("标签不存在"))?;
    actor::spawn(app, entry);
    Ok(())
}

#[tauri::command]
pub fn terminal_state(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<ConnStateDto, ErrorDto> {
    state
        .sessions
        .get(&tab_id)
        .map(|e| e.state_snapshot())
        .ok_or_else(|| ErrorDto::internal("标签不存在"))
}

/// 凭据后端探测（D1）。
#[tauri::command]
pub fn secret_probe() -> SecretProbeDto {
    crate::secret::probe()
}

/// 会话库“测试连接”：只连接 + 认证，15s 超时。
#[tauri::command]
pub async fn conn_test(
    db: State<'_, crate::db::Database>,
    input: ConnectionInput,
) -> Result<(), ErrorDto> {
    crate::ssh::probe(&input, Some(db.inner())).await
}

/// 已信任主机列表（前端“已知主机”管理）。
#[tauri::command]
pub fn knownhost_list(
    db: State<'_, crate::db::Database>,
) -> Result<Vec<crate::db::KnownHostRow>, ErrorDto> {
    db.list_all_known_hosts().map_err(db_error)
}

/// 手动删除一条信任记录；指纹变更后的唯一恢复路径。
#[tauri::command]
pub fn knownhost_delete(
    db: State<'_, crate::db::Database>,
    id: String,
) -> Result<usize, ErrorDto> {
    db.delete_known_host(&id).map_err(db_error)
}

#[tauri::command]
pub fn db_list_connections(
    db: State<'_, crate::db::Database>,
) -> Result<Vec<crate::db::ConnectionRow>, ErrorDto> {
    db.list_connections().map_err(db_error)
}

#[tauri::command]
pub fn db_insert_connection(
    db: State<'_, crate::db::Database>,
    new: crate::db::NewConnection,
) -> Result<String, ErrorDto> {
    db.insert_connection(&new).map_err(db_error)
}

#[tauri::command]
pub fn db_delete_connection(
    db: State<'_, crate::db::Database>,
    id: String,
) -> Result<usize, ErrorDto> {
    db.delete_connection(&id).map_err(db_error)
}

#[tauri::command]
pub fn db_create_session(
    db: State<'_, crate::db::Database>,
    connection_id: String,
    name: String,
) -> Result<String, ErrorDto> {
    db.create_session(&connection_id, &name).map_err(db_error)
}

#[tauri::command]
pub fn db_list_sessions(
    db: State<'_, crate::db::Database>,
) -> Result<Vec<crate::db::SessionRow>, ErrorDto> {
    db.list_sessions().map_err(db_error)
}

fn db_error(err: crate::db::DbError) -> ErrorDto {
    ErrorDto::internal(err.to_string())
}

fn session_ssh(state: &State<'_, AppState>, tab_id: &str) -> Result<SharedSsh, ErrorDto> {
    state
        .sessions
        .get(tab_id)
        .map(|entry| entry.ssh.clone())
        .ok_or_else(|| ErrorDto::internal("标签不存在"))
}

/// SFTP 下载：远端单文件 → 本地，写 `.part` 并支持断点续传。
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    db: State<'_, crate::db::Database>,
    tab_id: String,
    remote_path: String,
    local_path: String,
    progress: Channel<TransferMsg>,
) -> Result<TransferResultDto, ErrorDto> {
    let ssh = session_ssh(&state, &tab_id)?;
    crate::sftp::download(
        ssh,
        db.inner(),
        TransferRequest {
            tab_id: Some(tab_id),
            remote_path,
            local_path: std::path::PathBuf::from(local_path),
            progress: Some(progress),
            ..TransferRequest::default()
        },
    )
    .await
}

/// SFTP 上传：本地单文件 → 远端，写 `.part` 并支持断点续传。
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    db: State<'_, crate::db::Database>,
    tab_id: String,
    remote_path: String,
    local_path: String,
    progress: Channel<TransferMsg>,
) -> Result<TransferResultDto, ErrorDto> {
    let ssh = session_ssh(&state, &tab_id)?;
    crate::sftp::upload(
        ssh,
        db.inner(),
        TransferRequest {
            tab_id: Some(tab_id),
            remote_path,
            local_path: std::path::PathBuf::from(local_path),
            progress: Some(progress),
            ..TransferRequest::default()
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// M3：目录列表
// ---------------------------------------------------------------------------

/// 远端目录流式分页：每页最多 500 条，通过 Channel 持续推送，不一次性返回全量。
#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    tab_id: String,
    path: String,
    listing_id: String,
    channel: Channel<DirListMsg>,
) -> Result<(), ErrorDto> {
    let ssh = session_ssh(&state, &tab_id)?;
    let cancel = state.listings.begin(&listing_id);
    let registry = state.listings.clone();
    let done_path = path.clone();
    let mut offset = 0u64;

    tokio::spawn(async move {
        let ch = channel.clone();
        let msg_path = done_path.clone();
        let page_listing = listing_id.clone();
        let result = crate::sftp::dir::list_dir(
            ssh,
            done_path.clone(),
            SFTP_DIR_PAGE_SIZE,
            cancel,
            move |entries| {
                let n = entries.len() as u64;
                let sent = ch
                    .send(DirListMsg::Page {
                        listing_id: page_listing.clone(),
                        path: msg_path.clone(),
                        offset,
                        entries,
                    })
                    .is_ok();
                offset += n;
                sent
            },
        )
        .await;

        match result {
            Ok(total) => {
                let _ = channel.send(DirListMsg::Done {
                    listing_id: listing_id.clone(),
                    path: done_path,
                    total,
                });
            }
            Err(err) if err.code == "TRANSFER_INTERRUPTED" => {}
            Err(err) => {
                let _ = channel.send(DirListMsg::Failed {
                    listing_id: listing_id.clone(),
                    path: done_path,
                    code: err.code,
                    message: err.message,
                });
            }
        }
        registry.end(&listing_id);
    });
    Ok(())
}

/// 前端离开目录时取消仍在进行的远端列表。
#[tauri::command]
pub fn sftp_cancel_list(state: State<'_, AppState>, listing_id: String) -> Result<(), ErrorDto> {
    state.listings.cancel(&listing_id);
    Ok(())
}

#[tauri::command]
pub fn local_home() -> String {
    crate::local::home_dir()
}

#[tauri::command]
pub async fn local_list_dir(
    path: String,
    offset: usize,
    limit: Option<usize>,
) -> Result<LocalDirPageDto, ErrorDto> {
    crate::local::list_dir(
        path,
        offset,
        limit.unwrap_or(crate::local::LOCAL_PAGE_SIZE),
    )
    .await
}

// ---------------------------------------------------------------------------
// M3：传输队列
// ---------------------------------------------------------------------------

/// 批量入队（默认并发 2 由管理器控制），所有任务更新走同一个 Channel。
#[tauri::command]
pub async fn transfer_enqueue(
    state: State<'_, AppState>,
    db: State<'_, crate::db::Database>,
    items: Vec<TransferEnqueueItem>,
    progress: Channel<QueueMsg>,
) -> Result<Vec<String>, ErrorDto> {
    let mut resolved = Vec::with_capacity(items.len());
    for item in &items {
        resolved.push(session_ssh(&state, &item.tab_id)?);
    }
    let mut ids = Vec::with_capacity(items.len());
    for (item, ssh) in items.into_iter().zip(resolved) {
        ids.extend(
            state
                .transfers
                .enqueue(
                    db.inner(),
                    ssh,
                    vec![EnqueueItem {
                        direction: item.direction,
                        tab_id: item.tab_id,
                        remote_path: item.remote_path,
                        local_path: item.local_path,
                    }],
                    Some(progress.clone()),
                )
                .await?,
        );
    }
    Ok(ids)
}

#[tauri::command]
pub fn transfer_pause(state: State<'_, AppState>, task_id: String) -> Result<(), ErrorDto> {
    state.transfers.pause(&task_id)
}

#[tauri::command]
pub async fn transfer_resume(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), ErrorDto> {
    state.transfers.resume(&task_id)
}

#[tauri::command]
pub fn transfer_cancel(state: State<'_, AppState>, task_id: String) -> Result<(), ErrorDto> {
    state.transfers.cancel(&task_id)
}

fn parse_choice(choice: &str, new_name: Option<String>) -> Result<ConflictChoice, ErrorDto> {
    match choice {
        "overwrite" => Ok(ConflictChoice::Overwrite),
        "skip" => Ok(ConflictChoice::Skip),
        "rename" => Ok(ConflictChoice::Rename { new_name }),
        other => Err(ErrorDto::internal(format!("未知冲突策略：{other}"))),
    }
}

#[tauri::command]
pub async fn transfer_resolve(
    state: State<'_, AppState>,
    task_id: String,
    choice: String,
    new_name: Option<String>,
) -> Result<(), ErrorDto> {
    let choice = parse_choice(&choice, new_name)?;
    state.transfers.resolve(&task_id, choice).await
}

#[tauri::command]
pub fn transfer_list(state: State<'_, AppState>) -> Result<Vec<TransferTaskDto>, ErrorDto> {
    Ok(state.transfers.list())
}

// ---------------------------------------------------------------------------
// M3.5：递归目录传输（组）
// ---------------------------------------------------------------------------

/// 递归扫描并入队：目录树先展开为文件任务，共享同一个 `transfer_job` 组。
#[tauri::command]
pub async fn transfer_enqueue_tree(
    state: State<'_, AppState>,
    db: State<'_, crate::db::Database>,
    request: TreeEnqueueRequest,
    progress: Channel<QueueMsg>,
) -> Result<TreeGroupStartedDto, ErrorDto> {
    let ssh = session_ssh(&state, &request.tab_id)?;
    state
        .transfers
        .enqueue_tree(db.inner(), ssh, request, Some(progress))
        .await
}

#[tauri::command]
pub fn transfer_pause_group(state: State<'_, AppState>, group_id: String) -> Result<(), ErrorDto> {
    state.transfers.pause_group(&group_id)
}

#[tauri::command]
pub async fn transfer_resume_group(
    state: State<'_, AppState>,
    group_id: String,
) -> Result<(), ErrorDto> {
    state.transfers.resume_group(&group_id)
}

#[tauri::command]
pub fn transfer_cancel_group(state: State<'_, AppState>, group_id: String) -> Result<(), ErrorDto> {
    state.transfers.cancel_group(&group_id)
}

#[tauri::command]
pub async fn transfer_resolve_group(
    state: State<'_, AppState>,
    group_id: String,
    choice: String,
    new_name: Option<String>,
) -> Result<(), ErrorDto> {
    let choice = parse_choice(&choice, new_name)?;
    state.transfers.resolve_group(&group_id, choice).await
}

#[tauri::command]
pub fn transfer_list_groups(
    state: State<'_, AppState>,
) -> Result<Vec<TransferGroupDto>, ErrorDto> {
    Ok(state.transfers.list_groups())
}

/// 手动清理本地数据（M6 验收 5）。
///
/// - `scope = "cache"`：传输任务/断点 + 运行日志。
/// - `scope = "all"`：再加会话库、凭据引用、known_host 信任记录、迁移备份。
///
/// 只操作应用自有数据；不改系统 `~/.ssh/known_hosts`，也不保存任何密码本体。
/// 数据库保持打开，按表清空后 schema 仍在，重启即为空库。
#[tauri::command]
pub fn data_clear(
    app: AppHandle,
    db: State<'_, crate::db::Database>,
    scope: String,
) -> Result<DataClearReport, ErrorDto> {
    use tauri::Manager as _;
    let all = match scope.as_str() {
        "cache" => false,
        "all" => true,
        other => return Err(ErrorDto::internal(format!("未知清理范围：{other}"))),
    };

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| ErrorDto::internal(format!("读取数据目录失败：{e}")))?;
    let db_path = crate::paths::resolve_db_file(&dir);
    let data_dir = db_path.parent().unwrap_or(&dir);

    let mut items = vec!["transfer_job".to_string()];
    let mut warnings = Vec::new();

    if all {
        items.extend(
            ["session", "connection", "credential_ref", "known_host"]
                .into_iter()
                .map(str::to_string),
        );
    }

    let rows_removed = if all {
        db.clear_all_data().map_err(db_error)?
    } else {
        db.clear_cache().map_err(db_error)?
    };

    // 迁移备份（.bak）含完整业务数据，仅全清时删除。
    if all {
        if let Ok(entries) = std::fs::read_dir(data_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.ends_with(".bak") {
                    if let Err(err) = std::fs::remove_file(entry.path()) {
                        warnings.push(format!("删除 {name} 失败：{err}"));
                    } else {
                        items.push(name.into_owned());
                    }
                }
            }
        }
    }

    let logs = data_dir.join("logs");
    if logs.is_dir() {
        match std::fs::remove_dir_all(&logs) {
            Ok(()) => items.push("logs".to_string()),
            Err(err) => warnings.push(format!("删除 logs 失败：{err}")),
        }
    }

    Ok(DataClearReport {
        scope: scope.clone(),
        rows_removed,
        items,
        db_path: db_path.display().to_string(),
        warnings,
    })
}
