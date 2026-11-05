//! M0 端到端：连接夹具 SSH → 回显 → resize 生效 → 断线有明确结果。
//!
//! 夹具是本仓库的 `fixture_sshd` 二进制（进程内 SSH 服务，非 Docker/WSL），
//! 行为确定，因此这些断言在 CI 上可稳定执行。

use std::io::Write as _;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use russh::client::Msg;
use russh::ChannelMsg;
use ssh_terminal_lib::ipc::dto::ConnectionInput;

const PORT: u16 = 2301;
const USER: &str = "alice";
const PASS: &str = "secret";

struct Fixture {
    child: Child,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// 子进程由 Fixture::drop 中的 kill + wait 回收，clippy 看不到该路径。
#[allow(clippy::zombie_processes)]
async fn start_fixture(port: u16) -> Fixture {
    let exe = env!("CARGO_BIN_EXE_fixture_sshd");
    let child = Command::new(exe)
        .env("FIXTURE_PORT", port.to_string())
        .env("FIXTURE_USER", USER)
        .env("FIXTURE_PASS", PASS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn fixture_sshd");

    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Fixture { child };
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("fixture_sshd did not start on port {port}");
}

fn input(port: u16, cols: u16, rows: u16) -> ConnectionInput {
    ConnectionInput {
        host: "127.0.0.1".into(),
        port,
        username: USER.into(),
        password: PASS.into(),
        cols,
        rows,
        ..ConnectionInput::default()
    }
}

async fn read_until(channel: &mut russh::Channel<Msg>, needle: &str, secs: u64) -> String {
    let mut acc = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    while !acc.contains(needle) {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(left, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => {
                acc.push_str(&String::from_utf8_lossy(data.as_ref()));
            }
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                acc.push_str(&String::from_utf8_lossy(data.as_ref()));
            }
            Ok(Some(_)) => {}
            Ok(None) => panic!("channel closed while waiting for {needle:?}; got {acc:?}"),
            Err(_) => panic!("timeout waiting for {needle:?}; got {acc:?}"),
        }
    }
    acc
}

async fn send(channel: &mut russh::Channel<Msg>, bytes: &[u8]) {
    let mut data = bytes.to_vec();
    data.write_all(&[]).ok();
    channel.data(&data[..]).await.expect("send data");
}

#[tokio::test]
async fn m0_connect_echo_resize_disconnect() {
    let _fixture = start_fixture(PORT).await;

    let (_handle, mut channel) = ssh_terminal_lib::ssh::open_shell(&input(PORT, 80, 24), 80, 24, None)
        .await
        .expect("connect + shell");

    // 1) 初始提示符
    read_until(&mut channel, "$ ", 5).await;

    // 2) echo 回显 + TERM
    send(&mut channel, b"echo $TERM\r").await;
    let out = read_until(&mut channel, "$ ", 5).await;
    assert!(out.contains("xterm-256color"), "TERM 未正确传递: {out:?}");

    // 3) 初次 PTY 尺寸
    send(&mut channel, b"stty size\r").await;
    let out = read_until(&mut channel, "$ ", 5).await;
    assert!(out.contains("24 80"), "初始尺寸错误: {out:?}");

    // 4) resize 生效（对应里程碑验收 T03 的服务端部分）
    channel.window_change(100, 30, 0, 0).await.expect("window_change");
    send(&mut channel, b"stty size\r").await;
    let out = read_until(&mut channel, "$ ", 5).await;
    assert!(out.contains("30 100"), "resize 未生效: {out:?}");

    // 5) 断线：杀掉夹具后通道必须以明确状态结束，而不是挂死
    drop(_fixture);
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { .. }) => continue,
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => return "closed",
                Some(_) => continue,
                None => return "ended",
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "断线后 5s 内未收到明确的结束状态");
}

#[tokio::test]
async fn m0_auth_failure_is_explicit() {
    let _fixture = start_fixture(2302).await;

    let mut bad = input(2302, 80, 24);
    bad.password = "wrong".into();
    let err = ssh_terminal_lib::ssh::open_shell(&bad, 80, 24, None)
        .await
        .err()
        .expect("错误密码必须返回错误");
    assert_eq!(err.code, "AUTH_FAILED", "错误码应为 AUTH_FAILED: {err:?}");
}

/// 同一会话连续两次 bench：验证夹具在 top 结束后仍能再跑 burst。
#[tokio::test]
async fn m0_fixture_bench_top_then_burst() {
    let _fixture = start_fixture(2304).await;
    let (_handle, mut channel) =
        ssh_terminal_lib::ssh::open_shell(&input(2304, 80, 24), 80, 24, None)
            .await
            .expect("connect + shell");
    read_until(&mut channel, "$ ", 5).await;

    send(&mut channel, b"bench top 1\r").await;
    let out = read_until(&mut channel, "@@BENCH_TOP_END@@", 8).await;
    assert!(out.contains("@@BENCH_TOP_START@@"), "缺少 top 起始标记: {out:?}");

    send(&mut channel, b"bench burst 2\r").await;
    let mut reader = channel.make_reader();
    let mut buf = vec![0u8; 512 * 1024];
    let mut total = 0usize;
    let mut tail = String::new();
    use tokio::io::AsyncReadExt as _;
    let started = std::time::Instant::now();
    loop {
        let n = reader.read(&mut buf).await.expect("read burst");
        total += n;
        tail.push_str(&String::from_utf8_lossy(&buf[..n]));
        if tail.len() > 8192 {
            tail = tail[tail.len() - 8192..].to_string();
        }
        if tail.contains("@@BENCH_BURST_END@@") || started.elapsed().as_secs() > 10 {
            break;
        }
    }
    assert!(
        tail.contains("@@BENCH_BURST_END@@"),
        "连续 bench 后 burst 未启动，已收 {total} 字节"
    );
}


#[tokio::test]
async fn m0_fixture_bench_burst_streams() {
    let _fixture = start_fixture(2303).await;
    let (_handle, mut channel) =
        ssh_terminal_lib::ssh::open_shell(&input(2303, 80, 24), 80, 24, None)
            .await
            .expect("connect + shell");
    read_until(&mut channel, "$ ", 5).await;

    let started = std::time::Instant::now();
    send(&mut channel, b"bench burst 8\r").await;

    // 用 make_reader 直接读，排除逐 ChannelMsg + timeout 的循环开销。
    let mut reader = channel.make_reader();
    let mut buf = vec![0u8; 2 * 1024 * 1024];
    let mut total = 0usize;
    let mut tail = String::new();
    use tokio::io::AsyncReadExt as _;
    loop {
        let n = reader.read(&mut buf).await.expect("read burst");
        total += n;
        let seg = String::from_utf8_lossy(&buf[..n.min(buf.len())]).to_string();
        tail.push_str(&seg);
        if tail.len() > 8192 {
            tail = tail[tail.len() - 8192..].to_string();
        }
        if tail.contains("@@BENCH_BURST_END@@") || total > 9 * 1024 * 1024 {
            break;
        }
        assert!(started.elapsed().as_secs() < 20, "burst 超时，已收 {total} 字节");
    }
    let secs = started.elapsed().as_secs_f64();
    let mb = total as f64 / 1024.0 / 1024.0;
    assert!(mb >= 7.5, "burst 至少应收到 7.5MiB，实际 {mb:.1}MiB");
    assert!(secs < 20.0, "burst 耗时过长: {secs:.1}s");
    println!("fixture burst: {mb:.1}MiB in {secs:.2}s = {:.1}MB/s", mb / secs);
}


