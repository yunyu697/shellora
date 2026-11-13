//! IPC 层的数据传输对象（DTO）。所有字段 camelCase，前端 `types.ts` 一一对应。

use serde::{Deserialize, Serialize};

/// 前端 → Rust 的连接参数。
///
/// 认证优先级：`privateKey` > `agent` > `password`。
/// 路由：`proxy`（若有）先建立到第一跳/目标的 TCP，随后按 `jumps` 顺序逐跳
/// `direct-tcpip` 转发，最后一跳连到 `host:port`。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    /// 密码认证；为空且未配置 key/agent 时报“未提供认证方式”。
    #[serde(default)]
    pub password: String,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// 私钥认证（OpenSSH / PEM / PPK）。
    #[serde(default)]
    pub private_key: Option<PrivateKeyInput>,
    /// ssh-agent 认证。
    #[serde(default)]
    pub agent: Option<AgentInput>,
    /// SOCKS5 / HTTP CONNECT 代理。
    #[serde(default)]
    pub proxy: Option<ProxyInput>,
    /// 跳板链，按顺序经过。
    #[serde(default)]
    pub jumps: Vec<JumpInput>,
    /// 用户已确认首次连接：未知主机在 TOFU 落库后放行。
    #[serde(default)]
    pub trust_new_host_keys: bool,
    /// 是否只读参考系统 `~/.ssh/known_hosts`（默认开启，D5）。
    #[serde(default = "default_true")]
    pub use_system_known_hosts: bool,
    /// 覆盖 known_hosts 路径（测试/自定义部署用）。
    #[serde(default)]
    pub known_hosts_file: Option<String>,
}

impl Default for ConnectionInput {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: default_port(),
            username: String::new(),
            password: String::new(),
            cols: default_cols(),
            rows: default_rows(),
            private_key: None,
            agent: None,
            proxy: None,
            jumps: Vec::new(),
            trust_new_host_keys: false,
            use_system_known_hosts: true,
            known_hosts_file: None,
        }
    }
}

/// 私钥来源：文件路径 + 可选口令（OpenSSH/PEM 加密私钥、PPK 口令）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateKeyInput {
    pub path: String,
    #[serde(default)]
    pub passphrase: Option<String>,
}

/// ssh-agent 端点。`socket` 为空时使用平台默认：
/// Unix 读 `SSH_AUTH_SOCK`；Windows 优先 OpenSSH agent 命名管道，否则 Pageant。
/// 测试可传 `tcp://host:port`。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInput {
    #[serde(default)]
    pub socket: Option<String>,
    /// 选择 identity：SHA256 指纹或公钥 base64 片段；为空取第一个。
    #[serde(default)]
    pub key: Option<String>,
}

/// 代理类型（tag = `kind`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ProxyInput {
    Socks5 {
        host: String,
        #[serde(default = "default_port")]
        port: u16,
        #[serde(default)]
        username: Option<String>,
        #[serde(default)]
        password: Option<String>,
    },
    HttpConnect {
        host: String,
        #[serde(default = "default_port")]
        port: u16,
        #[serde(default)]
        username: Option<String>,
        #[serde(default)]
        password: Option<String>,
    },
}

/// 单个跳板主机（ProxyJump 的一跳）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpInput {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub private_key: Option<PrivateKeyInput>,
    #[serde(default)]
    pub agent: Option<AgentInput>,
}

fn default_port() -> u16 {
    22
}
fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}
fn default_true() -> bool {
    true
}

/// 每标签终端流消息（走 `tauri::ipc::Channel`，有序、点对点）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "k", rename_all = "camelCase")]
pub enum StreamMsg {
    /// 终端数据帧。`b` 为原始字节，前端按 `Uint8Array` 或数字数组消费。
    Data { seq: u64, b: Vec<u8> },
    /// 响铃
    Bell,
    /// OSC 0/2 标题
    Title { s: String },
    /// 通道结束（`code` 为远端 exit status）
    Eof { code: Option<u32> },
}

/// 连接状态快照（同时用于事件与查询命令）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnStateDto {
    pub state: &'static str,
    pub reason: Option<String>,
}

impl ConnStateDto {
    pub fn connecting() -> Self {
        Self { state: "connecting", reason: None }
    }
    pub fn ready() -> Self {
        Self { state: "ready", reason: None }
    }
    pub fn suspended(reason: impl Into<String>) -> Self {
        Self { state: "suspended", reason: Some(reason.into()) }
    }
    pub fn closed(reason: impl Into<String>) -> Self {
        Self { state: "closed", reason: Some(reason.into()) }
    }
    pub fn failed(reason: impl Into<String>) -> Self {
        Self { state: "failed", reason: Some(reason.into()) }
    }
}

/// 打开标签的返回值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTabDto {
    pub tab_id: String,
}

/// 连接状态事件载荷（`conn_state`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnStateEvent {
    pub tab_id: String,
    pub state: &'static str,
    pub reason: Option<String>,
}

/// 钥匙串探测结果（D1：Linux 无 secret-service 时不落明文）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretProbeDto {
    pub backend: &'static str,
    pub detail: String,
}

/// SFTP 传输进度流（走独立 `tauri::ipc::Channel`，50ms/16KB 合并后发送）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "k", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TransferMsg {
    Progress {
        job_id: String,
        transferred: u64,
        total: u64,
        /// 本次运行的平均速度（MB/s）
        mbps: f64,
    },
    Done {
        job_id: String,
        transferred: u64,
        total: u64,
        mbps: f64,
        elapsed_ms: u64,
        /// 本次运行开始前从断点续传的字节数
        resumed_bytes: u64,
    },
    Failed {
        job_id: String,
        code: &'static str,
        message: String,
    },
}

/// 单文件传输结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResultDto {
    pub job_id: String,
    pub transferred: u64,
    pub total: u64,
    pub resumed_bytes: u64,
    pub elapsed_ms: u64,
    pub mbps: f64,
}

// ---- M3：目录列表 ----

/// 目录项（远端 SFTP / 本地磁盘共用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// 修改时间（毫秒时间戳；未知为 0）
    pub mtime: i64,
}

/// 远端目录流式分页消息（每页最多 `SFTP_DIR_PAGE_SIZE` 条）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "k", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DirListMsg {
    Page {
        listing_id: String,
        path: String,
        offset: u64,
        entries: Vec<DirEntryDto>,
    },
    Done {
        listing_id: String,
        path: String,
        total: u64,
    },
    Failed {
        listing_id: String,
        path: String,
        code: &'static str,
        message: String,
    },
}

/// 本地目录分页结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirPageDto {
    pub path: String,
    pub offset: usize,
    pub entries: Vec<DirEntryDto>,
    pub has_more: bool,
    pub next_offset: usize,
}

// ---- M3：传输队列 ----

/// 入队一项：方向 + 标签 + 两端路径。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEnqueueItem {
    pub direction: String,
    pub tab_id: String,
    pub remote_path: String,
    pub local_path: String,
}

/// 队列任务快照（前端按 id 覆盖更新）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTaskDto {
    pub id: String,
    pub group_id: Option<String>,
    pub direction: String,
    pub tab_id: String,
    pub remote_path: String,
    pub local_path: String,
    /// queued | running | paused | conflict | done | failed | cancelled | skipped
    pub state: &'static str,
    pub transferred: u64,
    pub total: u64,
    pub mbps: f64,
    /// 预计剩余秒数（未知为 null）
    pub eta_secs: Option<f64>,
    pub resumed_bytes: u64,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

/// 递归目录传输的整组聚合快照（M3.5）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferGroupDto {
    pub id: String,
    pub label: String,
    pub direction: String,
    /// 上传目标远端目录 / 下载目标本地目录
    pub remote_path: String,
    pub local_path: String,
    /// ask | overwrite | skip | rename
    pub policy: String,
    pub create_empty_dirs: bool,
    /// queued | running | paused | conflict | done | failed | cancelled
    pub state: &'static str,
    pub files_total: usize,
    pub files_done: usize,
    pub transferred: u64,
    pub total: u64,
    pub mbps: f64,
    pub eta_secs: Option<f64>,
    pub error_code: Option<String>,
}

/// 队列进度流：更新总是携带完整快照，前端按 id 覆盖。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "k", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum QueueMsg {
    Update { task: TransferTaskDto },
    Group { group: TransferGroupDto },
}

/// 递归目录传输选项。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeOptionsDto {
    pub max_depth: usize,
    pub max_files: usize,
    pub create_empty_dirs: bool,
    /// ask | overwrite | skip | rename
    pub conflict_policy: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEnqueueRequest {
    pub direction: String,
    pub tab_id: String,
    /// 源目录（上传=本地绝对路径，下载=远端路径）
    pub source_path: String,
    /// 目标目录（上传=远端目录，下载=本地目录）
    pub dest_dir: String,
    pub options: TreeOptionsDto,
}

/// 展开并入队后的摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeGroupStartedDto {
    pub group_id: String,
    pub files: usize,
    pub dirs_created: usize,
    pub bytes: u64,
}

/// 本地单路径元数据（用于外部文件拖入时区分文件/目录）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatDto {
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
}

/// 数据清理结果（M6 验收 5）。只报告应用自有数据，不涉及系统 `~/.ssh`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataClearReport {
    /// cache | all
    pub scope: String,
    /// 删除的业务行数
    pub rows_removed: usize,
    /// 已处理的项（表名 / 文件）
    pub items: Vec<String>,
    /// 数据库文件路径（提示用）
    pub db_path: String,
    /// 非致命警告（如日志目录删除失败）
    pub warnings: Vec<String>,
}
