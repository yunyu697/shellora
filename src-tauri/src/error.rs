use serde::Serialize;

/// 稳定错误码（附录 B 的子集，M0 只落地用得到的部分）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    AuthFailed,
    HostKeyUnknown,
    HostKeyChanged,
    NetTimeout,
    NetRefused,
    NetDns,
    ChannelClosed,
    KeychainUnavailable,
    Internal,
    SftpTargetExists,
    SftpPermissionDenied,
    SftpNoSuchFile,
    SftpProtocol,
    TransferInterrupted,
    TransferLimitExceeded,
    FsIo,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::AuthFailed => "AUTH_FAILED",
            ErrorCode::HostKeyUnknown => "HOSTKEY_UNKNOWN",
            ErrorCode::HostKeyChanged => "HOSTKEY_CHANGED",
            ErrorCode::NetTimeout => "NET_TIMEOUT",
            ErrorCode::NetRefused => "NET_REFUSED",
            ErrorCode::NetDns => "NET_DNS",
            ErrorCode::ChannelClosed => "CHANNEL_CLOSED",
            ErrorCode::KeychainUnavailable => "KEYCHAIN_UNAVAILABLE",
            ErrorCode::Internal => "INTERNAL",
            ErrorCode::SftpTargetExists => "SFTP_TARGET_EXISTS",
            ErrorCode::SftpPermissionDenied => "SFTP_PERMISSION_DENIED",
            ErrorCode::SftpNoSuchFile => "SFTP_NO_SUCH_FILE",
            ErrorCode::SftpProtocol => "SFTP_PROTOCOL",
            ErrorCode::TransferInterrupted => "TRANSFER_INTERRUPTED",
            ErrorCode::TransferLimitExceeded => "TRANSFER_LIMIT_EXCEEDED",
            ErrorCode::FsIo => "FS_IO",
        }
    }
}

/// 返回给前端的错误体：前端按 `code` 做文案映射，不看 message。
#[derive(Debug, Clone, Serialize)]
pub struct ErrorDto {
    pub code: &'static str,
    pub message: String,
    pub retriable: bool,
    /// 结构化补充信息（如 host key 指纹），前端确认弹窗直接消费。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ErrorDto {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        let retriable = matches!(
            code,
            ErrorCode::NetTimeout
                | ErrorCode::NetRefused
                | ErrorCode::ChannelClosed
                | ErrorCode::TransferInterrupted
        );
        Self {
            code: code.as_str(),
            message: message.into(),
            retriable,
            details: None,
        }
    }

    /// 附带结构化细节（不改变 `code` 与 `retriable` 语义）。
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}
