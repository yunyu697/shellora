//! M3.5 无头验收：递归目录传输。
//!
//! 覆盖：目录树递归上传/下载层级正确、深目录（5 层 500 文件）、整组暂停/继续、
//! 整组取消后 `.part` 与偏移保留、整组统一冲突策略、空目录开关、深度/文件数上限提示。
//! 全部走进程内 `fixture_sshd`，不启动任何可见窗口。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ssh_terminal_lib::db::Database;
use ssh_terminal_lib::ipc::dto::{
    ConnectionInput, TransferGroupDto, TransferTaskDto, TreeEnqueueRequest, TreeOptionsDto,
};
use ssh_terminal_lib::sftp::SharedSsh;
use ssh_terminal_lib::transfer::TransferManager;
use tokio::sync::Mutex;

const USER: &str = "alice";
const PASS: &str = "secret";
const KB: u64 = 1024;
const MB: u64 = 1024 * KB;

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
    let root = std::env::temp_dir().join(format!("sshtool-m35-{port}"));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create fixture root");

    let exe = env!("CARGO_BIN_EXE_fixture_sshd");
    let stderr = std::fs::File::create(root.join("fixture.stderr.log")).expect("stderr log");
    let child = Command::new(exe)
        .env("FIXTURE_PORT", port.to_string())
        .env("FIXTURE_USER", USER)
        .env("FIXTURE_PASS", PASS)
        .env("FIXTURE_SFTP_ROOT", root.to_string_lossy().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr))
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
    let path = std::env::temp_dir().join(format!("sshtool-m35-local-{tag}"));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("create local dir");
    path
}

fn write_pattern(path: &Path, size: u64) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
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

fn count_files(dir: &Path) -> usize {
    let mut total = 0usize;
    let Ok(reader) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in reader.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total += count_files(&entry.path());
        } else {
            total += 1;
        }
    }
    total
}

fn options(conflict_policy: &str, create_empty_dirs: bool) -> TreeOptionsDto {
    TreeOptionsDto {
        max_depth: 10,
        max_files: 5000,
        create_empty_dirs,
        conflict_policy: conflict_policy.to_string(),
    }
}

fn tree_request(
    direction: &str,
    source: &Path,
    dest: &str,
    options: TreeOptionsDto,
) -> TreeEnqueueRequest {
    TreeEnqueueRequest {
        direction: direction.to_string(),
        tab_id: "test-tab".to_string(),
        source_path: source.to_string_lossy().to_string(),
        dest_dir: dest.to_string(),
        options,
    }
}

async fn wait_group(
    manager: &Arc<TransferManager>,
    id: &str,
    expected: &[&str],
    timeout: Duration,
) -> TransferGroupDto {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(group) = manager.list_groups().into_iter().find(|g| g.id == id) {
            if expected.contains(&group.state) {
                return group;
            }
        }
        if Instant::now() > deadline {
            panic!(
                "等待组状态 {:?} 超时；当前 {:?}",
                expected,
                manager.list_groups()
            );
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

async fn wait_group_progress(
    manager: &Arc<TransferManager>,
    id: &str,
    min_bytes: u64,
    timeout: Duration,
) -> TransferGroupDto {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(group) = manager.list_groups().into_iter().find(|g| g.id == id) {
            if group.transferred >= min_bytes {
                return group;
            }
        }
        if Instant::now() > deadline {
            panic!("等待组进度 >= {min_bytes} 超时");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        }
}

fn group_tasks(manager: &TransferManager, group_id: &str) -> Vec<TransferTaskDto> {
    manager
        .list()
        .into_iter()
        .filter(|t| t.group_id.as_deref() == Some(group_id))
        .collect()
}

#[tokio::test]
async fn m35_recursive_upload_and_download_keep_hierarchy() {
    let _guard = HEAVY.lock().await;
    let fixture = start_fixture(2331).await;
    let ssh = connect(fixture.port).await;
    let db = Database::open_memory().expect("db");
    let manager = Arc::new(TransferManager::new());
    let local = local_dir(2331);
    let src = local.join("proj");
    write_pattern(&src.join("a.txt"), 4 * KB);
    write_pattern(&src.join("sub/b.bin"), 8 * KB);
    write_pattern(&src.join("sub/deep/c.dat"), 2 * KB);

    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &src, "/", options("overwrite", false)),
            None,
        )
        .await
        .expect("enqueue tree upload");
    assert_eq!(started.files, 3);
    assert!(started.dirs_created >= 2, "至少创建 sub/deep");
    let group = wait_group(&manager, &started.group_id, &["done"], Duration::from_secs(60)).await;
    assert_eq!(group.files_total, 3);
    assert_eq!(group.files_done, 3);

    for (rel, size) in [("a.txt", 4 * KB), ("sub/b.bin", 8 * KB), ("sub/deep/c.dat", 2 * KB)] {
        let remote = fixture.root.join("proj").join(rel);
        assert!(remote.exists(), "远端缺少 {rel}");
        assert_eq!(std::fs::metadata(&remote).unwrap().len(), size);
        assert!(files_equal(&src.join(rel), &remote).unwrap());
    }

    // 再整棵下载回来，验证层级与内容。
    let dest = local_dir(2332);
    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("download", Path::new("/proj"), &dest.to_string_lossy(), options("overwrite", false)),
            None,
        )
        .await
        .expect("enqueue tree download");
    let group = wait_group(&manager, &started.group_id, &["done"], Duration::from_secs(60)).await;
    assert_eq!(group.files_done, 3);
    for (rel, _) in [("a.txt", 4 * KB), ("sub/b.bin", 8 * KB), ("sub/deep/c.dat", 2 * KB)] {
        let back = dest.join("proj").join(rel);
        assert!(back.exists(), "下载后本地缺少 {rel}");
        assert!(files_equal(&src.join(rel), &back).unwrap());
    }
}

#[tokio::test]
async fn m35_deep_tree_five_levels_600_files() {
    let _guard = HEAVY.lock().await;
    let fixture = start_fixture(2333).await;
    let ssh = connect(fixture.port).await;
    let db = Database::open_memory().expect("db");
    let manager = Arc::new(TransferManager::new());
    let local = local_dir(2333);
    let src = local.join("deep");
    let mut levels = vec![src.clone()];
    for i in 1..=5 {
        levels.push(levels.last().unwrap().join(format!("l{i}")));
    }
    for level in &levels {
        for i in 0..100 {
            write_pattern(&level.join(format!("f{i:03}.bin")), 256);
        }
    }
    assert_eq!(count_files(&src), 600);

    let mut opts = options("overwrite", false);
    opts.max_files = 1000;
    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &src, "/", opts),
            None,
        )
        .await
        .expect("enqueue deep tree");
    assert_eq!(started.files, 600);
    let group = wait_group(&manager, &started.group_id, &["done"], Duration::from_secs(240)).await;
    assert_eq!(group.files_total, 600);
    assert_eq!(group.files_done, 600);
    assert_eq!(group.transferred, 600 * 256);

    let remote = fixture.root.join("deep");
    assert_eq!(count_files(&remote), 600, "远端文件数应与源一致");
    let deep = remote.join("l1/l2/l3/l4/l5/f099.bin");
    assert!(deep.exists(), "5 层目录结构不完整");
    assert_eq!(std::fs::metadata(&deep).unwrap().len(), 256);
}

#[tokio::test]
async fn m35_group_pause_and_resume() {
    let _guard = HEAVY.lock().await;
    let fixture = start_fixture(2334).await;
    let ssh = connect(fixture.port).await;
    let db = Database::open_memory().expect("db");
    let manager = Arc::new(TransferManager::new());
    let local = local_dir(2334);
    let src = local.join("batch");
    write_pattern(&src.join("one.bin"), 4 * MB);
    write_pattern(&src.join("two.bin"), 4 * MB);
    write_pattern(&src.join("three.bin"), 4 * MB);

    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &src, "/", options("overwrite", false)),
            None,
        )
        .await
        .expect("enqueue batch");
    assert_eq!(started.files, 3);

    wait_group_progress(&manager, &started.group_id, 2 * MB, Duration::from_secs(60)).await;
    manager.pause_group(&started.group_id).expect("pause group");
    let paused = wait_group(
        &manager,
        &started.group_id,
        &["paused"],
        Duration::from_secs(60),
    )
    .await;
    assert!(paused.transferred < 12 * MB, "暂停时不应已完成");

    manager.resume_group(&started.group_id).expect("resume group");
    let done = wait_group(&manager, &started.group_id, &["done"], Duration::from_secs(120)).await;
    assert_eq!(done.files_done, 3);
    for (name, size) in [("one.bin", 4 * MB), ("two.bin", 4 * MB), ("three.bin", 4 * MB)] {
        let remote = fixture.root.join("batch").join(name);
        assert_eq!(std::fs::metadata(&remote).unwrap().len(), size);
        assert!(files_equal(&src.join(name), &remote).unwrap());
    }
}

#[tokio::test]
async fn m35_group_cancel_keeps_part_and_resumes() {
    let _guard = HEAVY.lock().await;
    let fixture = start_fixture(2335).await;
    let ssh = connect(fixture.port).await;
    let db = Database::open_memory().expect("db");
    let manager = Arc::new(TransferManager::new());
    let local = local_dir(2335);
    let src = local.join("cancel");
    write_pattern(&src.join("big1.bin"), 8 * MB);
    write_pattern(&src.join("big2.bin"), 4 * MB);

    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &src, "/", options("overwrite", false)),
            None,
        )
        .await
        .expect("enqueue cancel group");
    wait_group_progress(&manager, &started.group_id, 4 * MB, Duration::from_secs(60)).await;
    manager.cancel_group(&started.group_id).expect("cancel group");
    wait_group(
        &manager,
        &started.group_id,
        &["cancelled"],
        Duration::from_secs(60),
    )
    .await;

    let part = fixture.root.join("cancel/big1.bin.part");
    assert!(part.exists(), "整组取消后必须保留远端 .part");
    assert!(!fixture.root.join("cancel/big1.bin").exists());

    // 重新整组入队：应复用 .part 偏移续传。
    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &src, "/", options("overwrite", false)),
            None,
        )
        .await
        .expect("re-enqueue cancel group");
    let done = wait_group(&manager, &started.group_id, &["done"], Duration::from_secs(120)).await;
    assert_eq!(done.files_done, 2);
    let tasks = group_tasks(&manager, &started.group_id);
    assert!(
        tasks.iter().any(|t| t.resumed_bytes > 0),
        "重新入队应至少有一个文件复用断点偏移"
    );
    assert!(files_equal(&src.join("big1.bin"), &fixture.root.join("cancel/big1.bin")).unwrap());
    assert!(files_equal(&src.join("big2.bin"), &fixture.root.join("cancel/big2.bin")).unwrap());
}

#[tokio::test]
async fn m35_group_unified_conflict_policies() {
    let _guard = HEAVY.lock().await;
    let fixture = start_fixture(2336).await;
    let ssh = connect(fixture.port).await;
    let db = Database::open_memory().expect("db");
    let manager = Arc::new(TransferManager::new());
    let local = local_dir(2336);

    // 整组覆盖：远端同名文件被新内容替换。
    let overwrite_src = local.join("overwrite");
    write_pattern(&overwrite_src.join("a.txt"), 2 * KB);
    write_pattern(&overwrite_src.join("b.txt"), 3 * KB);
    std::fs::create_dir_all(fixture.root.join("overwrite")).unwrap();
    std::fs::write(fixture.root.join("overwrite/a.txt"), b"old-a").unwrap();
    std::fs::write(fixture.root.join("overwrite/b.txt"), b"old-b").unwrap();
    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &overwrite_src, "/", options("overwrite", false)),
            None,
        )
        .await
        .expect("enqueue overwrite");
    wait_group(&manager, &started.group_id, &["done"], Duration::from_secs(60)).await;
    assert!(files_equal(
        &overwrite_src.join("a.txt"),
        &fixture.root.join("overwrite/a.txt")
    )
    .unwrap());
    assert!(files_equal(
        &overwrite_src.join("b.txt"),
        &fixture.root.join("overwrite/b.txt")
    )
    .unwrap());

    // 整组跳过：远端保持原内容。
    let skip_src = local.join("skip");
    write_pattern(&skip_src.join("a.txt"), 2 * KB);
    std::fs::create_dir_all(fixture.root.join("skip")).unwrap();
    std::fs::write(fixture.root.join("skip/a.txt"), b"keep-me").unwrap();
    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &skip_src, "/", options("skip", false)),
            None,
        )
        .await
        .expect("enqueue skip");
    let group = wait_group(&manager, &started.group_id, &["done"], Duration::from_secs(60)).await;
    assert_eq!(group.files_done, 1, "跳过也计入已处理文件");
    assert_eq!(std::fs::read(fixture.root.join("skip/a.txt")).unwrap(), b"keep-me");

    // 整组重命名：远端保留原文件，新内容写到 `a (1).txt`。
    let rename_src = local.join("rename");
    write_pattern(&rename_src.join("a.txt"), 2 * KB);
    std::fs::create_dir_all(fixture.root.join("rename")).unwrap();
    std::fs::write(fixture.root.join("rename/a.txt"), b"do-not-touch").unwrap();
    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &rename_src, "/", options("rename", false)),
            None,
        )
        .await
        .expect("enqueue rename");
    wait_group(&manager, &started.group_id, &["done"], Duration::from_secs(60)).await;
    assert_eq!(
        std::fs::read(fixture.root.join("rename/a.txt")).unwrap(),
        b"do-not-touch"
    );
    let renamed = fixture.root.join("rename/a (1).txt");
    assert!(renamed.exists(), "重命名策略应生成 a (1).txt");
    assert!(files_equal(&rename_src.join("a.txt"), &renamed).unwrap());
}

#[tokio::test]
async fn m35_empty_dir_switch() {
    let _guard = HEAVY.lock().await;
    let fixture = start_fixture(2337).await;
    let ssh = connect(fixture.port).await;
    let db = Database::open_memory().expect("db");
    let manager = Arc::new(TransferManager::new());
    let local = local_dir(2337);

    // 开关关闭：只传文件，空目录不创建。
    let src = local.join("mixed");
    write_pattern(&src.join("keep.txt"), KB);
    std::fs::create_dir_all(src.join("empty")).unwrap();
    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &src, "/", options("overwrite", false)),
            None,
        )
        .await
        .expect("enqueue mixed");
    assert_eq!(started.files, 1);
    wait_group(&manager, &started.group_id, &["done"], Duration::from_secs(60)).await;
    assert!(fixture.root.join("mixed/keep.txt").exists());
    assert!(
        !fixture.root.join("mixed/empty").exists(),
        "开关关闭时不应创建空目录"
    );

    // 只有空目录且开关关闭：完全不建目录。
    let empty_only = local.join("emptyonly");
    std::fs::create_dir_all(empty_only.join("e1")).unwrap();
    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &empty_only, "/", options("overwrite", true)),
            None,
        )
        .await
        .expect("enqueue empty only");
    assert_eq!(started.files, 0);
    assert!(fixture.root.join("emptyonly/e1").exists(), "开关开启时应创建空目录");

    // 开关关闭时同样输入不应创建任何目录。
    let empty_only2 = local.join("emptyoff");
    std::fs::create_dir_all(empty_only2.join("e1")).unwrap();
    let started = manager
        .enqueue_tree(
            &db,
            ssh.clone(),
            tree_request("upload", &empty_only2, "/", options("overwrite", false)),
            None,
        )
        .await
        .expect("enqueue empty off");
    assert_eq!(started.files, 0);
    assert_eq!(started.dirs_created, 0);
    assert!(!fixture.root.join("emptyoff").exists());
}

#[tokio::test]
async fn m35_depth_and_file_limits_are_reported() {
    let fixture = start_fixture(2338).await;
    let ssh = connect(fixture.port).await;
    let local = local_dir(2338);

    // 本地深目录：6 层；max_depth=2 应报 TRANSFER_LIMIT_EXCEEDED。
    let src = local.join("deep");
    let mut level = src.clone();
    for i in 1..=6 {
        level = level.join(format!("d{i}"));
    }
    std::fs::create_dir_all(&level).unwrap();
    std::fs::write(level.join("leaf.bin"), b"x").unwrap();
    let err = ssh_terminal_lib::local::walk_tree(&src, 2, 5000)
        .await
        .expect_err("深度超限应报错");
    assert_eq!(err.code, "TRANSFER_LIMIT_EXCEEDED");

    // 远端文件数超限。
    std::fs::create_dir_all(fixture.root.join("many")).unwrap();
    for i in 0..20 {
        std::fs::write(fixture.root.join(format!("many/f{i:02}.bin")), b"x").unwrap();
    }
    let err = ssh_terminal_lib::sftp::dir::walk_tree(ssh, "/many".into(), 10, 10)
        .await
        .expect_err("文件数超限应报错");
    assert_eq!(err.code, "TRANSFER_LIMIT_EXCEEDED");
}
