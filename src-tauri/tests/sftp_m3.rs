//! M3 无头验收：队列暂停/继续/取消、冲突三种选择、取消后续传、万级目录分页。
//!
//! 全部走 `fixture_sshd` 进程内服务端；不启动任何可见窗口。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ssh_terminal_lib::db::Database;
use ssh_terminal_lib::ipc::dto::{ConnectionInput, TransferTaskDto};
use ssh_terminal_lib::sftp::dir::list_dir;
use ssh_terminal_lib::sftp::SharedSsh;
use ssh_terminal_lib::transfer::{ConflictChoice, EnqueueItem, TransferManager};
use tokio::sync::Mutex;

const USER: &str = "alice";
const PASS: &str = "secret";
const KB: u64 = 1024;
const MB: u64 = 1024 * KB;

/// 传输类用例串行，避免 debug 构建下多路 SSH 加密互抢 CPU。
static HEAVY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Fixture {
    child: Child,
    root: PathBuf,
    #[allow(dead_code)]
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
    let root = std::env::temp_dir().join(format!("sshtool-m3-{port}"));
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

async fn connect(port: u16) -> SharedSsh {
    let (handle, channel) = ssh_terminal_lib::ssh::open_shell(&input(port), 80, 24, None)
        .await
        .expect("connect");
    drop(channel);
    Arc::new(Mutex::new(Some(handle)))
}

fn local_dir(tag: u16) -> PathBuf {
    let path = std::env::temp_dir().join(format!("sshtool-m3-local-{tag}"));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("create local dir");
    path
}

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

async fn wait_state(
    manager: &Arc<TransferManager>,
    id: &str,
    expected: &[&str],
    timeout: Duration,
) -> TransferTaskDto {
    let deadline = Instant::now() + timeout;
    loop {
        let current = manager.list().into_iter().find(|t| t.id == id);
        if let Some(task) = current {
            if expected.contains(&task.state) {
                return task;
            }
        }
        if Instant::now() > deadline {
            panic!(
                "等待任务状态 {:?} 超时；当前 {:?}",
                expected,
                manager.list()
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_progress(
    manager: &Arc<TransferManager>,
    id: &str,
    min_bytes: u64,
    timeout: Duration,
) -> TransferTaskDto {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(task) = manager.list().into_iter().find(|t| t.id == id) {
            if task.transferred >= min_bytes {
                return task;
            }
        }
        if Instant::now() > deadline {
            panic!("等待进度 >= {min_bytes} 超时");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn enqueue_download(remote: &str, local: &Path) -> EnqueueItem {
    EnqueueItem {
        direction: "download".into(),
        tab_id: "test-tab".into(),
        remote_path: remote.to_string(),
        local_path: local.to_string_lossy().to_string(),
    }
}

#[tokio::test]
async fn m3_queue_pause_then_resume_completes() {
    let _guard = HEAVY.lock().await;
    let fixture = start_fixture(2321).await;
    let ssh = connect(fixture.port).await;
    let db = Database::open_memory().expect("db");
    let manager = Arc::new(TransferManager::new());
    let local = local_dir(2321);
    let dest = local.join("pause.bin");
    write_pattern(&fixture.root.join("pause.bin"), 8 * MB);

    let ids = manager
        .enqueue(
            &db,
            ssh.clone(),
            vec![enqueue_download("/pause.bin", &dest)],
            None,
        )
        .await
        .expect("enqueue");
    let id = ids[0].clone();

    // 等到连续前沿足够大，确保暂停时库中已落下的偏移 > 0。
    wait_progress(&manager, &id, 4 * MB, Duration::from_secs(30)).await;
    manager.pause(&id).expect("pause");
    let paused = wait_state(&manager, &id, &["paused"], Duration::from_secs(30)).await;
    assert!(paused.transferred < 8 * MB, "暂停时不应已完成");
    let part = PathBuf::from(format!("{}.part", dest.to_string_lossy()));
    assert!(part.exists(), "暂停后必须保留 .part");

    manager.resume(&id).expect("resume");
    let done = wait_state(&manager, &id, &["done"], Duration::from_secs(60)).await;
    assert_eq!(done.total, 8 * MB);
    assert!(done.resumed_bytes > 0, "继续后应复用暂停时保存的偏移");
    assert!(files_equal(&dest, &fixture.root.join("pause.bin")).unwrap());
    assert!(!part.exists(), "完成后应移除 .part");
}

#[tokio::test]
async fn m3_conflict_overwrite_skip_rename() {
    let _guard = HEAVY.lock().await;
    let fixture = start_fixture(2322).await;
    let ssh = connect(fixture.port).await;
    let db = Database::open_memory().expect("db");
    let manager = Arc::new(TransferManager::new());
    let local = local_dir(2322);

    // 覆盖
    write_pattern(&fixture.root.join("cover.bin"), 256 * KB);
    let cover = local.join("cover.bin");
    std::fs::write(&cover, b"old-content").unwrap();
    let id = manager
        .enqueue(
            &db,
            ssh.clone(),
            vec![enqueue_download("/cover.bin", &cover)],
            None,
        )
        .await
        .unwrap()[0]
        .clone();
    wait_state(&manager, &id, &["conflict"], Duration::from_secs(20)).await;
    manager
        .resolve(&id, ConflictChoice::Overwrite)
        .await
        .expect("overwrite");
    wait_state(&manager, &id, &["done"], Duration::from_secs(30)).await;
    assert!(files_equal(&cover, &fixture.root.join("cover.bin")).unwrap());
    assert!(std::fs::metadata(&cover).unwrap().len() == 256 * KB);

    // 跳过
    write_pattern(&fixture.root.join("skip.bin"), 128 * KB);
    let skip = local.join("skip.bin");
    std::fs::write(&skip, b"keep-me").unwrap();
    let id = manager
        .enqueue(
            &db,
            ssh.clone(),
            vec![enqueue_download("/skip.bin", &skip)],
            None,
        )
        .await
        .unwrap()[0]
        .clone();
    wait_state(&manager, &id, &["conflict"], Duration::from_secs(20)).await;
    manager.resolve(&id, ConflictChoice::Skip).await.expect("skip");
    wait_state(&manager, &id, &["skipped"], Duration::from_secs(10)).await;
    assert_eq!(std::fs::read(&skip).unwrap(), b"keep-me");
    assert!(!fixture.root.join("skip.bin.part").exists());

    // 重命名
    write_pattern(&fixture.root.join("rename.bin"), 128 * KB);
    let rename_dest = local.join("rename.bin");
    std::fs::write(&rename_dest, b"do-not-touch").unwrap();
    let id = manager
        .enqueue(
            &db,
            ssh.clone(),
            vec![enqueue_download("/rename.bin", &rename_dest)],
            None,
        )
        .await
        .unwrap()[0]
        .clone();
    wait_state(&manager, &id, &["conflict"], Duration::from_secs(20)).await;
    manager
        .resolve(
            &id,
            ConflictChoice::Rename {
                new_name: Some("rename-copy.bin".into()),
            },
        )
        .await
        .expect("rename");
    let done = wait_state(&manager, &id, &["done"], Duration::from_secs(30)).await;
    assert_eq!(done.local_path, local.join("rename-copy.bin").to_string_lossy());
    assert!(files_equal(
        &local.join("rename-copy.bin"),
        &fixture.root.join("rename.bin")
    )
    .unwrap());
    assert_eq!(std::fs::read(&rename_dest).unwrap(), b"do-not-touch");
}

#[tokio::test]
async fn m3_cancel_keeps_part_and_re_enqueue_resumes() {
    let _guard = HEAVY.lock().await;
    let fixture = start_fixture(2323).await;
    let ssh = connect(fixture.port).await;
    let db = Database::open_memory().expect("db");
    let manager = Arc::new(TransferManager::new());
    let local = local_dir(2323);
    let dest = local.join("cancel.bin");
    write_pattern(&fixture.root.join("cancel.bin"), 8 * MB);

    let id = manager
        .enqueue(
            &db,
            ssh.clone(),
            vec![enqueue_download("/cancel.bin", &dest)],
            None,
        )
        .await
        .unwrap()[0]
        .clone();
    // 等到连续前沿足够大，取消时库中的偏移才非零，续传断言才有意义。
    wait_progress(&manager, &id, 4 * MB, Duration::from_secs(30)).await;
    manager.cancel(&id).expect("cancel");
    wait_state(&manager, &id, &["cancelled"], Duration::from_secs(30)).await;

    let part = PathBuf::from(format!("{}.part", dest.to_string_lossy()));
    assert!(part.exists(), "取消后必须保留 .part");
    assert!(!dest.exists(), "取消后不应产生最终文件");

    let id = manager
        .enqueue(
            &db,
            ssh.clone(),
            vec![enqueue_download("/cancel.bin", &dest)],
            None,
        )
        .await
        .unwrap()[0]
        .clone();
    let done = wait_state(&manager, &id, &["done"], Duration::from_secs(60)).await;
    assert!(done.resumed_bytes > 0, "重新入队应复用 .part 偏移");
    assert!(files_equal(&dest, &fixture.root.join("cancel.bin")).unwrap());
    assert!(!part.exists());
}

#[tokio::test]
async fn m3_list_10k_entries_paginates_remotely_and_locally() {
    let fixture = start_fixture(2324).await;
    for i in 0..10_000u32 {
        std::fs::write(fixture.root.join(format!("f{i:05}.dat")), b"").expect("seed entry");
    }
    let ssh = connect(fixture.port).await;

    // 远端：每页最多 500 条；夹具每次 readdir 只给 100 条，必须多轮拉取。
    let mut pages: Vec<Vec<String>> = Vec::new();
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let total = list_dir(ssh, "/".into(), 500, cancel, |entries| {
        assert!(entries.len() <= 500, "单页不得超过 500 条");
        pages.push(entries.into_iter().map(|e| e.name).collect());
        true
    })
    .await
    .expect("remote list");

    assert_eq!(total, 10_000);
    assert_eq!(pages.len(), 20, "10000 条应切为 20 页");
    assert!(pages.iter().all(|p| p.len() == 500));
    let mut names: Vec<String> = pages.into_iter().flatten().collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), 10_000, "分页不得重复/丢条目");

    // 本地：同样的万级目录按 500 条一页连续拉取。
    let mut seen = 0usize;
    let mut offset = 0usize;
    loop {
        let page =
            ssh_terminal_lib::local::list_dir(fixture.root.to_string_lossy().to_string(), offset, 500)
                .await
                .expect("local list");
        assert!(page.entries.len() <= 500);
        seen += page.entries.len();
        offset = page.next_offset;
        if !page.has_more {
            break;
        }
    }
    assert_eq!(seen, 10_000, "本地分页总数应与目录条目一致");
}
