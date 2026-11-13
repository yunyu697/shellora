//! 每个标签一个 actor：持有 SSH 连接、驱动读循环、维护状态机。

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::config::{RESIZE_DEBOUNCE_MS, TERM_COALESCE_MS};
use crate::ipc::dto::{ConnStateDto, ConnStateEvent, StreamMsg};
use crate::session::{Channels, Ctrl, SessionEntry};
use crate::terminal::coalesce::{permits_for, Coalescer};
use crate::config::TERM_PERMIT_BYTES;

/// 启动（或重启）一个标签的 actor。
pub fn spawn(app: AppHandle, entry: Arc<SessionEntry>) {
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);
    let (ctrl_tx, ctrl_rx) = mpsc::channel::<Ctrl>(8);
    if let Ok(mut ch) = entry.channels.lock() {
        *ch = Channels { input_tx, ctrl_tx };
    }
    tauri::async_runtime::spawn(async move {
        run(app, entry, input_rx, ctrl_rx).await;
    });
}

fn emit(app: &AppHandle, entry: &SessionEntry, state: ConnStateDto) {
    if let Ok(mut s) = entry.state.lock() {
        *s = state.clone();
    }
    let payload = ConnStateEvent {
        tab_id: entry.tab_id.clone(),
        state: state.state,
        reason: state.reason.clone(),
    };
    if let Err(err) = app.emit("conn_state", payload) {
        tracing::warn!(target: "ipc", %err, "emit conn_state failed");
    }
}

async fn run(
    app: AppHandle,
    entry: Arc<SessionEntry>,
    mut input_rx: mpsc::Receiver<Vec<u8>>,
    mut ctrl_rx: mpsc::Receiver<Ctrl>,
) {
    emit(&app, &entry, ConnStateDto::connecting());

    // known_host 校验必须接数据库；actor 运行期持有克隆，保证跨 await 存活。
    let store = app.state::<crate::db::Database>().inner().clone();
    let (handle, mut channel) = match crate::ssh::open_shell(
        &entry.input,
        entry.input.cols,
        entry.input.rows,
        Some(&store),
    )
    .await
    {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(target: "ssh", code = err.code, "connect failed: {}", err.message);
            emit(&app, &entry, ConnStateDto::failed(err.message));
            return;
        }
    };

    emit(&app, &entry, ConnStateDto::ready());
    // 把已认证句柄交给入口共享给 SFTP（同一 SSH 连接上开独立 channel）。
    *entry.ssh.lock().await = Some(handle);

    // 独立 writer 任务：输入字节按序写入，避免与读循环争用通道句柄。
    let mut writer = channel.make_writer();
    let writer_task = tauri::async_runtime::spawn(async move {
        while let Some(buf) = input_rx.recv().await {
            if writer.write_all(&buf).await.is_err() {
                break;
            }
        }
    });

    let mut coalescer = Coalescer::new();
    let mut seq: u64 = 0;
    let mut pending_resize: Option<(u16, u16)> = None;
    let mut last_resize = Instant::now() - Duration::from_millis(RESIZE_DEBOUNCE_MS);

    loop {
        // 1) 先消化控制消息（resize 按 60ms 合并、close 立即生效）
        while let Ok(ctrl) = ctrl_rx.try_recv() {
            match ctrl {
                Ctrl::Resize { cols: c, rows: r } => {
                    pending_resize = Some((c, r));
                    if last_resize.elapsed() >= Duration::from_millis(RESIZE_DEBOUNCE_MS) {
                        let (c, r) = pending_resize.take().unwrap();
                        last_resize = Instant::now();
                        if let Err(err) = channel.window_change(c as u32, r as u32, 0, 0).await {
                            tracing::warn!(target: "ssh", %err, "window_change failed");
                        }
                    }
                }
                Ctrl::Close => {
                    channel.close().await.ok();
                    if let Some(handle) = entry.ssh.lock().await.take() {
                        handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
                    }
                    emit(&app, &entry, ConnStateDto::closed(crate::i18n::t("用户关闭")));
                    break;
                }
            }
        }

        // 2) 读一段输出；有待发送数据时用 8ms 超时保证低延迟，空闲时放宽到 50ms
        let wait_ms = if coalescer.has_pending() { TERM_COALESCE_MS } else { 50 };
        match tokio::time::timeout(Duration::from_millis(wait_ms), channel.wait()).await {
            Ok(Some(msg)) => match msg {
                russh::ChannelMsg::Data { data } => {
                    if let Some(frame) = coalescer.push(data.as_ref()) {
                        if !send_frame(&app, &entry, &mut seq, frame).await {
                            break;
                        }
                    }
                }
                russh::ChannelMsg::ExtendedData { data, .. } => {
                    if let Some(frame) = coalescer.push(data.as_ref()) {
                        if !send_frame(&app, &entry, &mut seq, frame).await {
                            break;
                        }
                    }
                }
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => {
                    if let Some(frame) = coalescer.drain() {
                        send_frame(&app, &entry, &mut seq, frame).await;
                    }
                    let code = None;
                    let _ = entry.ipc.send(StreamMsg::Eof { code });
                    emit(&app, &entry, ConnStateDto::closed(crate::i18n::t("远端关闭通道")));
                    break;
                }
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    let _ = entry.ipc.send(StreamMsg::Eof { code: Some(exit_status) });
                }
                _ => {}
            },
            Ok(None) => {
                emit(&app, &entry, ConnStateDto::closed(crate::i18n::t("SSH 通道结束")));
                break;
            }
            Err(_) => {
                // 空闲 tick：到期的 resize 与合并缓冲在此提交
                if let Some((c, r)) = pending_resize {
                    if last_resize.elapsed() >= Duration::from_millis(RESIZE_DEBOUNCE_MS) {
                        pending_resize = None;
                        last_resize = Instant::now();
                        if let Err(err) = channel.window_change(c as u32, r as u32, 0, 0).await {
                            tracing::warn!(target: "ssh", %err, "window_change failed");
                        }
                    }
                }
                if let Some(frame) = coalescer.flush() {
                    if !send_frame(&app, &entry, &mut seq, frame).await {
                        break;
                    }
                }
            }
        }
    }

    writer_task.abort();
    // 连接结束：移出共享句柄，SFTP 后续操作会得到明确的“会话未就绪”。
    entry.ssh.lock().await.take();
    emit(&app, &entry, ConnStateDto::closed(crate::i18n::t("会话结束")));
}

/// 发送一帧：先按字节占用信用窗口，前端 ack 后才归还（背压核心）。
/// 返回 false 表示前端通道已失效，应结束 actor。
async fn send_frame(
    app: &AppHandle,
    entry: &SessionEntry,
    seq: &mut u64,
    frame: Vec<u8>,
) -> bool {
    let permits = permits_for(frame.len(), TERM_PERMIT_BYTES);
    let sem = entry.permits.clone();
    let permit = match sem.acquire_many_owned(permits).await {
        Ok(p) => p,
        Err(_) => return false,
    };
    // 归还由前端 `terminal_ack` 负责，这里不自动释放
    permit.forget();

    *seq += 1;
    if entry.ipc.send(StreamMsg::Data { seq: *seq, b: frame }).is_err() {
        tracing::warn!(target: "ipc", tab = %entry.tab_id, "channel closed by frontend");
        let _ = app;
        return false;
    }
    true
}
