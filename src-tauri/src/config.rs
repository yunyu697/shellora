//! 应用级常量，禁止在其它模块散落魔法数。

/// 终端输出合并阈值（字节）
pub const TERM_COALESCE_BYTES: usize = 32 * 1024;
/// 终端输出合并超时（毫秒）
pub const TERM_COALESCE_MS: u64 = 8;
/// 每标签信用窗口（字节）
pub const TERM_WINDOW_BYTES: usize = 256 * 1024;
/// 单 permit 粒度（字节）
pub const TERM_PERMIT_BYTES: usize = 8 * 1024;
/// ack 超时（毫秒）
pub const TERM_ACK_TIMEOUT_MS: u64 = 5_000;
/// resize 合并窗口（毫秒）
pub const RESIZE_DEBOUNCE_MS: u64 = 60;
/// 标签硬上限
pub const MAX_TABS: usize = 30;
/// 连接超时（毫秒）
pub const CONNECT_TIMEOUT_MS: u64 = 15_000;
/// 心跳间隔（毫秒）
pub const KEEPALIVE_MS: u64 = 30_000;

// ---- SFTP 单文件传输（M2）----
/// 传输通道并发数（每个通道一条独立 SFTP subsystem channel）
pub const SFTP_CHANNELS: usize = 4;
/// 单次 SFTP 读写请求大小（字节）
pub const SFTP_REQUEST_BYTES: usize = 64 * 1024;
/// 传输分块粒度（字节），续传偏移按此对齐
pub const SFTP_CHUNK_BYTES: u64 = 256 * 1024;
/// 每通道在途请求数（读写各 2 个）
pub const SFTP_INFLIGHT_PER_CHANNEL: usize = 2;
/// 进度合并：至少累积这么多字节才上报一帧
pub const SFTP_PROGRESS_MIN_BYTES: u64 = 16 * 1024;
/// 进度合并：两次上报的最小间隔（毫秒）
pub const SFTP_PROGRESS_INTERVAL_MS: u64 = 50;
/// 续传偏移落库间隔（毫秒）
pub const SFTP_SAVE_INTERVAL_MS: u64 = 100;
/// 目录流式分页大小（条/页），避免大目录一次性拉全量
pub const SFTP_DIR_PAGE_SIZE: usize = 500;

// ---- 传输队列（M3）----
/// 同时运行的任务数上限（每个任务内部仍用 SFTP_CHANNELS 条通道）
pub const TRANSFER_CONCURRENCY: usize = 2;
