//! russh `client::Handler` 实现。
//!
//! 握手阶段只做两件事：接受任意 host key（否则无法完成握手），并把服务端
//! 公钥抄送给连接编排层。真正的 TOFU / 指纹变更拦截在 `knownhost::verify`
//! 完成——认证之前调用，失败即断连。

use std::sync::{Arc, Mutex};

use ssh_key::PublicKey;

#[derive(Default)]
pub struct ClientHandler {
    /// 握手观察到的服务端公钥，供 `connect` 在认证前做 known_host 校验。
    pub observed: Arc<Mutex<Option<PublicKey>>>,
}

#[async_trait::async_trait]
impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(ssh_key::HashAlg::Sha256);
        tracing::info!(
            target: "ssh",
            %fingerprint,
            key_type = server_public_key.algorithm().as_str(),
            "host key observed"
        );
        if let Ok(mut slot) = self.observed.lock() {
            *slot = Some(server_public_key.clone());
        }
        Ok(true)
    }
}
