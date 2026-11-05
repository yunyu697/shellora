//! 连接编排：代理 → 跳板链（direct-tcpip）→ 目标 → 认证 → 通道 → PTY → shell。

use std::ops::{Deref, DerefMut};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use russh::client::{self, Msg};
use russh::Channel;

use crate::config::CONNECT_TIMEOUT_MS;
use crate::db::Database;
use crate::error::{ErrorCode, ErrorDto};
use crate::ipc::dto::{AgentInput, ConnectionInput, JumpInput, PrivateKeyInput};
use crate::knownhost;
use crate::knownhost::KnownHostPolicy;
use crate::ssh::agent;
use crate::ssh::handler::ClientHandler;
use crate::ssh::keys;
use crate::ssh::proxy::{self, BoxStream};

/// 目标会话句柄。`Deref` 到 russh `Handle`，调用方（终端 / SFTP / conn_test）
/// 无需感知跳板链的存在。
pub struct SshSession {
    handle: client::Handle<ClientHandler>,
    /// 跳板连接必须活到目标会话结束：句柄一旦丢弃，direct-tcpip 通道随之关闭。
    /// 只在 `Drop` 时使用，故以下划线命名。
    _parents: Vec<client::Handle<ClientHandler>>,
}

impl Deref for SshSession {
    type Target = client::Handle<ClientHandler>;
    fn deref(&self) -> &Self::Target {
        &self.handle
    }
}

impl DerefMut for SshSession {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.handle
    }
}

pub type SshHandle = SshSession;

enum AuthSpec {
    Password(String),
    Key(PrivateKeyInput),
    Agent(AgentInput),
}

fn resolve_auth(
    password: &str,
    key: Option<&PrivateKeyInput>,
    agent: Option<&AgentInput>,
) -> Result<AuthSpec, ErrorDto> {
    if let Some(key) = key {
        return Ok(AuthSpec::Key(key.clone()));
    }
    if let Some(agent) = agent {
        return Ok(AuthSpec::Agent(agent.clone()));
    }
    if !password.is_empty() {
        return Ok(AuthSpec::Password(password.to_string()));
    }
    Err(ErrorDto::new(
        ErrorCode::AuthFailed,
        "未提供认证方式：请填写密码、私钥或启用 ssh-agent",
    ))
}

fn resolve_jump_auth(jump: &JumpInput) -> Result<AuthSpec, ErrorDto> {
    resolve_auth(&jump.password, jump.private_key.as_ref(), jump.agent.as_ref())
}

pub fn connect_and_shell<'a>(
    input: &'a ConnectionInput,
    cols: u16,
    rows: u16,
    store: Option<&'a Database>,
) -> BoxFuture<'a, Result<(SshHandle, Channel<Msg>), ErrorDto>> {
    let input = input.clone();
    let store = store.cloned();
    Box::pin(async move {
        let handle = connect_route(input.clone(), store).await?;

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| map_russh_error(e, &input.host))?;

        channel
            .request_pty(
                true,
                "xterm-256color",
                cols as u32,
                rows as u32,
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| map_russh_error(e, &input.host))?;

        channel
            .request_shell(true)
            .await
            .map_err(|e| map_russh_error(e, &input.host))?;

        Ok((handle, channel))
    })
}

/// 仅连接 + 认证（`conn_test` 复用，不申请通道）。
pub fn connect_authenticated<'a>(
    input: &'a ConnectionInput,
    store: Option<&'a Database>,
) -> BoxFuture<'a, Result<SshHandle, ErrorDto>> {
    let input = input.clone();
    let store = store.cloned();
    Box::pin(connect_route(input, store))
}

async fn connect_route(
    input: ConnectionInput,
    store: Option<Database>,
) -> Result<SshHandle, ErrorDto> {
    let config = Arc::new(client_config());
    let policy = KnownHostPolicy::from_input(&input);
    let target_auth = resolve_auth(&input.password, input.private_key.as_ref(), input.agent.as_ref())?;

    // 第一个跳板（或目标）由本机直连，必要时经代理。
    let (first_host, first_port) = match input.jumps.first() {
        Some(jump) => (jump.host.clone(), jump.port),
        None => (input.host.clone(), input.port),
    };
    let mut stream: BoxStream = match &input.proxy {
        Some(proxy) => proxy::open(proxy.clone(), first_host.clone(), first_port).await?,
        None => Box::new(tcp(&first_host, first_port).await?),
    };

    let mut parents = Vec::with_capacity(input.jumps.len());
    for (idx, jump) in input.jumps.iter().enumerate() {
        let spec = resolve_jump_auth(jump)?;
        let mut handle = open_over(
            config.clone(),
            stream,
            jump.host.clone(),
            jump.port,
            store.as_ref(),
            &policy,
        )
        .await?;
        authenticate(&mut handle, jump.username.clone(), spec, jump.host.clone()).await?;

        let (next_host, next_port) = input
            .jumps
            .get(idx + 1)
            .map(|next| (next.host.clone(), next.port))
            .unwrap_or((input.host.clone(), input.port));
        let channel = handle
            .channel_open_direct_tcpip(&next_host, next_port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| map_russh_error(e, &jump.host))?;

        stream = Box::new(channel.into_stream());
        parents.push(handle);
    }

    let mut handle = open_over(
        config,
        stream,
        input.host.clone(),
        input.port,
        store.as_ref(),
        &policy,
    )
    .await?;
    authenticate(&mut handle, input.username.clone(), target_auth, input.host.clone()).await?;
    Ok(SshSession { handle, _parents: parents })
}

fn client_config() -> client::Config {
    client::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        // 大窗口 + 大包：终端吞吐实测依赖它，避免 32KB 级别的窗口往返成为瓶颈。
        window_size: 8 * 1024 * 1024,
        maximum_packet_size: 65536,
        ..Default::default()
    }
}

async fn open_over(
    config: Arc<client::Config>,
    stream: BoxStream,
    host: String,
    port: u16,
    store: Option<&Database>,
    policy: &KnownHostPolicy,
) -> Result<client::Handle<ClientHandler>, ErrorDto> {
    let observed = Arc::new(std::sync::Mutex::new(None));
    let handler = ClientHandler {
        observed: observed.clone(),
    };
    let fut = client::connect_stream(config, stream, handler);
    let handle = match tokio::time::timeout(Duration::from_millis(CONNECT_TIMEOUT_MS), fut).await {
        Err(_) => {
            return Err(ErrorDto::new(
                ErrorCode::NetTimeout,
                format!("与 {host} 的 SSH 握手超时"),
            ))
        }
        Ok(Err(e)) => return Err(map_russh_error(e, &host)),
        Ok(Ok(handle)) => handle,
    };

    // 认证前完成 host key 校验：未知主机需用户确认，指纹变更一律阻断。
    if let Some(store) = store {
        let key = observed.lock().ok().and_then(|slot| slot.clone());
        let Some(key) = key else {
            return Err(ErrorDto::internal(format!(
                "与 {host} 握手结束但未获得服务端主机密钥"
            )));
        };
        knownhost::verify(store, policy, &host, port, &key)?;
    }
    Ok(handle)
}

fn authenticate<'a>(
    handle: &'a mut client::Handle<ClientHandler>,
    username: String,
    spec: AuthSpec,
    host: String,
) -> BoxFuture<'a, Result<(), ErrorDto>> {
    Box::pin(async move {
    match spec {
        AuthSpec::Password(password) => {
            let ok = handle
                .authenticate_password(username.clone(), password)
                .await
                .map_err(|e| map_russh_error(e, &host))?;
            if !ok {
                return Err(ErrorDto::new(
                    ErrorCode::AuthFailed,
                    format!("认证失败：{username}@{host} 密码不正确"),
                ));
            }
        }
        AuthSpec::Key(input) => {
            let key = keys::load(&input.path, input.passphrase.as_deref())?;
            let key = russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key), None)
                .map_err(|e| ErrorDto::new(ErrorCode::AuthFailed, format!("私钥不可用于认证：{e}")))?;
            let ok = handle
                .authenticate_publickey(username.clone(), key)
                .await
                .map_err(|e| map_russh_error(e, &host))?;
            if !ok {
                return Err(ErrorDto::new(
                    ErrorCode::AuthFailed,
                    format!("认证失败：{username}@{host} 未接受该私钥"),
                ));
            }
        }
        AuthSpec::Agent(input) => {
            agent::authenticate(handle, username, input).await?;
        }
    }
    Ok(())
    })
}

async fn tcp(host: &str, port: u16) -> Result<tokio::net::TcpStream, ErrorDto> {
    let stream = tokio::net::TcpStream::connect((host, port))
        .await
        .map_err(|e| map_io_error(e, host))?;
    stream.set_nodelay(true).ok();
    Ok(stream)
}

fn map_io_error(err: std::io::Error, host: &str) -> ErrorDto {
    match err.kind() {
        std::io::ErrorKind::ConnectionRefused => {
            return ErrorDto::new(
                ErrorCode::NetRefused,
                format!("{host} 拒绝连接（端口未开放或被防火墙拦截）"),
            )
        }
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
            return ErrorDto::new(ErrorCode::NetTimeout, format!("连接 {host} 超时"))
        }
        _ => {}
    }
    // DNS 解析失败在不同平台表现为 NotFound / Uncategorized，统一按主机不可达处理。
    if err.kind() == std::io::ErrorKind::NotFound
        || err.raw_os_error().is_some_and(|code| code == 11001)
        || err.to_string().contains("dns error")
    {
        return ErrorDto::new(ErrorCode::NetDns, format!("无法解析主机 {host}"));
    }
    ErrorDto::internal(format!("SSH 连接失败：{err}"))
}

fn map_russh_error(err: russh::Error, host: &str) -> ErrorDto {
    if let russh::Error::IO(io) = &err {
        return map_io_error(std::io::Error::new(io.kind(), io.to_string()), host);
    }
    ErrorDto::internal(format!("SSH 连接失败：{err}"))
}
