//! SOCKS5 / HTTP CONNECT 代理：建立到目标（或第一跳）的 TCP 隧道。
//!
//! 返回的流已经完成代理握手，可直接交给 `russh::client::connect_stream`。

use std::io;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;

use crate::config::CONNECT_TIMEOUT_MS;
use crate::error::{ErrorCode, ErrorDto};
use crate::ipc::dto::ProxyInput;

/// 可被 russh 消费的字节流（TCP / 代理隧道 / 跳板通道流）。
pub trait TunnelStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> TunnelStream for T {}
pub type BoxStream = Box<dyn TunnelStream>;

/// 经代理连接 `dest_host:dest_port`。
pub async fn open(
    proxy: ProxyInput,
    dest_host: String,
    dest_port: u16,
) -> Result<BoxStream, ErrorDto> {
    // 全部用 owned 参数：跨 await 的借用会让 rustc 的 Send 证明失败
    //（“Send is not general enough”）。
    let timeout = Duration::from_millis(CONNECT_TIMEOUT_MS);
    match proxy {
        ProxyInput::Socks5 { host, port, username, password } => {
            let fut = socks5(host, port, dest_host, dest_port, username, password);
            match tokio::time::timeout(timeout, fut).await {
                Err(_) => Err(ErrorDto::new(
                    ErrorCode::NetTimeout,
                    crate::i18n::t("SOCKS5 握手超时"),
                )),
                Ok(r) => r.map(|s| Box::new(s) as BoxStream),
            }
        }
        ProxyInput::HttpConnect { host, port, username, password } => {
            let fut = http_connect(host, port, dest_host, dest_port, username, password);
            match tokio::time::timeout(timeout, fut).await {
                Err(_) => Err(ErrorDto::new(
                    ErrorCode::NetTimeout,
                    crate::i18n::t("HTTP CONNECT 握手超时"),
                )),
                Ok(r) => r.map(|s| Box::new(s) as BoxStream),
            }
        }
    }
}

async fn tcp(host: &str, port: u16) -> Result<TcpStream, ErrorDto> {
    let stream = TcpStream::connect((host, port)).await.map_err(|e| {
        let code = match e.kind() {
            io::ErrorKind::ConnectionRefused => ErrorCode::NetRefused,
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => ErrorCode::NetTimeout,
            _ if is_dns_error(&e) => ErrorCode::NetDns,
            _ => ErrorCode::Internal,
        };
        let message = crate::i18n::t_args(
            "无法连接代理 {host}:{port}：{error}",
            &[
                ("host", host),
                ("port", &port.to_string()),
                ("error", &e.to_string()),
            ],
        );
        ErrorDto::new(code, message)
    })?;
    stream.set_nodelay(true).ok();
    Ok(stream)
}

fn is_dns_error(err: &io::Error) -> bool {
    // 不同平台的 DNS 失败类别不一致（NotFound / Other），按错误链上的 message 兜底。
    err.kind() == io::ErrorKind::NotFound
        || err.raw_os_error().is_some_and(|c| c == 11001)
        || err.to_string().contains("dns error")
}

fn io_fail(what: &str, err: io::Error) -> ErrorDto {
    let err = err.to_string();
    ErrorDto::new(
        ErrorCode::Internal,
        crate::i18n::t_args("{what}：{error}", &[("what", what), ("error", &err)]),
    )
}

fn unexpected(detail: &str) -> ErrorDto {
    ErrorDto::new(
        ErrorCode::Internal,
        crate::i18n::t_args("代理响应异常：{detail}", &[("detail", detail)]),
    )
}

// ---------------------------------------------------------------------------
// SOCKS5（RFC 1928 / RFC 1929）
// ---------------------------------------------------------------------------

async fn socks5(
    proxy_host: String,
    proxy_port: u16,
    dest_host: String,
    dest_port: u16,
    username: Option<String>,
    password: Option<String>,
) -> Result<TcpStream, ErrorDto> {
    let mut stream = tcp(&proxy_host, proxy_port).await?;

    // 认证方式协商
    let want_userpass = username.is_some() || password.is_some();
    let methods: &[u8] = if want_userpass { &[0x00, 0x02] } else { &[0x00] };
    let mut greeting = Vec::with_capacity(2 + methods.len());
    greeting.push(5);
    greeting.push(methods.len() as u8);
    greeting.extend_from_slice(methods);
    stream
        .write_all(&greeting)
        .await
        .map_err(|e| io_fail(&crate::i18n::t("SOCKS5 协商写入失败"), e))?;

    let mut chosen = [0u8; 2];
    stream
        .read_exact(&mut chosen)
        .await
        .map_err(|e| io_fail(&crate::i18n::t("SOCKS5 协商读取失败"), e))?;
    if chosen[0] != 5 {
        return Err(unexpected(&crate::i18n::t("SOCKS5 版本号不是 5")));
    }
    match chosen[1] {
        0x00 => {}
        0x02 => {
            let (Some(user), Some(pass)) = (username, password) else {
                return Err(ErrorDto::new(
                    ErrorCode::AuthFailed,
                    crate::i18n::t("SOCKS5 代理要求用户名/密码，但未提供"),
                ));
            };
            if user.len() > 255 || pass.len() > 255 {
                return Err(ErrorDto::new(
                    ErrorCode::AuthFailed,
                    crate::i18n::t("SOCKS5 用户名/密码过长"),
                ));
            }
            let mut auth = vec![1, user.len() as u8];
            auth.extend_from_slice(user.as_bytes());
            auth.push(pass.len() as u8);
            auth.extend_from_slice(pass.as_bytes());
            stream
                .write_all(&auth)
                .await
                .map_err(|e| io_fail(&crate::i18n::t("SOCKS5 认证写入失败"), e))?;
            let mut reply = [0u8; 2];
            stream
                .read_exact(&mut reply)
                .await
                .map_err(|e| io_fail(&crate::i18n::t("SOCKS5 认证读取失败"), e))?;
            if reply[1] != 0 {
                return Err(ErrorDto::new(
                    ErrorCode::AuthFailed,
                    crate::i18n::t("SOCKS5 认证失败"),
                ));
            }
        }
        0xFF => {
            return Err(ErrorDto::new(
                ErrorCode::AuthFailed,
                crate::i18n::t("SOCKS5 代理拒绝所有认证方式"),
            ))
        }
        other => {
            return Err(unexpected(&crate::i18n::t_args(
                "SOCKS5 选择了不支持的认证方式 0x{code}",
                &[("code", &format!("{other:02x}"))],
            )))
        }
    }

    // CONNECT 请求：域名交给代理解析，避免本地 DNS 泄漏。
    let mut request = vec![5u8, 0x01, 0x00];
    match dest_host.parse::<std::net::Ipv4Addr>() {
        Ok(ip) => {
            request.push(0x01);
            request.extend_from_slice(&ip.octets());
        }
        Err(_) => match dest_host.parse::<std::net::Ipv6Addr>() {
            Ok(ip) => {
                request.push(0x04);
                request.extend_from_slice(&ip.octets());
            }
            Err(_) => {
                if dest_host.len() > 255 {
                    return Err(unexpected(&crate::i18n::t("目标主机名超过 255 字节")));
                }
                request.push(0x03);
                request.push(dest_host.len() as u8);
                request.extend_from_slice(dest_host.as_bytes());
            }
        },
    }
    request.extend_from_slice(&dest_port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|e| io_fail(&crate::i18n::t("SOCKS5 请求写入失败"), e))?;

    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .await
        .map_err(|e| io_fail(&crate::i18n::t("SOCKS5 应答读取失败"), e))?;
    if head[0] != 5 {
        return Err(unexpected(&crate::i18n::t("SOCKS5 应答版本号不是 5")));
    }
    match head[1] {
        0x00 => {}
        0x05 => {
            return Err(ErrorDto::new(
                ErrorCode::NetRefused,
                crate::i18n::t_args(
                    "代理拒绝连接 {host}:{port}",
                    &[("host", &dest_host), ("port", &dest_port.to_string())],
                ),
            ))
        }
        0x03 | 0x04 => {
            return Err(ErrorDto::new(
                ErrorCode::NetDns,
                crate::i18n::t_args(
                    "代理报告目标不可达：{host}:{port}",
                    &[("host", &dest_host), ("port", &dest_port.to_string())],
                ),
            ))
        }
        other => {
            return Err(unexpected(&crate::i18n::t_args(
                "SOCKS5 应答失败码 0x{code}",
                &[("code", &format!("{other:02x}"))],
            )));
        }
    }
    // 消费 BND.ADDR + BND.PORT
    match head[3] {
        0x01 => {
            let mut skip = [0u8; 4 + 2];
            stream
                .read_exact(&mut skip)
                .await
                .map_err(|e| io_fail(&crate::i18n::t("SOCKS5 应答地址读取失败"), e))?;
        }
        0x04 => {
            let mut skip = [0u8; 16 + 2];
            stream
                .read_exact(&mut skip)
                .await
                .map_err(|e| io_fail(&crate::i18n::t("SOCKS5 应答地址读取失败"), e))?;
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|e| io_fail(&crate::i18n::t("SOCKS5 应答地址读取失败"), e))?;
            let mut skip = vec![0u8; len[0] as usize + 2];
            stream
                .read_exact(&mut skip)
                .await
                .map_err(|e| io_fail(&crate::i18n::t("SOCKS5 应答地址读取失败"), e))?;
        }
        other => {
            return Err(unexpected(&crate::i18n::t_args(
                "SOCKS5 应答地址类型 0x{code}",
                &[("code", &format!("{other:02x}"))],
            )))
        }
    }
    Ok(stream)
}

// ---------------------------------------------------------------------------
// HTTP CONNECT
// ---------------------------------------------------------------------------

async fn http_connect(
    proxy_host: String,
    proxy_port: u16,
    dest_host: String,
    dest_port: u16,
    username: Option<String>,
    password: Option<String>,
) -> Result<PrefixedStream<TcpStream>, ErrorDto> {
    let mut stream = tcp(&proxy_host, proxy_port).await?;
    let mut request = format!(
        "CONNECT {dest_host}:{dest_port} HTTP/1.1\r\nHost: {dest_host}:{dest_port}\r\n"
    );
    if let (Some(user), Some(pass)) = (username, password) {
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(&base64(&format!("{user}:{pass}")));
        request.push_str("\r\n");
    }
    request.push_str("Proxy-Connection: keep-alive\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| io_fail(&crate::i18n::t("HTTP CONNECT 写入失败"), e))?;

    // 读到空行为止；多读到的字节（可能已含 SSH banner）留给上层。
    let mut buf = Vec::new();
    loop {
        let mut chunk = [0u8; 1024];
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| io_fail(&crate::i18n::t("HTTP CONNECT 读取失败"), e))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 32 * 1024 {
            return Err(unexpected(&crate::i18n::t("HTTP CONNECT 响应头过大")));
        }
    }
    let head_end = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .ok_or_else(|| unexpected(&crate::i18n::t("HTTP CONNECT 响应未结束")))?;
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let status: u16 = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| unexpected(&crate::i18n::t("HTTP CONNECT 状态行缺失")))?;
    if status == 407 {
        return Err(ErrorDto::new(
            ErrorCode::AuthFailed,
            crate::i18n::t("HTTP 代理认证失败（407）"),
        ));
    }
    if status != 200 {
        return Err(ErrorDto::new(
            ErrorCode::Internal,
            crate::i18n::t_args(
                "HTTP 代理拒绝 CONNECT（{status}）",
                &[("status", &status.to_string())],
            ),
        ));
    }
    Ok(PrefixedStream { inner: stream, prefix: buf[head_end..].to_vec(), pos: 0 })
}

/// 把握手时多读的字节先吐给上层，再透传底层流。
pub struct PrefixedStream<T> {
    inner: T,
    prefix: Vec<u8>,
    pos: usize,
}

impl<T: AsyncRead + Unpin> AsyncRead for PrefixedStream<T> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        let this = &mut *self;
        if this.pos < this.prefix.len() {
            let rest = &this.prefix[this.pos..];
            let n = rest.len().min(buf.remaining());
            buf.put_slice(&rest[..n]);
            this.pos += n;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<T> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        data: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, data)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// HTTP Basic 的 base64（避免为一次编码引入依赖）。
fn base64(input: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 { TABLE[(b2 & 0x3f) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_basic() {
        assert_eq!(base64("alice:secret"), "YWxpY2U6c2VjcmV0");
        assert_eq!(base64("a"), "YQ==");
        assert_eq!(base64("ab"), "YWI=");
    }
}
