//! SFTP 单文件传输（M2）。
//!
//! 设计要点：
//! - **复用 SSH 连接**：从 `SessionEntry.ssh` 拿到已认证句柄，在其上开独立的
//!   `session` channel 并请求 `sftp` subsystem；绝不为传输另建 TCP/SSH 连接。
//! - **并发**：文件按 `SFTP_CHUNK_BYTES` 切块，`SFTP_CHANNELS` 个通道各自打开一条
//!   SFTP session 抢块；每条 session 的客户端队列限制为 `SFTP_INFLIGHT_PER_CHANNEL`
//!   个在途请求，请求体 `SFTP_REQUEST_BYTES`。
//! - **断点续传**：始终写 `<目标>.part`，把“连续完成的字节数”落库到 `transfer_job`；
//!   中断后从该偏移继续（已超前的数据会被重写，幂等安全）。
//! - **进度合并**：编排循环 50ms 一跳，累计 ≥16KB 才通过 IPC Channel 发一帧。
//! - **冲突**：目标已存在直接返回 `SFTP_TARGET_EXISTS`，不静默覆盖。

pub mod dir;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::rawsession::RawSftpSession;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{OpenFlags, StatusCode};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinSet;

use crate::config::{
    SFTP_CHANNELS, SFTP_CHUNK_BYTES, SFTP_INFLIGHT_PER_CHANNEL, SFTP_PROGRESS_INTERVAL_MS,
    SFTP_PROGRESS_MIN_BYTES, SFTP_REQUEST_BYTES, SFTP_SAVE_INTERVAL_MS,
};
use crate::db::Database;
use crate::error::{ErrorCode, ErrorDto};
use crate::ipc::dto::{TransferMsg, TransferResultDto};
use crate::ssh::connect::SshHandle;

pub type SharedSsh = Arc<Mutex<Option<SshHandle>>>;

/// 运行期控制信号：队列管理器置位后由传输 worker 在块边界响应。
#[derive(Clone, Default)]
pub struct TransferControl {
    pub pause: Arc<AtomicBool>,
    pub cancel: Arc<AtomicBool>,
}

/// 一次单文件传输请求。
pub struct TransferRequest {
    pub tab_id: Option<String>,
    pub remote_path: String,
    pub local_path: PathBuf,
    pub progress: Option<Channel<TransferMsg>>,
    /// 队列使用的内部进度流（与 `progress` 同时发送）。
    pub progress_tx: Option<mpsc::UnboundedSender<TransferMsg>>,
    /// 暂停/取消信号；置位后 worker 以 `TRANSFER_INTERRUPTED` 退出并保留 `.part`。
    pub control: TransferControl,
    /// 目标已存在时是否允许覆盖（默认 false，由 UI 显式选择）。
    pub overwrite: bool,
    /// 仅测试用的确定性中断注入：本次运行再传这么多字节即停止（模拟断网）。
    #[doc(hidden)]
    pub interrupt_at: Option<u64>,
}

impl Default for TransferRequest {
    fn default() -> Self {
        Self {
            tab_id: None,
            remote_path: String::new(),
            local_path: PathBuf::new(),
            progress: None,
            progress_tx: None,
            control: TransferControl::default(),
            overwrite: false,
            interrupt_at: None,
        }
    }
}

/// 下载：远端 → 本地 `.part` → rename 到目标。
pub async fn download(
    ssh: SharedSsh,
    db: &Database,
    req: TransferRequest,
) -> Result<TransferResultDto, ErrorDto> {
    if !req.overwrite && tokio::fs::try_exists(&req.local_path).await.unwrap_or(false) {
        return Err(target_exists(&req.local_path));
    }

    let session = open_session(&ssh).await?;
    let meta = session
        .metadata(req.remote_path.clone())
        .await
        .map_err(map_sftp_err)?;
    if meta.is_dir() {
        return Err(ErrorDto::new(
            ErrorCode::SftpProtocol,
            format!("远端路径不是普通文件：{}", req.remote_path),
        ));
    }
    let total = meta.len();
    drop(session);

    let part = part_path(&req.local_path);
    let part_len = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    let local_str = req.local_path.to_string_lossy().to_string();
    let job_id = db
        .upsert_transfer_job(
            "download",
            req.tab_id.as_deref(),
            &req.remote_path,
            &local_str,
            total as i64,
        )
        .map_err(db_err)?;
    let mut resume = resume_from_db(db, &job_id)?;
    // `.part` 比库里记录的偏移还短时，以实际文件为准。
    resume = resume.min(part_len).min(total);

    let file = tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&part)
        .await
        .map_err(map_io)?;
    if resume == 0 {
        file.set_len(0).await.map_err(map_io)?;
    }
    drop(file);

    let plan = Arc::new(Plan::new(total, resume));
    let progress = Arc::new(SharedProgress::new(
        total,
        resume,
        req.interrupt_at,
        req.control.clone(),
    ));
    let mut set = JoinSet::new();
    for _ in 0..SFTP_CHANNELS {
        set.spawn(download_worker(
            ssh.clone(),
            req.remote_path.clone(),
            part.clone(),
            plan.clone(),
            progress.clone(),
        ));
    }

    let started = Instant::now();
    pump(
        db,
        &req.progress,
        &req.progress_tx,
        &job_id,
        plan.clone(),
        progress.clone(),
        set,
    )
    .await?;

    if req.overwrite {
        match tokio::fs::remove_file(&req.local_path).await {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(map_io(err)),
        }
    } else if tokio::fs::try_exists(&req.local_path).await.unwrap_or(false) {
        // 完成前复查一次，避免与并发写盘抢同一目标。
        return Err(target_exists(&req.local_path));
    }
    tokio::fs::rename(&part, &req.local_path)
        .await
        .map_err(map_io)?;
    db.finish_transfer_job(&job_id, "done", total as i64, None)
        .map_err(db_err)?;

    let result = TransferResultDto {
        job_id: job_id.clone(),
        transferred: total,
        total,
        resumed_bytes: resume,
        elapsed_ms: started.elapsed().as_millis() as u64,
        mbps: mb_per_sec(total.saturating_sub(resume), started.elapsed()),
    };
    emit(
        &req.progress,
        &req.progress_tx,
        TransferMsg::Done {
            job_id,
            transferred: total,
            total,
            mbps: result.mbps,
            elapsed_ms: result.elapsed_ms,
            resumed_bytes: resume,
        },
    );
    Ok(result)
}

/// 上传：本地 → 远端 `.part` → rename 到目标。
pub async fn upload(
    ssh: SharedSsh,
    db: &Database,
    req: TransferRequest,
) -> Result<TransferResultDto, ErrorDto> {
    let meta = tokio::fs::metadata(&req.local_path).await.map_err(map_io)?;
    if !meta.is_file() {
        return Err(ErrorDto::internal(format!(
            "本地路径不是普通文件：{}",
            req.local_path.display()
        )));
    }
    let total = meta.len();

    let session = open_session(&ssh).await?;
    // 冲突检查：未选择覆盖时，远端目标已存在则明确失败。
    if !req.overwrite {
        match session.try_exists(req.remote_path.clone()).await {
            Ok(true) => return Err(target_exists(Path::new(&req.remote_path))),
            Ok(false) => {}
            Err(err) => return Err(map_sftp_err(err)),
        }
    }
    drop(session);

    let remote_part = format!("{}.part", req.remote_path);
    let local_str = req.local_path.to_string_lossy().to_string();
    let job_id = db
        .upsert_transfer_job(
            "upload",
            req.tab_id.as_deref(),
            &req.remote_path,
            &local_str,
            total as i64,
        )
        .map_err(db_err)?;
    let mut resume = resume_from_db(db, &job_id)?.min(total);
    if resume > 0 {
        // 远端 `.part` 被人为删除时不能凭库里的偏移“空跳”，从 0 重传。
        let session = open_session(&ssh).await?;
        let exists = session
            .try_exists(remote_part.clone())
            .await
            .map_err(map_sftp_err)?;
        drop(session);
        if !exists {
            resume = 0;
        }
    }

    // 准备远端 `.part`：续传时保留内容，全新开始时截断创建。
    let session = open_session(&ssh).await?;
    let flags = if resume == 0 {
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
    } else {
        OpenFlags::WRITE
    };
    session
        .open_with_flags(remote_part.clone(), flags)
        .await
        .map_err(map_sftp_err)?;
    drop(session);

    let plan = Arc::new(Plan::new(total, resume));
    let progress = Arc::new(SharedProgress::new(
        total,
        resume,
        req.interrupt_at,
        req.control.clone(),
    ));
    let mut set = JoinSet::new();
    for _ in 0..SFTP_CHANNELS {
        set.spawn(upload_worker(
            ssh.clone(),
            remote_part.clone(),
            req.local_path.clone(),
            plan.clone(),
            progress.clone(),
        ));
    }

    let started = Instant::now();
    pump(
        db,
        &req.progress,
        &req.progress_tx,
        &job_id,
        plan.clone(),
        progress.clone(),
        set,
    )
    .await?;

    let session = open_session(&ssh).await?;
    let exists = session
        .try_exists(req.remote_path.clone())
        .await
        .map_err(map_sftp_err)?;
    if exists {
        if !req.overwrite {
            // 完成前再查一次，避免与并发操作抢同一目标。
            return Err(target_exists(Path::new(&req.remote_path)));
        }
        match session.remove_file(req.remote_path.clone()).await {
            Ok(_) => {}
            Err(SftpError::Status(status))
                if status.status_code == StatusCode::NoSuchFile => {}
            Err(err) => return Err(map_sftp_err(err)),
        }
    }
    session
        .rename(remote_part.clone(), req.remote_path.clone())
        .await
        .map_err(map_sftp_err)?;
    drop(session);

    db.finish_transfer_job(&job_id, "done", total as i64, None)
        .map_err(db_err)?;

    let result = TransferResultDto {
        job_id: job_id.clone(),
        transferred: total,
        total,
        resumed_bytes: resume,
        elapsed_ms: started.elapsed().as_millis() as u64,
        mbps: mb_per_sec(total.saturating_sub(resume), started.elapsed()),
    };
    emit(
        &req.progress,
        &req.progress_tx,
        TransferMsg::Done {
            job_id,
            transferred: total,
            total,
            mbps: result.mbps,
            elapsed_ms: result.elapsed_ms,
            resumed_bytes: resume,
        },
    );
    Ok(result)
}

// ---------------------------------------------------------------------------
// 编排循环
// ---------------------------------------------------------------------------

/// 等待所有 worker 结束，同时每 50ms 合并进度、每 100ms 落库续传偏移。
async fn pump(
    db: &Database,
    progress_channel: &Option<Channel<TransferMsg>>,
    progress_tx: &Option<mpsc::UnboundedSender<TransferMsg>>,
    job_id: &str,
    plan: Arc<Plan>,
    progress: Arc<SharedProgress>,
    mut set: JoinSet<Result<(), ErrorDto>>,
) -> Result<(), ErrorDto> {
    let mut ticker = tokio::time::interval(Duration::from_millis(SFTP_PROGRESS_INTERVAL_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut coalescer = ProgressCoalescer::default();
    let mut last_save = Instant::now();
    let started = Instant::now();
    let mut first_error: Option<ErrorDto> = None;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let transferred = progress.transferred();
                if coalescer.should_emit(transferred, progress.total) {
                    emit(progress_channel, progress_tx, TransferMsg::Progress {
                        job_id: job_id.to_string(),
                        transferred,
                        total: progress.total,
                        mbps: mb_per_sec(transferred.saturating_sub(progress.resume), started.elapsed()),
                    });
                }
                if last_save.elapsed() >= Duration::from_millis(SFTP_SAVE_INTERVAL_MS) {
                    save_offset(db, job_id, plan.offset())?;
                    last_save = Instant::now();
                }
            }
            joined = set.join_next() => {
                match joined {
                    None => break,
                    Some(Ok(Ok(()))) => {}
                    Some(Ok(Err(err))) => {
                        if first_error.is_none() {
                            first_error = Some(err);
                        }
                        // 协作式停止：让其余 worker 在本次请求返回后自行退出，
                        // 避免 JoinSet 硬 abort 在请求在途时丢会话，触发 SSH 通道
                        // 关闭竞态（russh 会以 WrongChannel 断开整条连接）。
                        progress.request_stop();
                    }
                    Some(Err(err)) if err.is_cancelled() => {}
                    Some(Err(err)) => {
                        if first_error.is_none() {
                            first_error = Some(ErrorDto::internal(format!("传输任务异常：{err}")));
                        }
                        progress.request_stop();
                    }
                }
            }
        }
    }
    while set.join_next().await.is_some() {}

    if let Some(err) = first_error {
        save_offset(db, job_id, plan.offset())?;
        db.finish_transfer_job(job_id, "paused", plan.offset() as i64, Some(err.code))
            .map_err(db_err)?;
        emit(
            progress_channel,
            progress_tx,
            TransferMsg::Failed {
                job_id: job_id.to_string(),
                code: err.code,
                message: err.message.clone(),
            },
        );
        return Err(err);
    }

    save_offset(db, job_id, plan.offset())?;
    Ok(())
}

fn save_offset(db: &Database, job_id: &str, offset: u64) -> Result<(), ErrorDto> {
    db.save_transfer_offset(job_id, offset as i64)
        .map_err(db_err)
}

// ---------------------------------------------------------------------------
// 传输 worker
// ---------------------------------------------------------------------------

async fn download_worker(
    ssh: SharedSsh,
    remote: String,
    part: PathBuf,
    plan: Arc<Plan>,
    progress: Arc<SharedProgress>,
) -> Result<(), ErrorDto> {
    let session = open_session(&ssh).await?;
    let mut remote_file = session.open(remote).await.map_err(map_sftp_err)?;
    let local = tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&part)
        .await
        .map_err(map_io)?;
    let local = Arc::new(Mutex::new(local));
    let mut buf = vec![0u8; SFTP_CHUNK_BYTES as usize];

    while let Some(idx) = plan.claim() {
        let off = plan.offset_of(idx);
        let len = plan.len_of(idx);
        remote_file
            .seek(tokio::io::SeekFrom::Start(off))
            .await
            .map_err(map_io)?;
        let mut done = 0u64;
        while done < len {
            let want = ((len - done) as usize).min(buf.len());
            let n = remote_file
                .read(&mut buf[..want])
                .await
                .map_err(map_io)?;
            if n == 0 {
                return Err(ErrorDto::new(
                    ErrorCode::SftpProtocol,
                    format!("远端文件提前结束：已读 {off}+{done} 字节"),
                ));
            }
            {
                let mut lf = local.lock().await;
                lf.seek(tokio::io::SeekFrom::Start(off + done))
                    .await
                    .map_err(map_io)?;
                lf.write_all(&buf[..n]).await.map_err(map_io)?;
            }
            done += n as u64;
            if progress.add(n as u64) {
                return Err(interrupted());
            }
        }
        plan.complete(idx);
    }
    Ok(())
}

async fn upload_worker(
    ssh: SharedSsh,
    remote_part: String,
    local_path: PathBuf,
    plan: Arc<Plan>,
    progress: Arc<SharedProgress>,
) -> Result<(), ErrorDto> {
    let session = open_session(&ssh).await?;
    let mut remote_file = session
        .open_with_flags(remote_part, OpenFlags::WRITE)
        .await
        .map_err(map_sftp_err)?;
    let mut local = tokio::fs::File::open(&local_path).await.map_err(map_io)?;
    let mut buf = vec![0u8; SFTP_CHUNK_BYTES as usize];

    while let Some(idx) = plan.claim() {
        let off = plan.offset_of(idx);
        let len = plan.len_of(idx);
        local
            .seek(tokio::io::SeekFrom::Start(off))
            .await
            .map_err(map_io)?;
        remote_file
            .seek(tokio::io::SeekFrom::Start(off))
            .await
            .map_err(map_io)?;
        let mut done = 0u64;
        while done < len {
            let want = ((len - done) as usize).min(buf.len());
            let n = local.read(&mut buf[..want]).await.map_err(map_io)?;
            if n == 0 {
                return Err(ErrorDto::internal(format!(
                    "本地文件提前结束：已读 {off}+{done} 字节"
                )));
            }
            remote_file
                .write_all(&buf[..n])
                .await
                .map_err(map_io)?;
            done += n as u64;
            if progress.add(n as u64) {
                remote_file.flush().await.ok();
                return Err(interrupted());
            }
        }
        // 等待本轮写入全部拿到服务端 ack，再推进续传前沿。
        remote_file.flush().await.map_err(map_io)?;
        plan.complete(idx);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 续传计划与进度
// ---------------------------------------------------------------------------

/// 按块切分的续传计划：所有 worker 通过 `claim` 抢块，`frontier` 记录连续完成的位置。
struct Plan {
    chunk: u64,
    total: u64,
    chunks: u64,
    cursor: AtomicU64,
    frontier: AtomicU64,
    done: StdMutex<Vec<bool>>,
}

impl Plan {
    fn new(total: u64, resume: u64) -> Self {
        let chunk = SFTP_CHUNK_BYTES;
        let chunks = total.div_ceil(chunk);
        let start = if resume >= total { chunks } else { resume / chunk };
        let mut done: Vec<bool> = vec![false; chunks as usize];
        for slot in done.iter_mut().take(start as usize) {
            *slot = true;
        }
        Self {
            chunk,
            total,
            chunks,
            cursor: AtomicU64::new(start),
            frontier: AtomicU64::new(start),
            done: StdMutex::new(done),
        }
    }

    fn claim(&self) -> Option<u64> {
        let idx = self.cursor.fetch_add(1, Ordering::Relaxed);
        (idx < self.chunks).then_some(idx)
    }

    fn complete(&self, idx: u64) {
        if let Ok(mut done) = self.done.lock() {
            if let Some(slot) = done.get_mut(idx as usize) {
                *slot = true;
            }
            let mut frontier = self.frontier.load(Ordering::Relaxed);
            while done.get(frontier as usize).copied().unwrap_or(false) {
                frontier += 1;
            }
            self.frontier.store(frontier, Ordering::Relaxed);
        }
    }

    fn offset_of(&self, idx: u64) -> u64 {
        idx * self.chunk
    }

    fn len_of(&self, idx: u64) -> u64 {
        (self.total - self.offset_of(idx)).min(self.chunk)
    }

    /// 连续完成的前沿（字节），用于断点续传落库。
    fn offset(&self) -> u64 {
        (self.frontier.load(Ordering::Relaxed) * self.chunk).min(self.total)
    }
}

struct SharedProgress {
    total: u64,
    resume: u64,
    bytes: AtomicU64,
    interrupt_at: Option<u64>,
    control: TransferControl,
    /// 内部协作式停止（某个 worker 出错后通知其余 worker 干净退出），
    /// 与用户取消/暂停分开，避免把失败误标成取消。
    stop: AtomicBool,
}

impl SharedProgress {
    fn new(
        total: u64,
        resume: u64,
        interrupt_at: Option<u64>,
        control: TransferControl,
    ) -> Self {
        Self {
            total,
            resume,
            bytes: AtomicU64::new(0),
            interrupt_at,
            control,
            stop: AtomicBool::new(false),
        }
    }

    fn request_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    fn transferred(&self) -> u64 {
        (self.resume + self.bytes.load(Ordering::Relaxed)).min(self.total)
    }

    /// 累加本次已传字节；返回 true 表示需要中止（取消/暂停/出错停止/测试注入）。
    fn add(&self, n: u64) -> bool {
        if self.stop.load(Ordering::Relaxed)
            || self.control.cancel.load(Ordering::Relaxed)
            || self.control.pause.load(Ordering::Relaxed)
        {
            return true;
        }
        let now = self.bytes.fetch_add(n, Ordering::Relaxed) + n;
        match self.interrupt_at {
            Some(limit) => self.resume + now >= limit,
            None => false,
        }
    }
}

/// 进度合并：50ms 一跳，累计 ≥16KB（或收尾）才发一帧。
#[derive(Default)]
pub struct ProgressCoalescer {
    last: u64,
}

impl ProgressCoalescer {
    pub fn should_emit(&mut self, transferred: u64, total: u64) -> bool {
        let delta = transferred.saturating_sub(self.last);
        let finished = total > 0 && transferred >= total && delta > 0;
        if delta >= SFTP_PROGRESS_MIN_BYTES || finished {
            self.last = transferred;
            true
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------
// SSH / SFTP 会话与错误映射
// ---------------------------------------------------------------------------

/// 在同一 SSH 连接上开一条独立 channel 并请求 `sftp` subsystem。
///
/// `tab_id` 在握手完成前就会返回给前端，因此 SFTP 侧可能先于认证到达：
/// 句柄尚未写入时在这里做短等待（100ms 一跳，最多 [`SFTP_READY_WAIT`]），
/// 避免刚连上时的首次列表 / 入队传输直接报 `CHANNEL_CLOSED`。
async fn open_stream(
    ssh: &SharedSsh,
) -> Result<russh::ChannelStream<russh::client::Msg>, ErrorDto> {
    let deadline = Instant::now() + SFTP_READY_WAIT;
    loop {
        let mut guard = ssh.lock().await;
        let Some(handle) = guard.as_mut() else {
            drop(guard);
            if Instant::now() >= deadline {
                return Err(ErrorDto::new(
                    ErrorCode::ChannelClosed,
                    "SSH 会话尚未就绪，无法开始传输",
                ));
            }
            tokio::time::sleep(SFTP_READY_POLL).await;
            continue;
        };

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| ErrorDto::new(ErrorCode::ChannelClosed, format!("打开通道失败：{e}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| {
                ErrorDto::new(ErrorCode::ChannelClosed, format!("请求 sftp 子系统失败：{e}"))
            })?;
        return Ok(channel.into_stream());
    }
}

/// 等待 SSH 句柄就绪的上限与轮询间隔。
const SFTP_READY_WAIT: Duration = Duration::from_secs(8);
const SFTP_READY_POLL: Duration = Duration::from_millis(100);

fn sftp_config() -> russh_sftp::client::Config {
    russh_sftp::client::Config {
        max_packet_len: SFTP_REQUEST_BYTES as u32,
        max_concurrent_reads: SFTP_INFLIGHT_PER_CHANNEL,
        max_concurrent_writes: SFTP_INFLIGHT_PER_CHANNEL,
        max_write_packet_len: SFTP_REQUEST_BYTES as u32,
        request_timeout_secs: 30,
    }
}

/// 高层会话：单文件传输使用。
async fn open_session(ssh: &SharedSsh) -> Result<SftpSession, ErrorDto> {
    let stream = open_stream(ssh).await?;
    SftpSession::new_with_config(stream, sftp_config())
        .await
        .map_err(map_sftp_err)
}

/// 原始会话：目录列表按批 `readdir`，避免一次性缓冲整个大目录。
pub(crate) async fn open_raw_session(ssh: &SharedSsh) -> Result<RawSftpSession, ErrorDto> {
    let raw = RawSftpSession::new_with_config(open_stream(ssh).await?, sftp_config());
    raw.init().await.map_err(map_sftp_err)?;
    Ok(raw)
}

/// 远端路径是否存在（队列的 Rename 冲突策略用来挑选不冲突的名字）。
pub async fn remote_exists(ssh: SharedSsh, path: String) -> Result<bool, ErrorDto> {
    let session = open_session(&ssh).await?;
    session.try_exists(path).await.map_err(map_sftp_err)
}

/// 远端新建目录（单层，父目录需已存在）。
pub async fn create_dir(ssh: SharedSsh, path: String) -> Result<(), ErrorDto> {
    let session = open_session(&ssh).await?;
    session.create_dir(path).await.map_err(map_sftp_err)
}

/// 远端重命名 / 移动。
pub async fn rename_path(ssh: SharedSsh, from: String, to: String) -> Result<(), ErrorDto> {
    let session = open_session(&ssh).await?;
    session.rename(from, to).await.map_err(map_sftp_err)
}

/// 远端删除：目录走 rmdir（要求为空），文件走 unlink。
pub async fn remove_path(ssh: SharedSsh, path: String, is_dir: bool) -> Result<(), ErrorDto> {
    let session = open_session(&ssh).await?;
    if is_dir {
        session.remove_dir(path).await.map_err(map_sftp_err)
    } else {
        session.remove_file(path).await.map_err(map_sftp_err)
    }
}

fn map_sftp_err(err: SftpError) -> ErrorDto {
    if let SftpError::Status(status) = &err {
        return match status.status_code {
            StatusCode::PermissionDenied => {
                ErrorDto::new(ErrorCode::SftpPermissionDenied, status.error_message.clone())
            }
            StatusCode::NoSuchFile => {
                ErrorDto::new(ErrorCode::SftpNoSuchFile, status.error_message.clone())
            }
            _ => ErrorDto::new(ErrorCode::SftpProtocol, status.error_message.clone()),
        };
    }
    if matches!(err, SftpError::Timeout) {
        return ErrorDto::new(ErrorCode::NetTimeout, "SFTP 请求超时");
    }
    ErrorDto::new(ErrorCode::SftpProtocol, err.to_string())
}

fn map_io(err: std::io::Error) -> ErrorDto {
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        return ErrorDto::new(ErrorCode::SftpPermissionDenied, err.to_string());
    }
    ErrorDto::new(ErrorCode::SftpProtocol, err.to_string())
}

fn db_err(err: crate::db::DbError) -> ErrorDto {
    ErrorDto::internal(err.to_string())
}

fn target_exists(path: &Path) -> ErrorDto {
    ErrorDto::new(
        ErrorCode::SftpTargetExists,
        format!("目标已存在：{}", path.display()),
    )
}

fn interrupted() -> ErrorDto {
    ErrorDto::new(ErrorCode::TransferInterrupted, "传输被中断，可从断点继续")
}

fn part_path(target: &Path) -> PathBuf {
    let mut os = target.as_os_str().to_os_string();
    os.push(".part");
    PathBuf::from(os)
}

fn resume_from_db(db: &Database, job_id: &str) -> Result<u64, ErrorDto> {
    Ok(db
        .get_transfer_job(job_id)
        .map_err(db_err)?
        .filter(|j| j.state != "done")
        .map(|j| j.offset_bytes.max(0) as u64)
        .unwrap_or(0))
}

fn emit(
    channel: &Option<Channel<TransferMsg>>,
    tx: &Option<mpsc::UnboundedSender<TransferMsg>>,
    msg: TransferMsg,
) {
    if let Some(tx) = tx {
        let _ = tx.send(msg.clone());
    }
    if let Some(ch) = channel {
        if let Err(err) = ch.send(msg) {
            tracing::warn!(target: "sftp", %err, "progress channel closed");
        }
    }
}

fn mb_per_sec(bytes: u64, elapsed: Duration) -> f64 {
    let secs = elapsed.as_secs_f64();
    if secs <= 0.0 {
        return 0.0;
    }
    (bytes as f64 / 1024.0 / 1024.0) / secs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_resumes_at_chunk_boundary_and_tracks_frontier() {
        let plan = Plan::new(10 * SFTP_CHUNK_BYTES, 3 * SFTP_CHUNK_BYTES);
        assert_eq!(plan.claim(), Some(3), "从断点所在块继续");
        plan.complete(3);
        assert_eq!(plan.offset(), 4 * SFTP_CHUNK_BYTES);
        // 乱序完成不会推进前沿
        plan.complete(6);
        assert_eq!(plan.offset(), 4 * SFTP_CHUNK_BYTES);
        plan.complete(4);
        plan.complete(5);
        assert_eq!(plan.offset(), 7 * SFTP_CHUNK_BYTES);
    }

    #[test]
    fn plan_last_chunk_is_partial() {
        let plan = Plan::new(SFTP_CHUNK_BYTES + 100, 0);
        assert_eq!(plan.len_of(0), SFTP_CHUNK_BYTES);
        assert_eq!(plan.len_of(1), 100);
    }

    #[test]
    fn progress_coalescer_respects_threshold_and_final_frame() {
        let mut c = ProgressCoalescer::default();
        assert!(!c.should_emit(1024, 1024 * 1024), "1KB 不足以发帧");
        assert!(c.should_emit(SFTP_PROGRESS_MIN_BYTES, 1024 * 1024));
        assert!(!c.should_emit(SFTP_PROGRESS_MIN_BYTES + 1024, 1024 * 1024));
        assert!(c.should_emit(1024 * 1024, 1024 * 1024), "收尾帧必须发出");
    }
}
