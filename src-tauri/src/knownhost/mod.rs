//! 已知主机校验（TOFU）：首次连接落库待用户确认，指纹变更一律阻断。
//!
//! 优先级：自有 `known_host` 表 > 系统 `~/.ssh/known_hosts`（只读，D5）。
//! 表里存在该主机记录但没有任何一条匹配当前密钥 → `HOSTKEY_CHANGED`，
//! 绝不覆盖旧记录；用户只能手动删除记录后重连。

use std::path::PathBuf;

use serde_json::json;
use ssh_key::PublicKey;

use crate::db::{Database, KnownHostRow};
use crate::error::{ErrorCode, ErrorDto};

/// 本次连接的主机密钥校验策略（由 `ConnectionInput` 派生，逐跳共享）。
#[derive(Debug, Clone)]
pub struct KnownHostPolicy {
    /// 用户已确认首次连接：未知主机落库并放行。
    pub trust_new: bool,
    /// 是否只读参考系统 known_hosts。
    pub use_system: bool,
    /// 覆盖 known_hosts 路径（测试/自定义）。
    pub known_hosts_file: Option<PathBuf>,
}

impl KnownHostPolicy {
    pub fn from_input(input: &crate::ipc::dto::ConnectionInput) -> Self {
        Self {
            trust_new: input.trust_new_host_keys,
            use_system: input.use_system_known_hosts,
            known_hosts_file: input
                .known_hosts_file
                .as_ref()
                .map(|p| PathBuf::from(p.trim()))
                .filter(|p| !p.as_os_str().is_empty()),
        }
    }

    /// 系统 known_hosts 默认路径：`~/.ssh/known_hosts`（Windows 同样适用）。
    fn system_path(&self) -> Option<PathBuf> {
        if let Some(path) = &self.known_hosts_file {
            return Some(path.clone());
        }
        let home = crate::local::home_dir();
        let home = PathBuf::from(home);
        let path = home.join(".ssh").join("known_hosts");
        path.is_file().then_some(path)
    }
}

/// 校验服务端 host key。`Ok(())` 表示可以继续认证；否则返回拦截错误。
pub fn verify(
    store: &Database,
    policy: &KnownHostPolicy,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> Result<(), ErrorDto> {
    let key_type = key.algorithm().as_str().to_string();
    let (fp_sha256, fp_md5) = fingerprints(key);
    let blob = key.to_bytes().unwrap_or_default();

    // 1) 自有信任库：任意一条完全匹配即放行；有记录但都不匹配 → 变更阻断。
    let rows = store
        .list_known_hosts(host, port)
        .map_err(|e| ErrorDto::internal(format!("读取 known_host 失败：{e}")))?;
    let trusted: Vec<&KnownHostRow> = rows.iter().filter(|r| r.trust > 0).collect();
    if !trusted.is_empty() {
        if let Some(hit) = trusted
            .iter()
            .find(|r| r.key_type == key_type && r.public_key == blob)
        {
            let _ = store.touch_known_host(&hit.id);
            tracing::debug!(target: "ssh", %host, port, %fp_sha256, "host key matched (db)");
            return Ok(());
        }
        let known = trusted
            .iter()
            .map(|r| (r.key_type.clone(), r.fingerprint_sha256.clone()))
            .collect::<Vec<_>>();
        return Err(host_key_changed(
            host, port, &key_type, &fp_sha256, &fp_md5, &known,
        ));
    }

    // 2) 系统 known_hosts（只读）：匹配即放行，变更同样阻断，解析失败只警告。
    if policy.use_system {
        if let Some(path) = policy.system_path() {
            match russh::keys::known_hosts::check_known_hosts_path(host, port, key, &path) {
                Ok(true) => {
                    tracing::debug!(target: "ssh", %host, port, %fp_sha256, "host key matched (known_hosts)");
                    return Ok(());
                }
                Ok(false) => {}
                Err(russh::keys::Error::KeyChanged { .. }) => {
                    let known = recorded_keys(&path, host, port);
                    return Err(host_key_changed(
                        host, port, &key_type, &fp_sha256, &fp_md5, &known,
                    ));
                }
                Err(err) => {
                    tracing::warn!(
                        target: "ssh",
                        path = %path.display(),
                        %err,
                        "known_hosts 解析失败，按未知主机继续"
                    );
                }
            }
        }
    }

    // 3) 未知主机：用户未确认前一律拦截；确认后 TOFU 落库。
    if policy.trust_new {
        store
            .upsert_known_host(host, port, &key_type, &blob, &fp_sha256)
            .map_err(|e| ErrorDto::internal(format!("写入 known_host 失败：{e}")))?;
        tracing::info!(target: "ssh", %host, port, %fp_sha256, "host key trusted (TOFU)");
        return Ok(());
    }

    Err(ErrorDto::new(
        ErrorCode::HostKeyUnknown,
        format!(
            "首次连接未知主机 {host}:{port}（{key_type}）\nSHA256: {fp_sha256}\nMD5: {fp_md5}"
        ),
    )
    .with_details(json!({
        "kind": "unknown",
        "host": host,
        "port": port,
        "keyType": key_type,
        "fingerprintSha256": fp_sha256,
        "fingerprintMd5": fp_md5,
    })))
}

/// SHA256（默认展示用，带 `SHA256:` 前缀）与 MD5 两种指纹。
///
/// ssh-key 只有 SHA256/SHA512，MD5 按 OpenSSH 规则对公钥 blob 计算并冒号分组。
pub fn fingerprints(key: &PublicKey) -> (String, String) {
    let sha256 = key.fingerprint(ssh_key::HashAlg::Sha256).to_string();
    let blob = key.to_bytes().unwrap_or_default();
    let digest = md5::compute(&blob);
    let hex = format!("{digest:x}");
    let pairs = hex
        .as_bytes()
        .chunks(2)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
        .collect::<Vec<_>>()
        .join(":");
    (sha256, format!("MD5:{pairs}"))
}

fn host_key_changed(
    host: &str,
    port: u16,
    key_type: &str,
    fp_sha256: &str,
    fp_md5: &str,
    known: &[(String, String)],
) -> ErrorDto {
    let known_desc = known
        .iter()
        .map(|(t, fp)| format!("{t} {fp}"))
        .collect::<Vec<_>>()
        .join("；");
    ErrorDto::new(
        ErrorCode::HostKeyChanged,
        format!(
            "警告：主机 {host}:{port} 的主机密钥已变更，可能存在中间人攻击。\n\
             已信任：{known_desc}\n当前：{key_type} {fp_sha256}\n\
             已阻断连接；请确认风险后手动删除该主机的信任记录再重连。"
        ),
    )
    .with_details(json!({
        "kind": "changed",
        "host": host,
        "port": port,
        "keyType": key_type,
        "fingerprintSha256": fp_sha256,
        "fingerprintMd5": fp_md5,
        "known": known.iter().map(|(t, fp)| json!({ "keyType": t, "fingerprintSha256": fp })).collect::<Vec<_>>(),
    }))
}

/// 从系统 known_hosts 取出该主机已记录的公钥指纹（用于变更提示）。
fn recorded_keys(path: &PathBuf, host: &str, port: u16) -> Vec<(String, String)> {
    let Ok(keys) = russh::keys::known_hosts::known_host_keys_path(host, port, path) else {
        return Vec::new();
    };
    keys.into_iter()
        .map(|(_, key)| {
            let (fp, _) = fingerprints(&key);
            (key.algorithm().as_str().to_string(), fp)
        })
        .collect()
}
