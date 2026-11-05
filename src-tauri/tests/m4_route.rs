//! M4 无头验收：跳板链（ProxyJump）、SOCKS5 / HTTP CONNECT、私钥（OpenSSH/PEM/PPK）
//! 与 ssh-agent 认证。
//!
//! 全部走进程内夹具/最小代理服务，不启动可见窗口。

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use ssh_terminal_lib::ipc::dto::{AgentInput, ConnectionInput, JumpInput, PrivateKeyInput, ProxyInput};
use ssh_terminal_lib::ssh;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

const USER: &str = "alice";
const PASS: &str = "secret";

struct Fixture {
    child: Child,
    port: u16,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
async fn start_fixture(port: u16, forward_log: Option<PathBuf>) -> Fixture {
    let root = std::env::temp_dir().join(format!("sshtool-m4-{port}"));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create fixture root");

    let exe = env!("CARGO_BIN_EXE_fixture_sshd");
    let stderr = std::fs::File::create(root.join("fixture.stderr.log")).expect("stderr log");
    let mut cmd = Command::new(exe);
    cmd.env("FIXTURE_PORT", port.to_string())
        .env("FIXTURE_USER", USER)
        .env("FIXTURE_PASS", PASS)
        .env("FIXTURE_SFTP_ROOT", root.to_string_lossy().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr));
    if let Some(log) = &forward_log {
        let _ = std::fs::remove_file(log);
        cmd.env("FIXTURE_FORWARD_LOG", log.to_string_lossy().to_string());
    }
    let child = cmd.spawn().expect("spawn fixture_sshd");

    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Fixture { child, port };
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("fixture_sshd did not start on port {port}");
}

fn password_input(port: u16) -> ConnectionInput {
    ConnectionInput {
        host: "127.0.0.1".into(),
        port,
        username: USER.into(),
        password: PASS.into(),
        ..ConnectionInput::default()
    }
}

fn jump(port: u16) -> JumpInput {
    JumpInput {
        host: "127.0.0.1".into(),
        port,
        username: USER.into(),
        password: PASS.into(),
        private_key: None,
        agent: None,
    }
}

fn temp_path(tag: &str, name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sshtool-m4-{tag}"));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir.join(name)
}

/// 通过跳板打开 shell 并执行一条命令，确认通道与 PTY 也走完整条链。
/// 夹具 shell 是极简实现：非内置命令统一回应 `ok: <输入>`，据此判断执行成功。
async fn shell_marker(input: &ConnectionInput, marker: &str) {
    let (handle, mut channel) = ssh::open_shell(input, 80, 24, None).await.expect("open shell");
    let cmd = format!("jump-probe {marker}\n");
    channel.data(cmd.as_bytes()).await.expect("send command");
    let needle = format!("ok: jump-probe {marker}");
    let text = read_until(&mut channel, &needle, 5).await;
    assert!(text.contains(&needle), "shell 输出缺少标记: {text}");
    drop(channel);
    drop(handle);
}

async fn read_until(
    channel: &mut russh::Channel<russh::client::Msg>,
    needle: &str,
    secs: u64,
) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    let mut acc = String::new();
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return acc;
        }
        match tokio::time::timeout(left, channel.wait()).await {
            Err(_) | Ok(None) => return acc,
            Ok(Some(msg)) => {
                if let russh::ChannelMsg::Data { data } = msg {
                    acc.push_str(&String::from_utf8_lossy(&data));
                    if acc.contains(needle) {
                        return acc;
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 跳板链
// ---------------------------------------------------------------------------

#[tokio::test]
async fn jump_single_hop_forwards_direct_tcpip() {
    let target = start_fixture(2441, None).await;
    let log = temp_path("jump1", "forward.log");
    let _jump = start_fixture(2442, Some(log.clone())).await;

    let mut input = password_input(target.port);
    input.jumps = vec![jump(2442)];

    ssh::probe(&input, None).await.expect("经由单跳认证");
    shell_marker(&input, "M4_JUMP_OK").await;

    let recorded = std::fs::read_to_string(&log).expect("读跳板转发日志");
    assert!(
        recorded.contains(&format!("127.0.0.1:{}", target.port)),
        "跳板未转发到目标端口: {recorded}"
    );
}

#[tokio::test]
async fn jump_two_hops_chain_in_order() {
    let target = start_fixture(2451, None).await;
    let log1 = temp_path("jump2a", "forward.log");
    let log2 = temp_path("jump2b", "forward.log");
    let _j1 = start_fixture(2452, Some(log1.clone())).await;
    let _j2 = start_fixture(2453, Some(log2.clone())).await;

    let mut input = password_input(target.port);
    input.jumps = vec![jump(2452), jump(2453)];

    ssh::probe(&input, None).await.expect("经由两跳认证");

    let first = std::fs::read_to_string(&log1).expect("第一跳日志");
    let second = std::fs::read_to_string(&log2).expect("第二跳日志");
    assert!(first.contains("127.0.0.1:2453"), "第一跳应指向第二跳: {first}");
    assert!(
        second.contains(&format!("127.0.0.1:{}", target.port)),
        "第二跳应指向目标: {second}"
    );
}

// ---------------------------------------------------------------------------
// SOCKS5 / HTTP CONNECT
// ---------------------------------------------------------------------------

async fn socks5_server(listener: TcpListener, require_auth: bool, records: Arc<Mutex<Vec<String>>>) {
    loop {
        let Ok((mut client, _)) = listener.accept().await else {
            return;
        };
        let records = Arc::clone(&records);
        tokio::spawn(async move {
            let Ok(()) = handshake_socks5(&mut client, require_auth, &records).await else {
                return;
            };
            let mut req = [0u8; 4];
            if client.read_exact(&mut req).await.is_err() {
                return;
            }
            let host = match req[3] {
                0x01 => {
                    let mut addr = [0u8; 4];
                    if client.read_exact(&mut addr).await.is_err() {
                        return;
                    }
                    format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3])
                }
                0x03 => {
                    let mut len = [0u8; 1];
                    if client.read_exact(&mut len).await.is_err() {
                        return;
                    }
                    let mut host = vec![0u8; len[0] as usize];
                    if client.read_exact(&mut host).await.is_err() {
                        return;
                    }
                    String::from_utf8_lossy(&host).to_string()
                }
                _ => return,
            };
            let mut port = [0u8; 2];
            if client.read_exact(&mut port).await.is_err() {
                return;
            }
            let port = u16::from_be_bytes(port);
            records.lock().await.push(format!("{host}:{port}"));

            let Ok(mut upstream) = TcpStream::connect((host.as_str(), port)).await else {
                let _ = client.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                return;
            };
            let _ = client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
        });
    }
}

async fn handshake_socks5(
    client: &mut TcpStream,
    require_auth: bool,
    _records: &Arc<Mutex<Vec<String>>>,
) -> std::io::Result<()> {
    let mut head = [0u8; 2];
    client.read_exact(&mut head).await?;
    let mut methods = vec![0u8; head[1] as usize];
    client.read_exact(&mut methods).await?;
    if !require_auth {
        client.write_all(&[5, 0]).await?;
        return Ok(());
    }
    client.write_all(&[5, 2]).await?;
    let mut ver = [0u8; 2];
    client.read_exact(&mut ver).await?;
    let mut user = vec![0u8; ver[1] as usize];
    client.read_exact(&mut user).await?;
    let mut plen = [0u8; 1];
    client.read_exact(&mut plen).await?;
    let mut pass = vec![0u8; plen[0] as usize];
    client.read_exact(&mut pass).await?;
    let ok = user == b"proxy" && pass == b"secret";
    client.write_all(&[1, if ok { 0 } else { 1 }]).await?;
    if ok {
        Ok(())
    } else {
        Err(std::io::Error::other("bad credentials"))
    }
}

#[tokio::test]
async fn socks5_with_userpass_reaches_target() {
    let target = start_fixture(2461, None).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind socks5");
    let proxy_port = listener.local_addr().expect("addr").port();
    let records = Arc::new(Mutex::new(Vec::new()));
    tokio::spawn(socks5_server(listener, true, records.clone()));

    let mut input = password_input(target.port);
    input.proxy = Some(ProxyInput::Socks5 {
        host: "127.0.0.1".into(),
        port: proxy_port,
        username: Some("proxy".into()),
        password: Some("secret".into()),
    });

    ssh::probe(&input, None).await.expect("SOCKS5 隧道认证");
    let seen = records.lock().await.clone();
    assert_eq!(seen.len(), 1, "应记录一次 CONNECT: {seen:?}");
    assert!(
        seen[0].contains(&format!(":{}", target.port)),
        "SOCKS5 目标端口错误: {:?}",
        seen[0]
    );
}

#[tokio::test]
async fn socks5_auth_failure_is_reported() {
    let target = start_fixture(2462, None).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind socks5");
    let proxy_port = listener.local_addr().expect("addr").port();
    let records = Arc::new(Mutex::new(Vec::new()));
    tokio::spawn(socks5_server(listener, true, records));

    let mut input = password_input(target.port);
    input.proxy = Some(ProxyInput::Socks5 {
        host: "127.0.0.1".into(),
        port: proxy_port,
        username: Some("proxy".into()),
        password: Some("wrong".into()),
    });

    let err = ssh::probe(&input, None).await.expect_err("错误的 SOCKS5 口令应失败");
    assert_eq!(err.code, "AUTH_FAILED", "{err:?}");
}

async fn http_proxy_server(listener: TcpListener, records: Arc<Mutex<Vec<String>>>) {
    loop {
        let Ok((mut client, _)) = listener.accept().await else {
            return;
        };
        let records = records.clone();
        tokio::spawn(async move {
            let mut buf = Vec::new();
            loop {
                let mut chunk = [0u8; 512];
                let Ok(n) = client.read(&mut chunk).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 16 * 1024 {
                    return;
                }
            }
            let head = String::from_utf8_lossy(&buf).to_string();
            records.lock().await.push(head.clone());

            let target = head
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or_default()
                .to_string();
            let authorized = head
                .to_ascii_lowercase()
                .contains("proxy-authorization: basic ");
            if !authorized {
                let _ = client
                    .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                    .await;
                return;
            }
            let Ok(mut upstream) = TcpStream::connect(target.as_str()).await else {
                let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
                return;
            };
            let _ = client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await;
            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
        });
    }
}

#[tokio::test]
async fn http_connect_proxy_tunnels_ssh() {
    let target = start_fixture(2471, None).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind http proxy");
    let proxy_port = listener.local_addr().expect("addr").port();
    let records = Arc::new(Mutex::new(Vec::new()));
    tokio::spawn(http_proxy_server(listener, records.clone()));

    let mut input = password_input(target.port);
    input.proxy = Some(ProxyInput::HttpConnect {
        host: "127.0.0.1".into(),
        port: proxy_port,
        username: Some("proxy".into()),
        password: Some("secret".into()),
    });

    ssh::probe(&input, None).await.expect("HTTP CONNECT 隧道认证");
    let seen = records.lock().await.clone();
    assert_eq!(seen.len(), 1, "应记录一次 CONNECT 请求");
    assert!(
        seen[0].starts_with(&format!("CONNECT 127.0.0.1:{}", target.port)),
        "CONNECT 目标错误: {}",
        seen[0]
    );
    assert!(
        seen[0].to_ascii_lowercase().contains("proxy-authorization: basic "),
        "缺少代理认证头: {}",
        seen[0]
    );
}

// ---------------------------------------------------------------------------
// 私钥：OpenSSH / PPK
// ---------------------------------------------------------------------------

fn ed25519_key() -> ssh_key::PrivateKey {
    ssh_key::PrivateKey::random(&mut rand_core::OsRng, ssh_key::Algorithm::Ed25519)
        .expect("生成 Ed25519 私钥")
}

fn write_key(tag: &str, text: &str) -> PathBuf {
    let path = temp_path(tag, "id_key");
    std::fs::write(&path, text).expect("写入私钥");
    path
}

#[tokio::test]
async fn private_key_openssh_format() {
    let target = start_fixture(2481, None).await;
    let key = ed25519_key();
    let path = write_key(
        "key-openssh",
        &key.to_openssh(ssh_key::LineEnding::LF).expect("转 OpenSSH"),
    );

    let mut input = password_input(target.port);
    input.password.clear();
    input.private_key = Some(PrivateKeyInput { path: path.to_string_lossy().to_string(), passphrase: None });

    ssh::probe(&input, None).await.expect("OpenSSH 私钥认证");
}

fn mpint(value: &[u8]) -> Vec<u8> {
    let start = value.iter().position(|b| *b != 0).unwrap_or(value.len());
    let value = &value[start..];
    let mut body = Vec::new();
    if value.first().is_some_and(|b| b & 0x80 != 0) {
        body.push(0);
    }
    body.extend_from_slice(value);
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

fn ppk_ed25519(key: &ssh_key::PrivateKey) -> String {
    use ssh_key::private::KeypairData;
    let public = key.public_key().to_bytes().expect("公钥 blob");
    let private = match key.key_data() {
        KeypairData::Ed25519(kp) => kp.to_bytes().to_vec(),
        _ => panic!("测试只用 Ed25519"),
    };
    let private_blob = mpint(&private);
    let wrap = |bytes: &[u8]| -> (usize, String) {
        let text = data_encoding::BASE64.encode(bytes);
        let lines: Vec<String> = text
            .as_bytes()
            .chunks(64)
            .map(|chunk| String::from_utf8_lossy(chunk).to_string())
            .collect();
        (lines.len(), lines.join("\n"))
    };
    let (pub_lines, pub_b64) = wrap(&public);
    let (priv_lines, priv_b64) = wrap(&private_blob);
    format!(
        "PuTTY-User-Key-File-2: ssh-ed25519\nEncryption: none\nComment: m4-test\nPublic-Lines: {pub_lines}\n{pub_b64}\nPrivate-Lines: {priv_lines}\n{priv_b64}\nPrivate-MAC: 0000000000000000000000000000000000000000\n"
    )
}

#[tokio::test]
async fn private_key_ppk_format() {
    let target = start_fixture(2482, None).await;
    let key = ed25519_key();
    let path = write_key("key-ppk", &ppk_ed25519(&key));

    let mut input = password_input(target.port);
    input.password.clear();
    input.private_key = Some(PrivateKeyInput { path: path.to_string_lossy().to_string(), passphrase: None });

    ssh::probe(&input, None).await.expect("PPK 私钥认证");
}

// ---------------------------------------------------------------------------
// ssh-agent
// ---------------------------------------------------------------------------

async fn start_agent(key: &ssh_key::PrivateKey) -> (String, tokio::task::JoinHandle<()>) {
    use russh::keys::agent::client::AgentClient;
    use tokio_stream::wrappers::TcpListenerStream;

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind agent");
    let addr = listener.local_addr().expect("agent addr");
    let handle = tokio::spawn(async move {
        let _ = russh::keys::agent::server::serve(TcpListenerStream::new(listener), ()).await;
    });

    // 与 `ssh-add` 等价：先通过协议把 identity 装进 agent。
    let stream = TcpStream::connect(addr).await.expect("connect agent");
    let mut admin = AgentClient::connect(stream).dynamic();
    admin.add_identity(key, &[]).await.expect("add identity");
    (format!("tcp://{addr}"), handle)
}

#[tokio::test]
async fn agent_auth_uses_loaded_identity() {
    let target = start_fixture(2491, None).await;
    let key = ed25519_key();
    let (socket, _server) = start_agent(&key).await;

    let mut input = password_input(target.port);
    input.password.clear();
    input.agent = Some(AgentInput { socket: Some(socket), key: None });

    ssh::probe(&input, None).await.expect("ssh-agent 认证");
}

#[tokio::test]
async fn agent_missing_identity_is_auth_failed() {
    let target = start_fixture(2492, None).await;
    let key = ed25519_key();
    let (socket, _server) = start_agent(&key).await;

    let mut input = password_input(target.port);
    input.password.clear();
    input.agent = Some(AgentInput {
        socket: Some(socket),
        key: Some("SHA256:not-the-key".into()),
    });

    let err = ssh::probe(&input, None).await.expect_err("identity 不匹配应失败");
    assert_eq!(err.code, "AUTH_FAILED", "{err:?}");
}
