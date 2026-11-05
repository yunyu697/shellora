//! M2 无头集成测试：SFTP 单文件上传/下载、断点续传、冲突与权限拒绝。
//!
//! 全部走本仓库的 `fixture_sshd`（进程内 SSH + SFTP 服务端），不弹任何窗口。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use ssh_terminal_lib::db::Database;
use ssh_terminal_lib::ipc::dto::ConnectionInput;
use ssh_terminal_lib::sftp::{self, SharedSsh, TransferRequest};
use tokio::sync::Mutex;

const USER: &str = "alice";
const PASS: &str = "secret";
const KB: u64 = 1024;
const MB: u64 = 1024 * KB;

/// 大文件用例串行执行：debug 构建下 SSH 加密是 CPU 瓶颈，并跑多个 64MiB 会拖慢到超时。
static HEAVY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Fixture {
    child: Child,
    root: PathBuf,
    port: u16,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
async fn start_fixture(port: u16) -> Fixture {
    let root = std::env::temp_dir().join(format!("sshtool-m2-{port}"));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create fixture root");

    let exe = env!("CARGO_BIN_EXE_fixture_sshd");
    let child = Command::new(exe)
        .env("FIXTURE_PORT", port.to_string())
        .env("FIXTURE_USER", USER)
        .env("FIXTURE_PASS", PASS)
        .env("FIXTURE_SFTP_ROOT", root.to_string_lossy().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn fixture_sshd");

    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Fixture { child, root, port };
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("fixture_sshd did not start on port {port}");
}

fn input(port: u16) -> ConnectionInput {
    ConnectionInput {
        host: "127.0.0.1".into(),
        port,
        username: USER.into(),
        password: PASS.into(),
        cols: 80,
        rows: 24,
        ..ConnectionInput::default()
    }
}

/// 连接夹具，返回可被 SFTP 复用的已认证句柄。
async fn connect(port: u16) -> SharedSsh {
    let (handle, channel) = ssh_terminal_lib::ssh::open_shell(&input(port), 80, 24, None)
        .await
        .expect("connect");
    drop(channel);
    Arc::new(Mutex::new(Some(handle)))
}

async fn wait_ready(ssh: &SharedSsh) {
    // open_shell 返回即已认证并开好 shell，可直接用。
    let guard = ssh.lock().await;
    assert!(guard.is_some(), "SSH 句柄应在连接成功后可用");
}

fn local_dir(port: u16) -> tempdir::TempPath {
    tempdir::TempPath::new(port)
}

/// 测试内的极简临时目录（避免额外依赖）。
mod tempdir {
    use std::path::PathBuf;

    pub struct TempPath {
        path: PathBuf,
    }

    impl TempPath {
        pub fn new(tag: u16) -> Self {
            let path = std::env::temp_dir().join(format!("sshtool-m2-local-{tag}"));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        pub fn join(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }
}

/// 生成位置相关的内容，便于发现错位/丢块。
fn write_pattern(path: &Path, size: u64) {
    let mut file = std::fs::File::create(path).expect("create pattern file");
    let mut buf = vec![0u8; 4096];
    let mut off = 0u64;
    while off < size {
        let n = ((size - off) as usize).min(buf.len());
        for (j, b) in buf[..n].iter_mut().enumerate() {
            let pos = off + j as u64;
            *b = ((pos / 4096) as u8) ^ ((pos % 251) as u8);
        }
        file.write_all(&buf[..n]).expect("write pattern");
        off += n as u64;
    }
}

fn files_equal(a: &Path, b: &Path) -> std::io::Result<bool> {
    let mut fa = std::fs::File::open(a)?;
    let mut fb = std::fs::File::open(b)?;
    let mut ba = vec![0u8; 64 * 1024];
    let mut bb = vec![0u8; 64 * 1024];
    loop {
        let na = fa.read(&mut ba)?;
        let nb = fb.read(&mut bb)?;
        if na != nb {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
        if ba[..na] != bb[..nb] {
            return Ok(false);
        }
    }
}

fn request(remote: String, local: PathBuf) -> TransferRequest {
    TransferRequest {
        tab_id: Some("test-tab".into()),
        remote_path: remote,
        local_path: local,
        ..TransferRequest::default()
    }
}

#[tokio::test]
async fn m2_download_1kb() {
    let fixture = start_fixture(2311).await;
    let ssh = connect(fixture.port).await;
    wait_ready(&ssh).await;
    write_pattern(&fixture.root.join("small.bin"), KB);
    let dir = local_dir(fixture.port);
    let dest = dir.join("small.bin");
    let res = sftp::download(
        ssh,
        &Database::open_memory().unwrap(),
        request("/small.bin".into(), dest.clone()),
    )
    .await
    .expect("download 1KB");
    assert_eq!(res.total, KB);
    assert!(files_equal(&fixture.root.join("small.bin"), &dest).unwrap());
    assert!(!dir.join("small.bin.part").exists(), ".part 应在完成后改名");
}

#[tokio::test]
async fn m2_download_4mb_and_upload_4mb() {
    let _heavy = HEAVY.lock().await;
    let fixture = start_fixture(2312).await;
    let ssh = connect(fixture.port).await;
    wait_ready(&ssh).await;
    let remote_src = fixture.root.join("medium.bin");
    write_pattern(&remote_src, 4 * MB);

    let dir = local_dir(fixture.port);
    let dest = dir.join("medium.bin");
    let started = std::time::Instant::now();
    let res = sftp::download(
        ssh.clone(),
        &Database::open_memory().unwrap(),
        request("/medium.bin".into(), dest.clone()),
    )
    .await
    .expect("download 4MiB");
    println!(
        "[M2] download 4MiB: {:.2} MiB/s ({} ms)",
        res.mbps,
        started.elapsed().as_millis()
    );
    assert!(files_equal(&remote_src, &dest).unwrap());

    // 上传回一个不同的远端路径
    let up = dir.join("up.bin");
    std::fs::copy(&dest, &up).unwrap();
    let res = sftp::upload(
        ssh,
        &Database::open_memory().unwrap(),
        request("/up.bin".into(), up),
    )
    .await
    .expect("upload 4MiB");
    println!("[M2] upload 4MiB: {:.2} MiB/s", res.mbps);
    assert!(files_equal(&fixture.root.join("up.bin"), &dest).unwrap());
}

#[tokio::test]
async fn m2_download_64mb_throughput() {
    let _heavy = HEAVY.lock().await;
    let fixture = start_fixture(2313).await;
    let ssh = connect(fixture.port).await;
    wait_ready(&ssh).await;
    let remote_src = fixture.root.join("large.bin");
    write_pattern(&remote_src, 64 * MB);

    let dir = local_dir(fixture.port);
    let dest = dir.join("large.bin");
    let started = std::time::Instant::now();
    let res = sftp::download(
        ssh,
        &Database::open_memory().unwrap(),
        request("/large.bin".into(), dest.clone()),
    )
    .await
    .expect("download 64MiB");
    println!(
        "[M2] download 64MiB: {:.2} MiB/s ({} ms)",
        res.mbps,
        started.elapsed().as_millis()
    );
    assert!(files_equal(&remote_src, &dest).unwrap());
}

#[tokio::test]
async fn m2_download_resume_after_interrupt() {
    let _heavy = HEAVY.lock().await;
    let fixture = start_fixture(2314).await;
    let ssh = connect(fixture.port).await;
    wait_ready(&ssh).await;
    let remote_src = fixture.root.join("resume.bin");
    write_pattern(&remote_src, 32 * MB);

    let db = Database::open_memory().unwrap();
    let dir = local_dir(fixture.port);
    let dest = dir.join("resume.bin");
    let part = dir.join("resume.bin.part");

    // 第一次：传到约 6MiB 时模拟中断
    let mut req = request("/resume.bin".into(), dest.clone());
    req.interrupt_at = Some(6 * MB);
    let err = sftp::download(ssh.clone(), &db, req)
        .await
        .expect_err("应被中断");
    assert_eq!(err.code, "TRANSFER_INTERRUPTED", "{err:?}");
    assert!(part.exists(), "中断后应保留 .part");
    let partial = std::fs::metadata(&part).unwrap().len();
    assert!(partial > 0 && partial < 32 * MB, "部分文件大小 {partial}");

    // 第二次：从断点继续
    let res = sftp::download(
        ssh,
        &db,
        request("/resume.bin".into(), dest.clone()),
    )
    .await
    .expect("resume download");
    println!(
        "[M2] resume: 已续传 {} KiB，本次 {:.2} MiB/s",
        res.resumed_bytes / KB,
        res.mbps
    );
    assert!(res.resumed_bytes > 0, "应从断点而非 0 开始");
    assert!(files_equal(&remote_src, &dest).unwrap());
}

#[tokio::test]
async fn m2_target_exists_is_explicit() {
    let fixture = start_fixture(2315).await;
    let ssh = connect(fixture.port).await;
    wait_ready(&ssh).await;
    write_pattern(&fixture.root.join("src.bin"), 4 * KB);

    let dir = local_dir(fixture.port);
    let dest = dir.join("src.bin");
    std::fs::write(&dest, b"keep me").unwrap();
    let err = sftp::download(
        ssh,
        &Database::open_memory().unwrap(),
        request("/src.bin".into(), dest.clone()),
    )
    .await
    .expect_err("目标已存在必须失败");
    assert_eq!(err.code, "SFTP_TARGET_EXISTS", "{err:?}");
    assert_eq!(std::fs::read(&dest).unwrap(), b"keep me", "不得静默覆盖");
}

#[tokio::test]
async fn m2_permission_denied_is_explicit() {
    let fixture = start_fixture(2316).await;
    let ssh = connect(fixture.port).await;
    wait_ready(&ssh).await;
    let dir = local_dir(fixture.port);
    let src = dir.join("deny.bin");
    write_pattern(&src, 8 * KB);

    let err = sftp::upload(
        ssh,
        &Database::open_memory().unwrap(),
        request("/deny/deny.bin".into(), src),
    )
    .await
    .expect_err("无权限必须失败");
    assert_eq!(err.code, "SFTP_PERMISSION_DENIED", "{err:?}");
}
