//! M0/M2 本地 SSH+SFTP 夹具服务：不依赖 Docker/WSL/系统服务，进程内监听 127.0.0.1:2222。
//!
//! 用途：验证客户端闭环（连接、认证、PTY、`stty size`、resize、断线）与 SFTP 单文件传输。
//! 说明：内置一个**极简 shell 模拟器**（非真实 shell），行为确定、可断言：
//! - `echo $TERM` → `xterm-256color`
//! - `stty size`   → `<rows> <cols>`（由 pty_request / window_change 更新）
//! - `bench top <secs>` → 以 2MB/s 输出类 `top` 文本，持续 `<secs>` 秒（性能实测）
//! - `bench burst <mb>` → 尽可能快地输出 `<mb>` MiB 文本（吞吐实测）
//! - `exit`        → 关闭通道
//! - 其它          → `ok: <输入>`
//!
//! SFTP：请求 `sftp` subsystem 时，在 `FIXTURE_SFTP_ROOT`（默认临时目录）下提供本地磁盘后端。
//! 路径中含 `deny` 段时 open 返回 PermissionDenied，用于权限拒绝用例。

use std::collections::HashMap;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::server::{Auth, Config, Handler, Session};
use russh::ChannelId;
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use russh_sftp::server::{StatusReply, Handler as SftpHandler};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;

const DEFAULT_USER: &str = "alice";
const DEFAULT_PASS: &str = "secret";

const TOP_BYTES_PER_SEC: u64 = 2 * 1024 * 1024;

struct SessionHandler {
    term: String,
    cols: u32,
    rows: u32,
    line: String,
    shell_id: Option<ChannelId>,
    /// bench 任务临时取走通道，结束后归还，保证可连续跑多次。
    channels: Arc<Mutex<HashMap<ChannelId, russh::Channel<russh::server::Msg>>>>,
    root: PathBuf,
}

impl SessionHandler {
    fn new(root: PathBuf) -> Self {
        Self {
            term: String::new(),
            cols: 80,
            rows: 24,
            line: String::new(),
            shell_id: None,
            channels: Arc::new(Mutex::new(HashMap::new())),
            root,
        }
    }

    fn write(&self, session: &mut Session, channel: ChannelId, text: &str) {
        session
            .data(channel, russh::CryptoVec::from_slice(text.as_bytes()))
            .ok();
    }

    /// 启动批量输出任务。`args` 形如 `top 30` 或 `burst 64`。
    async fn start_bench(&mut self, args: &str) {
        let mut it = args.split_whitespace();
        let burst = it.next() == Some("burst");
        let amount: u64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(30);
        let Some(channel_id) = self.shell_id else {
            return;
        };
        let slot = self.channels.clone();
        let Some(ch) = slot.lock().await.remove(&channel_id) else {
            return;
        };
        tokio::spawn(async move {
            let start_mark = if burst {
                "@@BENCH_BURST_START@@\r\n"
            } else {
                "@@BENCH_TOP_START@@\r\n"
            };
            let end_mark = if burst {
                "@@BENCH_BURST_END@@\r\n"
            } else {
                "@@BENCH_TOP_END@@\r\n"
            };
            if ch.data(start_mark.as_bytes()).await.is_err() {
                return;
            }

            // 80 列、内容有变化的行，逼迫 xterm 真实重绘而不是复用缓存。
            let mut block = String::with_capacity(96 * 600);
            for i in 0..600u32 {
                block.push_str(&format!(
                    "{:>8} alice  20   0  {:>6}  {:>5}  1234 S  0.{}  0.1  0:{:02}.{:02} fixture-load {:04}\r\n",
                    i * 137,
                    40_000 + i,
                    9_000 + i,
                    i % 10,
                    i % 60,
                    (i * 7) % 100,
                    i % 1000,
                ));
            }

            if burst {
                let total = amount * 1024 * 1024;
                let mut sent = 0u64;
                while sent < total {
                    let n = ((total - sent) as usize).min(block.len());
                    if ch.data(&block.as_bytes()[..n]).await.is_err() {
                        return;
                    }
                    sent += n as u64;
                }
            } else {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(amount);
                let started = tokio::time::Instant::now();
                let mut sent: u64 = 0;
                while tokio::time::Instant::now() < deadline {
                    if ch.data(block.as_bytes()).await.is_err() {
                        return;
                    }
                    sent += block.len() as u64;
                    let ideal = Duration::from_millis(sent * 1000 / TOP_BYTES_PER_SEC);
                    let behind = ideal.saturating_sub(started.elapsed());
                    if !behind.is_zero() {
                        tokio::time::sleep(behind).await;
                    }
                }
            }

            let _ = ch.data(end_mark.as_bytes()).await;
            let _ = ch.data("$ ".as_bytes()).await;
            // 归还通道，允许同一会话继续执行下一条 bench 命令。
            slot.lock().await.insert(channel_id, ch);
        });
    }
}

#[async_trait::async_trait]
impl Handler for SessionHandler {
    type Error = russh::Error;

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        eprintln!("channel open id={:?}", channel.id());
        self.channels.lock().await.insert(channel.id(), channel);
        Ok(true)
    }

    /// 通道关闭时清掉残留句柄：否则同一连接里 ChannelId 复用会拿到已关闭的旧通道。
    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().await.remove(&channel);
        if self.shell_id == Some(channel) {
            self.shell_id = None;
        }
        eprintln!("channel close id={channel:?}");
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        eprintln!("channel eof id={channel:?}");
        Ok(())
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        let expect_user = std::env::var("FIXTURE_USER").unwrap_or_else(|_| DEFAULT_USER.into());
        let expect_pass = std::env::var("FIXTURE_PASS").unwrap_or_else(|_| DEFAULT_PASS.into());
        if user == expect_user && password == expect_pass {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
            })
        }
    }

    /// M4：私钥 / ssh-agent 认证用例。夹具接受配置用户名的任意公钥。
    async fn auth_publickey(
        &mut self,
        user: &str,
        _public_key: &ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        let expect_user = std::env::var("FIXTURE_USER").unwrap_or_else(|_| DEFAULT_USER.into());
        if user == expect_user {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
            })
        }
    }

    /// M4：ProxyJump 夹具——把 direct-tcpip 通道转发到目标端口。
    /// 设置 `FIXTURE_FORWARD_LOG` 时追加一行 `host:port`，测试据此证明流量经过跳板。
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if let Ok(path) = std::env::var("FIXTURE_FORWARD_LOG") {
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                use std::io::Write as _;
                let _ = writeln!(file, "{host_to_connect}:{port_to_connect}");
            }
        }
        let host = host_to_connect.to_string();
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((host.as_str(), port_to_connect as u16)).await {
                Ok(mut tcp) => {
                    tcp.set_nodelay(true).ok();
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
                }
                Err(_) => {
                    let _ = channel.close().await;
                }
            }
        });
        Ok(true)
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.term = term.to_string();
        self.cols = col_width;
        self.rows = row_height;
        session.channel_success(channel).ok();
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel).ok();
        self.shell_id = Some(channel);
        self.write(session, channel, "fixture-sshd ready\r\n$ ");
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.cols = col_width;
        self.rows = row_height;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel).ok();
            return Ok(());
        }
        let Some(ch) = self.channels.lock().await.remove(&channel) else {
            session.channel_failure(channel).ok();
            return Ok(());
        };
        session.channel_success(channel).ok();
        // 与真实 sshd 一样把 SFTP 子系统放到独立任务里跑：
        // 若在此 await 整个会话，会话 handler 会被占住，取消/关闭通道时容易卡死。
        let root = self.root.clone();
        eprintln!("sftp subsystem start id={channel:?} root={}", root.display());
        tokio::spawn(async move {
            russh_sftp::server::run(ch.into_stream(), SftpDisk::new(root)).await;
            // SFTP 会话结束只关这一条通道，SSH 会话本身应继续存活：
            // 结束日志与后续 channel open/close 一起构成“传完还能继续操作”的证据。
            eprintln!("sftp subsystem end id={channel:?}");
        });
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.shell_id != Some(channel) {
            return Ok(());
        }
        for byte in data {
            match *byte {
                b'\r' | b'\n' => {
                    let line = self.line.clone();
                    self.line.clear();
                    self.write(session, channel, "\r\n");
                    let trimmed = line.trim();
                    if let Some(args) = trimmed.strip_prefix("bench ") {
                        self.start_bench(args).await;
                    } else if trimmed == "exit" {
                        session.eof(channel).ok();
                        session.close(channel).ok();
                        return Ok(());
                    } else {
                        let out = self.exec(&line);
                        self.write(session, channel, &out);
                    }
                    self.write(session, channel, "$ ");
                }
                0x7f | 0x08 => {
                    if !self.line.is_empty() {
                        self.line.pop();
                        self.write(session, channel, "\x08 \x08");
                    }
                }
                b if (0x20..0x7f).contains(&b) => {
                    self.line.push(b as char);
                    self.write(session, channel, &(b as char).to_string());
                }
                _ => {}
            }
        }
        Ok(())
    }
}

impl SessionHandler {
    fn exec(&mut self, line: &str) -> String {
        let trimmed = line.trim();
        match trimmed {
            "echo $TERM" => format!(
                "{}\r\n",
                if self.term.is_empty() {
                    "xterm-256color"
                } else {
                    &self.term
                }
            ),
            "stty size" => format!("{} {}\r\n", self.rows, self.cols),
            "" => String::new(),
            other => format!("ok: {other}\r\n"),
        }
    }
}

// ---------------------------------------------------------------------------
// SFTP 本地磁盘后端
// ---------------------------------------------------------------------------

/// 目录句柄游标：模拟服务端按批返回 `Name`，客户端据此流式分页。
struct DirCursor {
    files: Vec<File>,
    next: usize,
}

/// 极简 SFTP 服务端：单文件读写 + 目录列表 + 元数据 + rename/remove。
struct SftpDisk {
    root: PathBuf,
    handles: HashMap<String, tokio::fs::File>,
    dirs: HashMap<String, DirCursor>,
    next_handle: u64,
}

impl SftpDisk {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            handles: HashMap::new(),
            dirs: HashMap::new(),
            next_handle: 0,
        }
    }

    fn resolve(&self, remote: &str) -> Result<PathBuf, StatusReply> {
        let mut path = PathBuf::from(&self.root);
        for comp in Path::new(remote).components() {
            match comp {
                Component::Normal(part) => path.push(part),
                Component::RootDir | Component::CurDir => {}
                Component::ParentDir | Component::Prefix(_) => {
                    return Err(StatusCode::PermissionDenied.with_message("path escapes root"))
                }
            }
        }
        Ok(path)
    }

    fn denied(remote: &str) -> bool {
        Path::new(remote)
            .components()
            .any(|c| matches!(c, Component::Normal(part) if part.eq_ignore_ascii_case("deny")))
    }
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

fn io_err(err: std::io::Error) -> StatusReply {
    match err.kind() {
        std::io::ErrorKind::NotFound => {
            StatusCode::NoSuchFile.with_message(err.to_string())
        }
        std::io::ErrorKind::PermissionDenied => {
            StatusCode::PermissionDenied.with_message(err.to_string())
        }
        _ => StatusCode::Failure.with_message(err.to_string()),
    }
}

impl SftpHandler for SftpDisk {
    type Error = StatusReply;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported.with_message("fixture: unimplemented")
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> impl Future<Output = Result<Handle, Self::Error>> + Send {
        let path = self.resolve(&filename);
        let denied = Self::denied(&filename);
        async move {
            if denied {
                return Err(StatusCode::PermissionDenied.with_message("deny marker"));
            }
            let path = path?;
            let mut opts = tokio::fs::OpenOptions::new();
            opts.read(pflags.contains(OpenFlags::READ))
                .write(pflags.contains(OpenFlags::WRITE) || pflags.contains(OpenFlags::APPEND))
                .create(pflags.contains(OpenFlags::CREATE))
                .truncate(pflags.contains(OpenFlags::TRUNCATE));
            let file = opts.open(&path).await.map_err(io_err)?;
            let handle = format!("h{}", self.next_handle);
            self.next_handle += 1;
            self.handles.insert(handle.clone(), file);
            Ok(Handle { id, handle })
        }
    }

    fn close(
        &mut self,
        id: u32,
        handle: String,
    ) -> impl Future<Output = Result<Status, Self::Error>> + Send {
        self.handles.remove(&handle);
        self.dirs.remove(&handle);
        async move { Ok(ok_status(id)) }
    }

    /// 打开目录并把条目读入游标；`readdir` 每次最多返回 100 条，客户端必须多轮拉取。
    fn opendir(
        &mut self,
        id: u32,
        path: String,
    ) -> impl Future<Output = Result<Handle, Self::Error>> + Send {
        let resolved = self.resolve(&path);
        let denied = Self::denied(&path);
        let result = (|| -> Result<Handle, StatusReply> {
            if denied {
                return Err(StatusCode::PermissionDenied.with_message("deny marker"));
            }
            let path = resolved?;
            let mut files = Vec::new();
            for entry in std::fs::read_dir(&path).map_err(io_err)? {
                let entry = entry.map_err(io_err)?;
                let name = entry.file_name().to_string_lossy().to_string();
                let meta = entry.metadata().map_err(io_err)?;
                files.push(File::new(name, FileAttributes::from(&meta)));
            }
            files.sort_by(|a, b| a.filename.cmp(&b.filename));
            let handle = format!("h{}", self.next_handle);
            self.next_handle += 1;
            self.dirs.insert(
                handle.clone(),
                DirCursor {
                    files,
                    next: 0,
                },
            );
            Ok(Handle { id, handle })
        })();
        async move { result }
    }

    /// M3.5 递归上传需要服务端创建目录。
    fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> impl Future<Output = Result<Status, Self::Error>> + Send {
        let resolved = self.resolve(&path);
        let denied = Self::denied(&path);
        async move {
            if denied {
                return Err(StatusCode::PermissionDenied.with_message("deny marker"));
            }
            std::fs::create_dir(resolved?).map_err(io_err)?;
            Ok(ok_status(id))
        }
    }

    fn readdir(
        &mut self,
        id: u32,
        handle: String,
    ) -> impl Future<Output = Result<Name, Self::Error>> + Send {
        const BATCH: usize = 100;
        let files = self.dirs.get_mut(&handle).map(|cursor| {
            let start = cursor.next;
            let end = (start + BATCH).min(cursor.files.len());
            cursor.next = end;
            cursor.files[start..end].to_vec()
        });
        async move {
            let Some(files) = files else {
                return Err(StatusCode::Failure.with_message("bad dir handle"));
            };
            if files.is_empty() {
                return Err(StatusCode::Eof.with_message("eof"));
            }
            Ok(Name { id, files })
        }
    }

    fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> impl Future<Output = Result<Data, Self::Error>> + Send {
        let file = self.handles.get_mut(&handle);
        async move {
            let file = file.ok_or_else(|| StatusCode::Failure.with_message("bad handle"))?;
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(io_err)?;
            let mut buf = vec![0u8; len as usize];
            let n = file.read(&mut buf).await.map_err(io_err)?;
            if n == 0 {
                return Err(StatusCode::Eof.with_message("eof"));
            }
            buf.truncate(n);
            Ok(Data { id, data: buf })
        }
    }

    fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> impl Future<Output = Result<Status, Self::Error>> + Send {
        let file = self.handles.get_mut(&handle);
        async move {
            let file = file.ok_or_else(|| StatusCode::Failure.with_message("bad handle"))?;
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(io_err)?;
            file.write_all(&data).await.map_err(io_err)?;
            Ok(ok_status(id))
        }
    }

    fn fstat(
        &mut self,
        id: u32,
        handle: String,
    ) -> impl Future<Output = Result<Attrs, Self::Error>> + Send {
        let file = self.handles.get_mut(&handle);
        async move {
            let file = file.ok_or_else(|| StatusCode::Failure.with_message("bad handle"))?;
            let meta = file.metadata().await.map_err(io_err)?;
            Ok(Attrs {
                id,
                attrs: FileAttributes::from(&meta),
            })
        }
    }

    fn stat(
        &mut self,
        id: u32,
        path: String,
    ) -> impl Future<Output = Result<Attrs, Self::Error>> + Send {
        let resolved = self.resolve(&path);
        let denied = Self::denied(&path);
        async move {
            if denied {
                return Err(StatusCode::NoSuchFile.with_message("deny marker"));
            }
            let path = resolved?;
            let meta = tokio::fs::metadata(&path).await.map_err(io_err)?;
            Ok(Attrs {
                id,
                attrs: FileAttributes::from(&meta),
            })
        }
    }

    fn lstat(
        &mut self,
        id: u32,
        path: String,
    ) -> impl Future<Output = Result<Attrs, Self::Error>> + Send {
        self.stat(id, path)
    }

    fn realpath(
        &mut self,
        id: u32,
        path: String,
    ) -> impl Future<Output = Result<Name, Self::Error>> + Send {
        let resolved = self.resolve(&path).unwrap_or_else(|_| self.root.clone());
        async move {
            Ok(Name {
                id,
                files: vec![File::dummy(resolved.to_string_lossy().to_string())],
            })
        }
    }

    fn remove(
        &mut self,
        id: u32,
        filename: String,
    ) -> impl Future<Output = Result<Status, Self::Error>> + Send {
        let resolved = self.resolve(&filename);
        let denied = Self::denied(&filename);
        async move {
            if denied {
                return Err(StatusCode::PermissionDenied.with_message("deny marker"));
            }
            tokio::fs::remove_file(resolved?).await.map_err(io_err)?;
            Ok(ok_status(id))
        }
    }

    fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> impl Future<Output = Result<Status, Self::Error>> + Send {
        let old = self.resolve(&oldpath);
        let new = self.resolve(&newpath);
        let denied = Self::denied(&oldpath) || Self::denied(&newpath);
        async move {
            if denied {
                return Err(StatusCode::PermissionDenied.with_message("deny marker"));
            }
            tokio::fs::rename(old?, new?).await.map_err(io_err)?;
            Ok(ok_status(id))
        }
    }
}

/// 读取或生成固定 host key（OpenSSH 私钥文本）。文件不存在时生成并写回，
/// 便于测试在重启夹具后保持同一指纹，或写入另一把 key 模拟指纹变更。
fn fixture_host_key(path: &str) -> russh::keys::PrivateKey {
    if let Ok(text) = std::fs::read_to_string(path) {
        if !text.trim().is_empty() {
            return russh::keys::decode_secret_key(&text, None).expect("load fixture host key");
        }
    }
    let mut rng = rand_core::OsRng;
    let mut key = russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519)
        .expect("generate fixture host key");
    key.set_comment("fixture-sshd");
    let text = key.to_openssh(ssh_key::LineEnding::LF).expect("encode host key");
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, text.as_bytes()).expect("write fixture host key");
    key
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let port: u16 = std::env::var("FIXTURE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2222);

    let root = std::env::var("FIXTURE_SFTP_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("fixture-sftp"));
    std::fs::create_dir_all(&root).expect("create sftp root");

    // 测试用 host key：`FIXTURE_HOST_KEY` 指定路径时持久化复用（用于 known_host
    // 指纹匹配/变更用例）；未指定则进程内随机生成（仅本地/CI 夹具）。
    let host_key = match std::env::var("FIXTURE_HOST_KEY")
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
    {
        Some(path) => fixture_host_key(&path),
        None => {
            let mut rng = rand_core::OsRng;
            russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519)
                .expect("generate fixture host key")
        }
    };
    let mut config = Config::default();
    config.keys.push(host_key);

    // 自己 accept 以便关掉 Nagle：否则 32KB 数据包会被 delayed-ACK 卡到 ~0.8MB/s。
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(err) => {
            eprintln!("fixture-sshd bind error: {err}");
            std::process::exit(1);
        }
    };
    println!("fixture-sshd listening on 127.0.0.1:{port}");
    let config = Arc::new(config);
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        stream.set_nodelay(true).ok();
        let config = config.clone();
        let root = root.clone();
        tokio::spawn(async move {
            eprintln!("session open");
            match russh::server::run_stream(config, stream, SessionHandler::new(root)).await {
                Ok(session) => {
                    let _ = session.await;
                    eprintln!("session closed");
                }
                Err(err) => eprintln!("fixture-sshd session error: {err}"),
            }
        });
    }
}
