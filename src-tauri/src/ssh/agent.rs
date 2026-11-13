//! ssh-agent 认证：连接 agent、选择 identity、完成公钥认证。
//!
//! 端点：显式 `socket`（Unix socket / Windows 命名管道 / `tcp://`）或平台默认
//! （Unix `SSH_AUTH_SOCK`；Windows OpenSSH agent → Pageant）。

use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use russh::keys::agent::client::{AgentClient, AgentStream};

use crate::error::{ErrorCode, ErrorDto};
use crate::ipc::dto::AgentInput;
use crate::ssh::handler::ClientHandler;

type DynamicAgent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

const AGENT_TIMEOUT_MS: u64 = 5_000;

pub fn authenticate<'a>(
    handle: &'a mut russh::client::Handle<ClientHandler>,
    username: String,
    spec: AgentInput,
) -> BoxFuture<'a, Result<(), ErrorDto>> {
    Box::pin(async move {
        let mut agent = connect(spec.socket).await?;
        let identities = match tokio::time::timeout(
            Duration::from_millis(AGENT_TIMEOUT_MS),
            agent.request_identities(),
        )
        .await
        {
            Err(_) => return Err(agent_err(crate::i18n::t("ssh-agent 响应超时"))),
            Ok(Err(e)) => {
                return Err(agent_err(crate::i18n::t_args(
                    "ssh-agent 读取 identities 失败：{error}",
                    &[("error", &e.to_string())],
                )))
            }
            Ok(Ok(ids)) => ids,
        };

        let key = select_identity(&identities, spec.key.as_deref())?;
        let accepted = handle
            .authenticate_publickey_with(username, key, &mut agent)
            .boxed()
            .await
            .map_err(|e| {
                agent_err(crate::i18n::t_args(
                    "ssh-agent 认证失败：{error}",
                    &[("error", &e.to_string())],
                ))
            })?;
        if !accepted {
            return Err(ErrorDto::new(
                ErrorCode::AuthFailed,
                crate::i18n::t("认证失败：ssh-agent 密钥被服务器拒绝"),
            ));
        }
        Ok(())
    })
}

fn agent_err(message: impl Into<String>) -> ErrorDto {
    ErrorDto::new(ErrorCode::AuthFailed, message)
}

fn select_identity(
    identities: &[ssh_key::PublicKey],
    hint: Option<&str>,
) -> Result<ssh_key::PublicKey, ErrorDto> {
    if identities.is_empty() {
        return Err(agent_err(crate::i18n::t("ssh-agent 中没有可用的 identity")));
    }
    let Some(hint) = hint.filter(|h| !h.is_empty()) else {
        return Ok(identities[0].clone());
    };
    for key in identities {
        let fingerprint = key.fingerprint(ssh_key::HashAlg::Sha256).to_string();
        let openssh = key.to_openssh().unwrap_or_default();
        if fingerprint.contains(hint) || openssh.contains(hint) {
            return Ok(key.clone());
        }
    }
    Err(agent_err(crate::i18n::t_args(
        "ssh-agent 中找不到匹配的 identity：{hint}",
        &[("hint", hint)],
    )))
}

async fn connect(socket: Option<String>) -> Result<DynamicAgent, ErrorDto> {
    if let Some(endpoint) = socket.as_deref() {
        if let Some(addr) = endpoint.strip_prefix("tcp://") {
            let stream = tokio::net::TcpStream::connect(addr)
                .await
                .map_err(|e| {
                    agent_err(crate::i18n::t_args(
                        "无法连接 ssh-agent {addr}：{error}",
                        &[("addr", addr), ("error", &e.to_string())],
                    ))
                })?;
            return Ok(AgentClient::connect(Box::new(stream)).dynamic());
        }
    }

    #[cfg(unix)]
    {
        let path = socket
            .or_else(|| std::env::var("SSH_AUTH_SOCK").ok())
            .ok_or_else(|| agent_err(crate::i18n::t("未找到 ssh-agent：SSH_AUTH_SOCK 未设置")))?;
        let agent = AgentClient::connect_uds(path).await.map_err(|e| {
            agent_err(crate::i18n::t_args(
                "无法连接 ssh-agent：{error}",
                &[("error", &e.to_string())],
            ))
        })?;
        Ok(agent.dynamic())
    }

    #[cfg(windows)]
    {
        let pipe = socket.unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".to_string());
        match AgentClient::connect_named_pipe(&pipe).await {
            Ok(agent) => Ok(agent.dynamic()),
            Err(_) => {
                // 没有 OpenSSH agent 时回退 Pageant（PuTTY 用户常见）。
                Ok(AgentClient::connect_pageant().await.dynamic())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::select_identity;

    #[test]
    fn select_empty_is_error() {
        assert!(select_identity(&[], None).is_err());
    }
}
