//! M5 验收 7：10MB 洪峰逐字节不丢。
//! 夹具 `bench burst 10` 会精确输出 10MiB；这里统计 START/END 标记之间的载荷字节数，
//! 与远端发送量（wc -c 等价）完全一致。前端 xterm 的 `term.write` 按序消费同一字节流。

use std::process::{Child, Command, Stdio};
use std::time::Duration;

use russh::ChannelMsg;
use ssh_terminal_lib::ipc::dto::ConnectionInput;

const PORT: u16 = 2306;
const USER: &str = "alice";
const PASS: &str = "secret";
const START: &[u8] = b"@@BENCH_BURST_START@@\r\n";
const END: &[u8] = b"@@BENCH_BURST_END@@";
const PAYLOAD: usize = 10 * 1024 * 1024;

struct Fixture {
    child: Child,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

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

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// 读到 `$ ` 提示符；返回是否在限时内到达。
async fn await_prompt(channel: &mut russh::Channel<russh::client::Msg>, secs: u64) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    let mut acc: Vec<u8> = Vec::new();
    while !acc.ends_with(b"$ ") {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(left, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => acc.extend_from_slice(data.as_ref()),
            Ok(Some(_)) => continue,
            _ => return false,
        }
    }
    true
}

#[tokio::test]
async fn m5_10mb_flood_has_zero_byte_loss() {
    let _fixture = start_fixture(PORT).await;
    let (_handle, mut channel) =
        ssh_terminal_lib::ssh::open_shell(&input(PORT), 80, 24, None)
            .await
            .expect("connect + shell");
    assert!(await_prompt(&mut channel, 5).await, "shell 未就绪");

    channel
        .data(&b"bench burst 10\r"[..])
        .await
        .expect("send burst command");

    let mut reader = channel.make_reader();
    use tokio::io::AsyncReadExt as _;

    let mut acc: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 256 * 1024];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    // 只扫描新增窗口，避免每轮全量查找造成 O(n²)。
    let mut searched = 0usize;
    while find(&acc, END, searched).is_none() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "10MB 洪峰超时，已收 {} 字节",
            acc.len()
        );
        searched = acc.len().saturating_sub(END.len() - 1);
        let n = reader.read(&mut buf).await.expect("read flood");
        assert!(n > 0, "通道提前 EOF，已收 {} 字节", acc.len());
        acc.extend_from_slice(&buf[..n]);
    }

    let start = find(&acc, START, 0).expect("缺少 START 标记");
    let end = find(&acc, END, start + START.len()).expect("缺少 END 标记");
    let payload = end - (start + START.len());
    assert_eq!(
        payload, PAYLOAD,
        "洪峰载荷应为 10MiB，实际 {payload} 字节（差额 {}）",
        PAYLOAD as i64 - payload as i64
    );
}
