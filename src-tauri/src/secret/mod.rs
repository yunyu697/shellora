//! 凭据与密钥（M0 只有钥匙串探测桩，真实读写推迟到 M4）。

use crate::ipc::dto::SecretProbeDto;

/// 探测当前平台可用的凭据后端（D1：Linux 无 secret-service 时返回 `none`）。
pub fn probe() -> SecretProbeDto {
    #[cfg(target_os = "linux")]
    {
        let has_dbus = std::env::var("DBUS_SESSION_BUS_ADDRESS").is_ok();
        if has_dbus {
            SecretProbeDto {
                backend: "keychain",
                detail: "secret-service (DBus 可用)".into(),
            }
        } else {
            SecretProbeDto {
                backend: "none",
                detail: "未检测到 DBus/secret-service，将禁用保存密码（D1）".into(),
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        SecretProbeDto { backend: "keychain", detail: "Windows Credential Manager".into() }
    }
    #[cfg(target_os = "macos")]
    {
        SecretProbeDto { backend: "keychain", detail: "macOS Keychain".into() }
    }
}
