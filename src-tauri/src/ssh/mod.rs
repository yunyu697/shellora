//! SSH 客户端：代理 / 跳板链、认证（密码 / 私钥 / ssh-agent）、打开 shell 通道。

pub mod agent;
pub mod connect;
pub mod handler;
pub mod keys;
pub mod proxy;

use futures_util::future::BoxFuture;

use crate::db::Database;
use crate::ipc::dto::ConnectionInput;

pub use connect::SshHandle;

/// 连接并打开一个已请求 PTY 的交互式 shell 通道。
///
/// `store` 为 `None` 时跳过 known_host 校验（仅限不接数据库的测试）；应用内
/// 始终传入数据库，未知主机需用户确认、指纹变更一律阻断。
pub fn open_shell<'a>(
    input: &'a ConnectionInput,
    cols: u16,
    rows: u16,
    store: Option<&'a Database>,
) -> BoxFuture<'a, Result<(SshHandle, russh::Channel<russh::client::Msg>), crate::error::ErrorDto>>
{
    connect::connect_and_shell(input, cols, rows, store)
}

/// `conn_test`：只连接 + 认证，不开通道，用于会话库的“测试连接”。
pub fn probe<'a>(
    input: &'a ConnectionInput,
    store: Option<&'a Database>,
) -> BoxFuture<'a, Result<(), crate::error::ErrorDto>> {
    Box::pin(async move {
        let handle = connect::connect_authenticated(input, store).await?;
        drop(handle);
        Ok(())
    })
}
