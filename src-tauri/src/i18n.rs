//! Rust 侧文案：托盘菜单、提示与后端错误。
//!
//! 与前端保持一致：**简体中文原文就是 key**，查不到时回落英文。
//! 当前语种由前端在启动时和用户切换语言时通过 `set_locale` 写入，
//! 同时落盘到 settings.json，保证下次启动托盘菜单直接是上次的语言。

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    ZhCn = 0,
    ZhTw = 1,
    En = 2,
    Ja = 3,
    Es = 4,
}

static CURRENT: AtomicU8 = AtomicU8::new(Locale::En as u8);

pub fn parse(tag: &str) -> Locale {
    let t = tag.to_ascii_lowercase().replace('_', "-");
    if t.starts_with("zh") {
        if t.contains("hant") || t.contains("tw") || t.contains("hk") || t.contains("mo") {
            Locale::ZhTw
        } else {
            Locale::ZhCn
        }
    } else if t.starts_with("ja") {
        Locale::Ja
    } else if t.starts_with("es") {
        Locale::Es
    } else {
        Locale::En
    }
}

pub fn set(tag: &str) {
    CURRENT.store(parse(tag) as u8, Ordering::Relaxed);
}

pub fn current() -> Locale {
    match CURRENT.load(Ordering::Relaxed) {
        0 => Locale::ZhCn,
        1 => Locale::ZhTw,
        3 => Locale::Ja,
        4 => Locale::Es,
        _ => Locale::En,
    }
}

fn dict(locale: Locale) -> &'static [(&'static str, &'static str)] {
    match locale {
        Locale::ZhTw => ZH_TW,
        Locale::En => EN,
        Locale::Ja => JA,
        Locale::Es => ES,
        Locale::ZhCn => &[],
    }
}

/// 翻译一条文案；简体中文直接返回原文。
pub fn t(zh: &str) -> String {
    let locale = current();
    if locale == Locale::ZhCn {
        return zh.to_string();
    }
    for (key, value) in dict(locale) {
        if *key == zh {
            return (*value).to_string();
        }
    }
    for (key, value) in EN {
        if *key == zh {
            return (*value).to_string();
        }
    }
    zh.to_string()
}

/// 带占位符的翻译：`{name}` 会被替换。
pub fn t_args(zh: &str, args: &[(&str, &str)]) -> String {
    let mut out = t(zh);
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

const EN: &[(&str, &str)] = &[
    ("显示/隐藏主窗口", "Show/Hide main window"),
    ("新建连接", "New connection"),
    ("（暂无活动会话）", "(No active sessions)"),
    ("活动会话", "Active sessions"),
    ("退出 Shellora", "Quit Shellora"),
    ("未连接", "Not connected"),
    ("已连接 {who}", "Connected to {who}"),
    ("读取设置失败：{error}", "Failed to read settings: {error}"),
    ("关闭窗口时最小化到托盘", "Minimize to tray when closing"),
    // 通用模板
    ("{what}：{error}", "{what}: {error}"),
    ("；", "; "),
    ("代理响应异常：{detail}", "Unexpected proxy response: {detail}"),
    // 代理（SOCKS5 / HTTP CONNECT）
    ("SOCKS5 握手超时", "SOCKS5 handshake timed out"),
    ("HTTP CONNECT 握手超时", "HTTP CONNECT handshake timed out"),
    ("无法连接代理 {host}:{port}：{error}", "Cannot connect to proxy {host}:{port}: {error}"),
    ("SOCKS5 版本号不是 5", "SOCKS5 version is not 5"),
    (
        "SOCKS5 代理要求用户名/密码，但未提供",
        "SOCKS5 proxy requires a username/password, but none was provided",
    ),
    ("SOCKS5 用户名/密码过长", "SOCKS5 username/password is too long"),
    ("SOCKS5 认证失败", "SOCKS5 authentication failed"),
    ("SOCKS5 代理拒绝所有认证方式", "SOCKS5 proxy rejected all authentication methods"),
    (
        "SOCKS5 选择了不支持的认证方式 0x{code}",
        "SOCKS5 selected an unsupported authentication method 0x{code}",
    ),
    ("目标主机名超过 255 字节", "Target hostname exceeds 255 bytes"),
    ("代理拒绝连接 {host}:{port}", "Proxy refused the connection to {host}:{port}"),
    (
        "代理报告目标不可达：{host}:{port}",
        "Proxy reported the target as unreachable: {host}:{port}",
    ),
    ("SOCKS5 应答失败码 0x{code}", "SOCKS5 reply failure code 0x{code}"),
    ("SOCKS5 应答版本号不是 5", "SOCKS5 reply version is not 5"),
    ("SOCKS5 应答地址类型 0x{code}", "SOCKS5 reply address type 0x{code}"),
    ("SOCKS5 协商写入失败", "Failed to write SOCKS5 negotiation"),
    ("SOCKS5 协商读取失败", "Failed to read SOCKS5 negotiation"),
    ("SOCKS5 认证写入失败", "Failed to write SOCKS5 authentication"),
    ("SOCKS5 认证读取失败", "Failed to read SOCKS5 authentication"),
    ("SOCKS5 请求写入失败", "Failed to write SOCKS5 request"),
    ("SOCKS5 应答读取失败", "Failed to read SOCKS5 reply"),
    ("SOCKS5 应答地址读取失败", "Failed to read SOCKS5 reply address"),
    ("HTTP CONNECT 写入失败", "Failed to write HTTP CONNECT request"),
    ("HTTP CONNECT 读取失败", "Failed to read HTTP CONNECT response"),
    ("HTTP CONNECT 响应头过大", "HTTP CONNECT response header is too large"),
    ("HTTP CONNECT 响应未结束", "HTTP CONNECT response did not end"),
    ("HTTP CONNECT 状态行缺失", "HTTP CONNECT status line is missing"),
    ("HTTP 代理认证失败（407）", "HTTP proxy authentication failed (407)"),
    ("HTTP 代理拒绝 CONNECT（{status}）", "HTTP proxy refused CONNECT ({status})"),
    // 私钥 / PPK
    ("无法读取私钥 {path}：{error}", "Cannot read private key {path}: {error}"),
    (
        "私钥已加密：请提供口令（passphrase）",
        "The private key is encrypted: please provide the passphrase",
    ),
    ("私钥解析失败：{error}", "Failed to parse the private key: {error}"),
    ("PPK 文件头缺失", "PPK file header is missing"),
    (
        "暂不支持加密的 PPK 私钥：请用 PuTTYgen 去掉口令，或导出为 OpenSSH 格式",
        "Encrypted PPK private keys are not supported yet: remove the passphrase with PuTTYgen, or export to OpenSSH format",
    ),
    ("PPK 公钥缺少算法名", "PPK public key is missing the algorithm name"),
    ("PPK 公钥缺少 {field}", "PPK public key is missing {field}"),
    ("PPK 私钥缺少 {field}", "PPK private key is missing {field}"),
    ("PPK 公钥缺少公钥值", "PPK public key is missing the public key value"),
    ("PPK 私钥缺少密钥值", "PPK private key is missing the key value"),
    ("PPK 公钥缺少曲线名", "PPK public key is missing the curve name"),
    ("PPK 公钥缺少曲线点", "PPK public key is missing the curve point"),
    (
        "Ed25519 PPK 私钥长度异常（{size} 字节，应为 64）",
        "Ed25519 PPK private key has an invalid length ({size} bytes, expected 64)",
    ),
    ("PPK 算法不受支持：{algorithm}", "Unsupported PPK algorithm: {algorithm}"),
    ("PPK 私钥校验失败：{error}", "PPK private key validation failed: {error}"),
    ("PPK 缺少 {name} 段", "PPK is missing the {name} section"),
    ("PPK {name} 行格式错误", "PPK {name} line has an invalid format"),
    ("PPK {name} 数据不完整", "PPK {name} data is incomplete"),
    ("PPK {name} base64 解码失败：{error}", "Failed to base64-decode PPK {name}: {error}"),
    // SSH 连接与认证
    (
        "未提供认证方式：请填写密码、私钥或启用 ssh-agent",
        "No authentication method provided: enter a password, a private key, or enable ssh-agent",
    ),
    ("与 {host} 的 SSH 握手超时", "SSH handshake with {host} timed out"),
    (
        "与 {host} 握手结束但未获得服务端主机密钥",
        "Handshake with {host} finished but the server host key was not received",
    ),
    (
        "认证失败：{username}@{host} 密码不正确",
        "Authentication failed: incorrect password for {username}@{host}",
    ),
    ("私钥不可用于认证：{error}", "The private key cannot be used for authentication: {error}"),
    (
        "认证失败：{username}@{host} 未接受该私钥",
        "Authentication failed: {username}@{host} did not accept this private key",
    ),
    (
        "{host} 拒绝连接（端口未开放或被防火墙拦截）",
        "{host} refused the connection (port closed or blocked by a firewall)",
    ),
    ("连接 {host} 超时", "Connection to {host} timed out"),
    ("无法解析主机 {host}", "Cannot resolve host {host}"),
    ("SSH 连接失败：{error}", "SSH connection failed: {error}"),
    // ssh-agent
    ("ssh-agent 响应超时", "ssh-agent timed out"),
    ("ssh-agent 读取 identities 失败：{error}", "Failed to read identities from ssh-agent: {error}"),
    ("ssh-agent 认证失败：{error}", "ssh-agent authentication failed: {error}"),
    (
        "认证失败：ssh-agent 密钥被服务器拒绝",
        "Authentication failed: the server rejected the ssh-agent key",
    ),
    ("ssh-agent 中没有可用的 identity", "ssh-agent has no available identity"),
    (
        "ssh-agent 中找不到匹配的 identity：{hint}",
        "No matching identity found in ssh-agent: {hint}",
    ),
    ("无法连接 ssh-agent {addr}：{error}", "Cannot connect to ssh-agent {addr}: {error}"),
    (
        "未找到 ssh-agent：SSH_AUTH_SOCK 未设置",
        "ssh-agent not found: SSH_AUTH_SOCK is not set",
    ),
    ("无法连接 ssh-agent：{error}", "Cannot connect to ssh-agent: {error}"),
    // SFTP / 传输
    ("远端路径不是普通文件：{path}", "Remote path is not a regular file: {path}"),
    ("本地路径不是普通文件：{path}", "Local path is not a regular file: {path}"),
    ("传输任务异常：{error}", "Transfer task failed: {error}"),
    (
        "远端文件提前结束：已读 {off}+{done} 字节",
        "Remote file ended early: read {off}+{done} bytes",
    ),
    (
        "本地文件提前结束：已读 {off}+{done} 字节",
        "Local file ended early: read {off}+{done} bytes",
    ),
    (
        "SSH 会话尚未就绪，无法开始传输",
        "The SSH session is not ready yet, cannot start the transfer",
    ),
    ("打开通道失败：{error}", "Failed to open a channel: {error}"),
    ("请求 sftp 子系统失败：{error}", "Failed to request the sftp subsystem: {error}"),
    ("SFTP 请求超时", "SFTP request timed out"),
    ("目标已存在：{path}", "Target already exists: {path}"),
    ("传输被中断，可从断点继续", "Transfer interrupted; it can resume from the checkpoint"),
    (
        "目录层级超过上限 {max_depth}（在 {rel}）",
        "Directory depth exceeds the limit of {max_depth} (at {rel})",
    ),
    (
        "文件数超过上限 {max_files}（在 {rel}）",
        "File count exceeds the limit of {max_files} (at {rel})",
    ),
    ("已存在：{path}", "Already exists: {path}"),
    // 传输队列
    ("未知传输方向：{direction}", "Unknown transfer direction: {direction}"),
    ("未知冲突策略：{policy}", "Unknown conflict policy: {policy}"),
    ("传输任务不存在：{id}", "Transfer task does not exist: {id}"),
    ("传输组不存在：{id}", "Transfer group does not exist: {id}"),
    (
        "任务当前不可继续：{state}",
        "The task cannot be resumed in its current state: {state}",
    ),
    ("任务不在冲突状态", "The task is not in a conflict state"),
    ("任务状态锁失效", "Task state lock poisoned"),
    ("无法生成不冲突的远端文件名", "Cannot generate a non-conflicting remote file name"),
    ("无法生成不冲突的本地文件名", "Cannot generate a non-conflicting local file name"),
    // IPC / 标签
    ("标签已达上限 {max}，请先关闭标签", "Tab limit of {max} reached; close a tab first"),
    ("标签不存在", "Tab does not exist"),
    ("会话锁失效", "Session lock poisoned"),
    ("未知清理范围：{scope}", "Unknown cleanup scope: {scope}"),
    ("读取数据目录失败：{error}", "Failed to read the data directory: {error}"),
    ("删除 {name} 失败：{error}", "Failed to delete {name}: {error}"),
    ("删除 logs 失败：{error}", "Failed to delete logs: {error}"),
    // 已知主机
    ("读取 known_host 失败：{error}", "Failed to read known_host: {error}"),
    ("写入 known_host 失败：{error}", "Failed to write known_host: {error}"),
    (
        "首次连接未知主机 {host}:{port}（{key_type}）\nSHA256: {fp_sha256}\nMD5: {fp_md5}",
        "First connection to unknown host {host}:{port} ({key_type})\nSHA256: {fp_sha256}\nMD5: {fp_md5}",
    ),
    (
        "警告：主机 {host}:{port} 的主机密钥已变更，可能存在中间人攻击。\n已信任：{known}\n当前：{key_type} {fp_sha256}\n已阻断连接；请确认风险后手动删除该主机的信任记录再重连。",
        "Warning: the host key for {host}:{port} has changed; a man-in-the-middle attack is possible.\nTrusted: {known}\nCurrent: {key_type} {fp_sha256}\nThe connection was blocked; after confirming the risk, delete this host's trusted record and reconnect.",
    ),
    // 会话状态
    ("用户关闭", "Closed by user"),
    ("远端关闭通道", "Remote closed the channel"),
    ("SSH 通道结束", "SSH channel ended"),
    ("会话结束", "Session ended"),
    // 数据库
    ("数据库错误: {error}", "Database error: {error}"),
    ("文件错误: {error}", "File error: {error}"),
];

const ZH_TW: &[(&str, &str)] = &[
    ("显示/隐藏主窗口", "顯示/隱藏主視窗"),
    ("新建连接", "新增連線"),
    ("（暂无活动会话）", "（暫無使用中的工作階段）"),
    ("活动会话", "使用中的工作階段"),
    ("退出 Shellora", "結束 Shellora"),
    ("未连接", "未連線"),
    ("已连接 {who}", "已連線 {who}"),
    ("读取设置失败：{error}", "讀取設定失敗：{error}"),
    ("关闭窗口时最小化到托盘", "關閉視窗時最小化至系統匣"),
    // 通用模板
    ("{what}：{error}", "{what}：{error}"),
    ("；", "；"),
    ("代理响应异常：{detail}", "代理回應異常：{detail}"),
    // 代理（SOCKS5 / HTTP CONNECT）
    ("SOCKS5 握手超时", "SOCKS5 握手逾時"),
    ("HTTP CONNECT 握手超时", "HTTP CONNECT 握手逾時"),
    ("无法连接代理 {host}:{port}：{error}", "無法連線至代理 {host}:{port}：{error}"),
    ("SOCKS5 版本号不是 5", "SOCKS5 版本號不是 5"),
    ("SOCKS5 代理要求用户名/密码，但未提供", "SOCKS5 代理要求使用者名稱/密碼，但未提供"),
    ("SOCKS5 用户名/密码过长", "SOCKS5 使用者名稱/密碼過長"),
    ("SOCKS5 认证失败", "SOCKS5 認證失敗"),
    ("SOCKS5 代理拒绝所有认证方式", "SOCKS5 代理拒絕所有認證方式"),
    (
        "SOCKS5 选择了不支持的认证方式 0x{code}",
        "SOCKS5 選擇了不支援的認證方式 0x{code}",
    ),
    ("目标主机名超过 255 字节", "目標主機名稱超過 255 位元組"),
    ("代理拒绝连接 {host}:{port}", "代理拒絕連線 {host}:{port}"),
    ("代理报告目标不可达：{host}:{port}", "代理回報目標無法到達：{host}:{port}"),
    ("SOCKS5 应答失败码 0x{code}", "SOCKS5 回應失敗碼 0x{code}"),
    ("SOCKS5 应答版本号不是 5", "SOCKS5 回應版本號不是 5"),
    ("SOCKS5 应答地址类型 0x{code}", "SOCKS5 回應位址類型 0x{code}"),
    ("SOCKS5 协商写入失败", "SOCKS5 協商寫入失敗"),
    ("SOCKS5 协商读取失败", "SOCKS5 協商讀取失敗"),
    ("SOCKS5 认证写入失败", "SOCKS5 認證寫入失敗"),
    ("SOCKS5 认证读取失败", "SOCKS5 認證讀取失敗"),
    ("SOCKS5 请求写入失败", "SOCKS5 請求寫入失敗"),
    ("SOCKS5 应答读取失败", "SOCKS5 回應讀取失敗"),
    ("SOCKS5 应答地址读取失败", "SOCKS5 回應位址讀取失敗"),
    ("HTTP CONNECT 写入失败", "HTTP CONNECT 寫入失敗"),
    ("HTTP CONNECT 读取失败", "HTTP CONNECT 讀取失敗"),
    ("HTTP CONNECT 响应头过大", "HTTP CONNECT 回應標頭過大"),
    ("HTTP CONNECT 响应未结束", "HTTP CONNECT 回應未結束"),
    ("HTTP CONNECT 状态行缺失", "HTTP CONNECT 狀態列缺失"),
    ("HTTP 代理认证失败（407）", "HTTP 代理認證失敗（407）"),
    ("HTTP 代理拒绝 CONNECT（{status}）", "HTTP 代理拒絕 CONNECT（{status}）"),
    // 私钥 / PPK
    ("无法读取私钥 {path}：{error}", "無法讀取私鑰 {path}：{error}"),
    ("私钥已加密：请提供口令（passphrase）", "私鑰已加密：請提供通行碼（passphrase）"),
    ("私钥解析失败：{error}", "私鑰解析失敗：{error}"),
    ("PPK 文件头缺失", "PPK 檔案標頭缺失"),
    (
        "暂不支持加密的 PPK 私钥：请用 PuTTYgen 去掉口令，或导出为 OpenSSH 格式",
        "暫不支援加密的 PPK 私鑰：請用 PuTTYgen 移除通行碼，或匯出為 OpenSSH 格式",
    ),
    ("PPK 公钥缺少算法名", "PPK 公鑰缺少演算法名稱"),
    ("PPK 公钥缺少 {field}", "PPK 公鑰缺少 {field}"),
    ("PPK 私钥缺少 {field}", "PPK 私鑰缺少 {field}"),
    ("PPK 公钥缺少公钥值", "PPK 公鑰缺少公鑰值"),
    ("PPK 私钥缺少密钥值", "PPK 私鑰缺少金鑰值"),
    ("PPK 公钥缺少曲线名", "PPK 公鑰缺少曲線名稱"),
    ("PPK 公钥缺少曲线点", "PPK 公鑰缺少曲線點"),
    (
        "Ed25519 PPK 私钥长度异常（{size} 字节，应为 64）",
        "Ed25519 PPK 私鑰長度異常（{size} 位元組，應為 64）",
    ),
    ("PPK 算法不受支持：{algorithm}", "不支援的 PPK 演算法：{algorithm}"),
    ("PPK 私钥校验失败：{error}", "PPK 私鑰驗證失敗：{error}"),
    ("PPK 缺少 {name} 段", "PPK 缺少 {name} 區段"),
    ("PPK {name} 行格式错误", "PPK {name} 行格式錯誤"),
    ("PPK {name} 数据不完整", "PPK {name} 資料不完整"),
    ("PPK {name} base64 解码失败：{error}", "PPK {name} base64 解碼失敗：{error}"),
    // SSH 连接与认证
    (
        "未提供认证方式：请填写密码、私钥或启用 ssh-agent",
        "未提供認證方式：請填寫密碼、私鑰或啟用 ssh-agent",
    ),
    ("与 {host} 的 SSH 握手超时", "與 {host} 的 SSH 握手逾時"),
    (
        "与 {host} 握手结束但未获得服务端主机密钥",
        "與 {host} 握手結束但未取得伺服器主機金鑰",
    ),
    ("认证失败：{username}@{host} 密码不正确", "認證失敗：{username}@{host} 密碼不正確"),
    ("私钥不可用于认证：{error}", "私鑰無法用於認證：{error}"),
    ("认证失败：{username}@{host} 未接受该私钥", "認證失敗：{username}@{host} 未接受該私鑰"),
    (
        "{host} 拒绝连接（端口未开放或被防火墙拦截）",
        "{host} 拒絕連線（連接埠未開放或被防火牆阻擋）",
    ),
    ("连接 {host} 超时", "連線 {host} 逾時"),
    ("无法解析主机 {host}", "無法解析主機 {host}"),
    ("SSH 连接失败：{error}", "SSH 連線失敗：{error}"),
    // ssh-agent
    ("ssh-agent 响应超时", "ssh-agent 回應逾時"),
    ("ssh-agent 读取 identities 失败：{error}", "ssh-agent 讀取 identities 失敗：{error}"),
    ("ssh-agent 认证失败：{error}", "ssh-agent 認證失敗：{error}"),
    ("认证失败：ssh-agent 密钥被服务器拒绝", "認證失敗：ssh-agent 金鑰被伺服器拒絕"),
    ("ssh-agent 中没有可用的 identity", "ssh-agent 中沒有可用的 identity"),
    ("ssh-agent 中找不到匹配的 identity：{hint}", "ssh-agent 中找不到符合的 identity：{hint}"),
    ("无法连接 ssh-agent {addr}：{error}", "無法連線 ssh-agent {addr}：{error}"),
    ("未找到 ssh-agent：SSH_AUTH_SOCK 未设置", "找不到 ssh-agent：SSH_AUTH_SOCK 未設定"),
    ("无法连接 ssh-agent：{error}", "無法連線 ssh-agent：{error}"),
    // SFTP / 传输
    ("远端路径不是普通文件：{path}", "遠端路徑不是一般檔案：{path}"),
    ("本地路径不是普通文件：{path}", "本機路徑不是一般檔案：{path}"),
    ("传输任务异常：{error}", "傳輸工作異常：{error}"),
    ("远端文件提前结束：已读 {off}+{done} 字节", "遠端檔案提前結束：已讀 {off}+{done} 位元組"),
    ("本地文件提前结束：已读 {off}+{done} 字节", "本機檔案提前結束：已讀 {off}+{done} 位元組"),
    ("SSH 会话尚未就绪，无法开始传输", "SSH 工作階段尚未就緒，無法開始傳輸"),
    ("打开通道失败：{error}", "開啟通道失敗：{error}"),
    ("请求 sftp 子系统失败：{error}", "請求 sftp 子系統失敗：{error}"),
    ("SFTP 请求超时", "SFTP 請求逾時"),
    ("目标已存在：{path}", "目標已存在：{path}"),
    ("传输被中断，可从断点继续", "傳輸已中斷，可從中斷點繼續"),
    ("目录层级超过上限 {max_depth}（在 {rel}）", "目錄層級超過上限 {max_depth}（在 {rel}）"),
    ("文件数超过上限 {max_files}（在 {rel}）", "檔案數超過上限 {max_files}（在 {rel}）"),
    ("已存在：{path}", "已存在：{path}"),
    // 传输队列
    ("未知传输方向：{direction}", "未知傳輸方向：{direction}"),
    ("未知冲突策略：{policy}", "未知衝突策略：{policy}"),
    ("传输任务不存在：{id}", "傳輸工作不存在：{id}"),
    ("传输组不存在：{id}", "傳輸群組不存在：{id}"),
    ("任务当前不可继续：{state}", "工作目前無法繼續：{state}"),
    ("任务不在冲突状态", "工作不在衝突狀態"),
    ("任务状态锁失效", "工作狀態鎖失效"),
    ("无法生成不冲突的远端文件名", "無法產生不衝突的遠端檔案名稱"),
    ("无法生成不冲突的本地文件名", "無法產生不衝突的本機檔案名稱"),
    // IPC / 标签
    ("标签已达上限 {max}，请先关闭标签", "標籤已達上限 {max}，請先關閉標籤"),
    ("标签不存在", "標籤不存在"),
    ("会话锁失效", "工作階段鎖失效"),
    ("未知清理范围：{scope}", "未知清理範圍：{scope}"),
    ("读取数据目录失败：{error}", "讀取資料目錄失敗：{error}"),
    ("删除 {name} 失败：{error}", "刪除 {name} 失敗：{error}"),
    ("删除 logs 失败：{error}", "刪除 logs 失敗：{error}"),
    // 已知主机
    ("读取 known_host 失败：{error}", "讀取 known_host 失敗：{error}"),
    ("写入 known_host 失败：{error}", "寫入 known_host 失敗：{error}"),
    (
        "首次连接未知主机 {host}:{port}（{key_type}）\nSHA256: {fp_sha256}\nMD5: {fp_md5}",
        "首次連線未知主機 {host}:{port}（{key_type}）\nSHA256: {fp_sha256}\nMD5: {fp_md5}",
    ),
    (
        "警告：主机 {host}:{port} 的主机密钥已变更，可能存在中间人攻击。\n已信任：{known}\n当前：{key_type} {fp_sha256}\n已阻断连接；请确认风险后手动删除该主机的信任记录再重连。",
        "警告：主機 {host}:{port} 的主機金鑰已變更，可能存在中間人攻擊。\n已信任：{known}\n目前：{key_type} {fp_sha256}\n已阻斷連線；請確認風險後手動刪除該主機的信任記錄再重新連線。",
    ),
    // 会话状态
    ("用户关闭", "使用者關閉"),
    ("远端关闭通道", "遠端關閉通道"),
    ("SSH 通道结束", "SSH 通道結束"),
    ("会话结束", "工作階段結束"),
    // 数据库
    ("数据库错误: {error}", "資料庫錯誤: {error}"),
    ("文件错误: {error}", "檔案錯誤: {error}"),
];

const JA: &[(&str, &str)] = &[
    ("显示/隐藏主窗口", "メインウィンドウの表示/非表示"),
    ("新建连接", "新規接続"),
    ("（暂无活动会话）", "（アクティブなセッションはありません）"),
    ("活动会话", "アクティブなセッション"),
    ("退出 Shellora", "Shellora を終了"),
    ("未连接", "未接続"),
    ("已连接 {who}", "{who} に接続済み"),
    ("读取设置失败：{error}", "設定の読み込みに失敗しました：{error}"),
    ("关闭窗口时最小化到托盘", "閉じるときにトレイへ最小化"),
    // 通用模板
    ("{what}：{error}", "{what}：{error}"),
    ("；", "；"),
    ("代理响应异常：{detail}", "プロキシの応答が異常です：{detail}"),
    // 代理（SOCKS5 / HTTP CONNECT）
    ("SOCKS5 握手超时", "SOCKS5 のハンドシェイクがタイムアウトしました"),
    ("HTTP CONNECT 握手超时", "HTTP CONNECT のハンドシェイクがタイムアウトしました"),
    ("无法连接代理 {host}:{port}：{error}", "プロキシ {host}:{port} に接続できません：{error}"),
    ("SOCKS5 版本号不是 5", "SOCKS5 のバージョンが 5 ではありません"),
    (
        "SOCKS5 代理要求用户名/密码，但未提供",
        "SOCKS5 プロキシはユーザー名/パスワードを要求していますが、指定されていません",
    ),
    ("SOCKS5 用户名/密码过长", "SOCKS5 のユーザー名/パスワードが長すぎます"),
    ("SOCKS5 认证失败", "SOCKS5 の認証に失敗しました"),
    ("SOCKS5 代理拒绝所有认证方式", "SOCKS5 プロキシがすべての認証方式を拒否しました"),
    (
        "SOCKS5 选择了不支持的认证方式 0x{code}",
        "SOCKS5 が未対応の認証方式 0x{code} を選択しました",
    ),
    ("目标主机名超过 255 字节", "対象ホスト名が 255 バイトを超えています"),
    ("代理拒绝连接 {host}:{port}", "プロキシが接続を拒否しました {host}:{port}"),
    (
        "代理报告目标不可达：{host}:{port}",
        "プロキシが対象に到達できないと報告しました：{host}:{port}",
    ),
    ("SOCKS5 应答失败码 0x{code}", "SOCKS5 の応答失敗コード 0x{code}"),
    ("SOCKS5 应答版本号不是 5", "SOCKS5 の応答バージョンが 5 ではありません"),
    ("SOCKS5 应答地址类型 0x{code}", "SOCKS5 の応答アドレス種別 0x{code}"),
    ("SOCKS5 协商写入失败", "SOCKS5 のネゴシエーション書き込みに失敗しました"),
    ("SOCKS5 协商读取失败", "SOCKS5 のネゴシエーション読み取りに失敗しました"),
    ("SOCKS5 认证写入失败", "SOCKS5 の認証書き込みに失敗しました"),
    ("SOCKS5 认证读取失败", "SOCKS5 の認証読み取りに失敗しました"),
    ("SOCKS5 请求写入失败", "SOCKS5 のリクエスト書き込みに失敗しました"),
    ("SOCKS5 应答读取失败", "SOCKS5 の応答読み取りに失敗しました"),
    ("SOCKS5 应答地址读取失败", "SOCKS5 の応答アドレス読み取りに失敗しました"),
    ("HTTP CONNECT 写入失败", "HTTP CONNECT の書き込みに失敗しました"),
    ("HTTP CONNECT 读取失败", "HTTP CONNECT の読み取りに失敗しました"),
    ("HTTP CONNECT 响应头过大", "HTTP CONNECT の応答ヘッダーが大きすぎます"),
    ("HTTP CONNECT 响应未结束", "HTTP CONNECT の応答が終了していません"),
    ("HTTP CONNECT 状态行缺失", "HTTP CONNECT のステータス行がありません"),
    ("HTTP 代理认证失败（407）", "HTTP プロキシの認証に失敗しました（407）"),
    ("HTTP 代理拒绝 CONNECT（{status}）", "HTTP プロキシが CONNECT を拒否しました（{status}）"),
    // 私钥 / PPK
    ("无法读取私钥 {path}：{error}", "秘密鍵 {path} を読み取れません：{error}"),
    ("私钥已加密：请提供口令（passphrase）", "秘密鍵が暗号化されています：パスフレーズを入力してください"),
    ("私钥解析失败：{error}", "秘密鍵の解析に失敗しました：{error}"),
    ("PPK 文件头缺失", "PPK ファイルのヘッダーがありません"),
    (
        "暂不支持加密的 PPK 私钥：请用 PuTTYgen 去掉口令，或导出为 OpenSSH 格式",
        "暗号化された PPK 秘密鍵には未対応です：PuTTYgen でパスフレーズを解除するか、OpenSSH 形式でエクスポートしてください",
    ),
    ("PPK 公钥缺少算法名", "PPK 公開鍵にアルゴリズム名がありません"),
    ("PPK 公钥缺少 {field}", "PPK 公開鍵に {field} がありません"),
    ("PPK 私钥缺少 {field}", "PPK 秘密鍵に {field} がありません"),
    ("PPK 公钥缺少公钥值", "PPK 公開鍵に公開鍵値がありません"),
    ("PPK 私钥缺少密钥值", "PPK 秘密鍵に鍵の値がありません"),
    ("PPK 公钥缺少曲线名", "PPK 公開鍵に曲線名がありません"),
    ("PPK 公钥缺少曲线点", "PPK 公開鍵に曲線点がありません"),
    (
        "Ed25519 PPK 私钥长度异常（{size} 字节，应为 64）",
        "Ed25519 PPK 秘密鍵の長さが異常です（{size} バイト、64 であるべき）",
    ),
    ("PPK 算法不受支持：{algorithm}", "未対応の PPK アルゴリズムです：{algorithm}"),
    ("PPK 私钥校验失败：{error}", "PPK 秘密鍵の検証に失敗しました：{error}"),
    ("PPK 缺少 {name} 段", "PPK に {name} セクションがありません"),
    ("PPK {name} 行格式错误", "PPK {name} 行の形式が正しくありません"),
    ("PPK {name} 数据不完整", "PPK {name} のデータが不完全です"),
    ("PPK {name} base64 解码失败：{error}", "PPK {name} の base64 デコードに失敗しました：{error}"),
    // SSH 连接与认证
    (
        "未提供认证方式：请填写密码、私钥或启用 ssh-agent",
        "認証方式が指定されていません：パスワード、秘密鍵、または ssh-agent を有効にしてください",
    ),
    ("与 {host} 的 SSH 握手超时", "{host} との SSH ハンドシェイクがタイムアウトしました"),
    (
        "与 {host} 握手结束但未获得服务端主机密钥",
        "{host} とのハンドシェイクは終了しましたが、サーバーのホスト鍵を取得できませんでした",
    ),
    (
        "认证失败：{username}@{host} 密码不正确",
        "認証に失敗しました：{username}@{host} のパスワードが正しくありません",
    ),
    ("私钥不可用于认证：{error}", "秘密鍵を認証に使用できません：{error}"),
    (
        "认证失败：{username}@{host} 未接受该私钥",
        "認証に失敗しました：{username}@{host} がこの秘密鍵を受け入れませんでした",
    ),
    (
        "{host} 拒绝连接（端口未开放或被防火墙拦截）",
        "{host} が接続を拒否しました（ポートが閉じているかファイアウォールで遮断されています）",
    ),
    ("连接 {host} 超时", "{host} への接続がタイムアウトしました"),
    ("无法解析主机 {host}", "ホスト {host} を解決できません"),
    ("SSH 连接失败：{error}", "SSH 接続に失敗しました：{error}"),
    // ssh-agent
    ("ssh-agent 响应超时", "ssh-agent がタイムアウトしました"),
    ("ssh-agent 读取 identities 失败：{error}", "ssh-agent から identities を読み取れません：{error}"),
    ("ssh-agent 认证失败：{error}", "ssh-agent の認証に失敗しました：{error}"),
    ("认证失败：ssh-agent 密钥被服务器拒绝", "認証に失敗しました：ssh-agent の鍵がサーバーに拒否されました"),
    ("ssh-agent 中没有可用的 identity", "ssh-agent に利用可能な identity がありません"),
    (
        "ssh-agent 中找不到匹配的 identity：{hint}",
        "ssh-agent に一致する identity が見つかりません：{hint}",
    ),
    ("无法连接 ssh-agent {addr}：{error}", "ssh-agent {addr} に接続できません：{error}"),
    ("未找到 ssh-agent：SSH_AUTH_SOCK 未设置", "ssh-agent が見つかりません：SSH_AUTH_SOCK が設定されていません"),
    ("无法连接 ssh-agent：{error}", "ssh-agent に接続できません：{error}"),
    // SFTP / 传输
    ("远端路径不是普通文件：{path}", "リモートパスが通常のファイルではありません：{path}"),
    ("本地路径不是普通文件：{path}", "ローカルパスが通常のファイルではありません：{path}"),
    ("传输任务异常：{error}", "転送タスクで異常が発生しました：{error}"),
    (
        "远端文件提前结束：已读 {off}+{done} 字节",
        "リモートファイルが途中で終了しました：{off}+{done} バイト読み取り済み",
    ),
    (
        "本地文件提前结束：已读 {off}+{done} 字节",
        "ローカルファイルが途中で終了しました：{off}+{done} バイト読み取り済み",
    ),
    (
        "SSH 会话尚未就绪，无法开始传输",
        "SSH セッションの準備ができていないため、転送を開始できません",
    ),
    ("打开通道失败：{error}", "チャネルを開けませんでした：{error}"),
    ("请求 sftp 子系统失败：{error}", "sftp サブシステムの要求に失敗しました：{error}"),
    ("SFTP 请求超时", "SFTP リクエストがタイムアウトしました"),
    ("目标已存在：{path}", "対象は既に存在します：{path}"),
    ("传输被中断，可从断点继续", "転送が中断されました。チェックポイントから再開できます"),
    (
        "目录层级超过上限 {max_depth}（在 {rel}）",
        "ディレクトリの階層が上限 {max_depth} を超えました（{rel}）",
    ),
    (
        "文件数超过上限 {max_files}（在 {rel}）",
        "ファイル数が上限 {max_files} を超えました（{rel}）",
    ),
    ("已存在：{path}", "既に存在します：{path}"),
    // 传输队列
    ("未知传输方向：{direction}", "不明な転送方向です：{direction}"),
    ("未知冲突策略：{policy}", "不明な競合ポリシーです：{policy}"),
    ("传输任务不存在：{id}", "転送タスクが存在しません：{id}"),
    ("传输组不存在：{id}", "転送グループが存在しません：{id}"),
    ("任务当前不可继续：{state}", "現在の状態ではタスクを再開できません：{state}"),
    ("任务不在冲突状态", "タスクが競合状態ではありません"),
    ("任务状态锁失效", "タスク状態のロックが破損しています"),
    ("无法生成不冲突的远端文件名", "競合しないリモートファイル名を生成できません"),
    ("无法生成不冲突的本地文件名", "競合しないローカルファイル名を生成できません"),
    // IPC / 标签
    ("标签已达上限 {max}，请先关闭标签", "タブの上限 {max} に達しました。先にタブを閉じてください"),
    ("标签不存在", "タブが存在しません"),
    ("会话锁失效", "セッションロックが破損しています"),
    ("未知清理范围：{scope}", "不明なクリーンアップ範囲です：{scope}"),
    ("读取数据目录失败：{error}", "データディレクトリの読み取りに失敗しました：{error}"),
    ("删除 {name} 失败：{error}", "{name} の削除に失敗しました：{error}"),
    ("删除 logs 失败：{error}", "logs の削除に失敗しました：{error}"),
    // 已知主机
    ("读取 known_host 失败：{error}", "known_host の読み取りに失敗しました：{error}"),
    ("写入 known_host 失败：{error}", "known_host の書き込みに失敗しました：{error}"),
    (
        "首次连接未知主机 {host}:{port}（{key_type}）\nSHA256: {fp_sha256}\nMD5: {fp_md5}",
        "未知のホスト {host}:{port} に初回接続します（{key_type}）\nSHA256: {fp_sha256}\nMD5: {fp_md5}",
    ),
    (
        "警告：主机 {host}:{port} 的主机密钥已变更，可能存在中间人攻击。\n已信任：{known}\n当前：{key_type} {fp_sha256}\n已阻断连接；请确认风险后手动删除该主机的信任记录再重连。",
        "警告：ホスト {host}:{port} のホスト鍵が変更されました。中間者攻撃の可能性があります。\n信頼済み：{known}\n現在：{key_type} {fp_sha256}\n接続をブロックしました。リスクを確認したうえで、このホストの信頼記録を手動で削除して再接続してください。",
    ),
    // 会话状态
    ("用户关闭", "ユーザーによる切断"),
    ("远端关闭通道", "リモートがチャネルを閉じました"),
    ("SSH 通道结束", "SSH チャネルが終了しました"),
    ("会话结束", "セッションが終了しました"),
    // 数据库
    ("数据库错误: {error}", "データベースエラー: {error}"),
    ("文件错误: {error}", "ファイルエラー: {error}"),
];

const ES: &[(&str, &str)] = &[
    ("显示/隐藏主窗口", "Mostrar/ocultar ventana principal"),
    ("新建连接", "Nueva conexión"),
    ("（暂无活动会话）", "(No hay sesiones activas)"),
    ("活动会话", "Sesiones activas"),
    ("退出 Shellora", "Salir de Shellora"),
    ("未连接", "Sin conexión"),
    ("已连接 {who}", "Conectado a {who}"),
    ("读取设置失败：{error}", "No se pudo leer la configuración: {error}"),
    ("关闭窗口时最小化到托盘", "Minimizar a la bandeja al cerrar"),
    // 通用模板
    ("{what}：{error}", "{what}: {error}"),
    ("；", "; "),
    ("代理响应异常：{detail}", "Respuesta inesperada del proxy: {detail}"),
    // 代理（SOCKS5 / HTTP CONNECT）
    ("SOCKS5 握手超时", "Se agotó el tiempo de espera del protocolo de enlace SOCKS5"),
    ("HTTP CONNECT 握手超时", "Se agotó el tiempo de espera del protocolo de enlace HTTP CONNECT"),
    ("无法连接代理 {host}:{port}：{error}", "No se puede conectar al proxy {host}:{port}: {error}"),
    ("SOCKS5 版本号不是 5", "La versión de SOCKS5 no es 5"),
    (
        "SOCKS5 代理要求用户名/密码，但未提供",
        "El proxy SOCKS5 requiere usuario/contraseña, pero no se proporcionaron",
    ),
    ("SOCKS5 用户名/密码过长", "El usuario/contraseña de SOCKS5 es demasiado largo"),
    ("SOCKS5 认证失败", "Error de autenticación de SOCKS5"),
    ("SOCKS5 代理拒绝所有认证方式", "El proxy SOCKS5 rechazó todos los métodos de autenticación"),
    (
        "SOCKS5 选择了不支持的认证方式 0x{code}",
        "SOCKS5 seleccionó un método de autenticación no compatible 0x{code}",
    ),
    ("目标主机名超过 255 字节", "El nombre del host de destino supera los 255 bytes"),
    ("代理拒绝连接 {host}:{port}", "El proxy rechazó la conexión a {host}:{port}"),
    (
        "代理报告目标不可达：{host}:{port}",
        "El proxy informó que el destino no es accesible: {host}:{port}",
    ),
    ("SOCKS5 应答失败码 0x{code}", "Código de fallo de respuesta SOCKS5 0x{code}"),
    ("SOCKS5 应答版本号不是 5", "La versión de respuesta de SOCKS5 no es 5"),
    ("SOCKS5 应答地址类型 0x{code}", "Tipo de dirección de respuesta SOCKS5 0x{code}"),
    ("SOCKS5 协商写入失败", "No se pudo escribir la negociación de SOCKS5"),
    ("SOCKS5 协商读取失败", "No se pudo leer la negociación de SOCKS5"),
    ("SOCKS5 认证写入失败", "No se pudo escribir la autenticación de SOCKS5"),
    ("SOCKS5 认证读取失败", "No se pudo leer la autenticación de SOCKS5"),
    ("SOCKS5 请求写入失败", "No se pudo escribir la solicitud SOCKS5"),
    ("SOCKS5 应答读取失败", "No se pudo leer la respuesta de SOCKS5"),
    ("SOCKS5 应答地址读取失败", "No se pudo leer la dirección de respuesta de SOCKS5"),
    ("HTTP CONNECT 写入失败", "No se pudo escribir la solicitud HTTP CONNECT"),
    ("HTTP CONNECT 读取失败", "No se pudo leer la respuesta HTTP CONNECT"),
    ("HTTP CONNECT 响应头过大", "La cabecera de respuesta HTTP CONNECT es demasiado grande"),
    ("HTTP CONNECT 响应未结束", "La respuesta HTTP CONNECT no terminó"),
    ("HTTP CONNECT 状态行缺失", "Falta la línea de estado de HTTP CONNECT"),
    ("HTTP 代理认证失败（407）", "Error de autenticación del proxy HTTP (407)"),
    ("HTTP 代理拒绝 CONNECT（{status}）", "El proxy HTTP rechazó CONNECT ({status})"),
    // 私钥 / PPK
    ("无法读取私钥 {path}：{error}", "No se puede leer la clave privada {path}: {error}"),
    ("私钥已加密：请提供口令（passphrase）", "La clave privada está cifrada: introduce la frase de contraseña"),
    ("私钥解析失败：{error}", "No se pudo analizar la clave privada: {error}"),
    ("PPK 文件头缺失", "Falta la cabecera del archivo PPK"),
    (
        "暂不支持加密的 PPK 私钥：请用 PuTTYgen 去掉口令，或导出为 OpenSSH 格式",
        "Aún no se admiten claves privadas PPK cifradas: elimina la frase de contraseña con PuTTYgen o exporta a formato OpenSSH",
    ),
    ("PPK 公钥缺少算法名", "La clave pública PPK no tiene el nombre del algoritmo"),
    ("PPK 公钥缺少 {field}", "A la clave pública PPK le falta {field}"),
    ("PPK 私钥缺少 {field}", "A la clave privada PPK le falta {field}"),
    ("PPK 公钥缺少公钥值", "La clave pública PPK no tiene el valor de la clave pública"),
    ("PPK 私钥缺少密钥值", "La clave privada PPK no tiene el valor de la clave"),
    ("PPK 公钥缺少曲线名", "La clave pública PPK no tiene el nombre de la curva"),
    ("PPK 公钥缺少曲线点", "La clave pública PPK no tiene el punto de la curva"),
    (
        "Ed25519 PPK 私钥长度异常（{size} 字节，应为 64）",
        "Longitud anómala de la clave privada PPK Ed25519 ({size} bytes, se esperaban 64)",
    ),
    ("PPK 算法不受支持：{algorithm}", "Algoritmo PPK no compatible: {algorithm}"),
    ("PPK 私钥校验失败：{error}", "Error de validación de la clave privada PPK: {error}"),
    ("PPK 缺少 {name} 段", "Al PPK le falta la sección {name}"),
    ("PPK {name} 行格式错误", "El formato de la línea {name} del PPK es incorrecto"),
    ("PPK {name} 数据不完整", "Los datos de {name} del PPK están incompletos"),
    ("PPK {name} base64 解码失败：{error}", "Error al decodificar base64 de {name} del PPK: {error}"),
    // SSH 连接与认证
    (
        "未提供认证方式：请填写密码、私钥或启用 ssh-agent",
        "No se proporcionó ningún método de autenticación: introduce una contraseña, una clave privada o activa ssh-agent",
    ),
    ("与 {host} 的 SSH 握手超时", "Se agotó el tiempo de espera del protocolo de enlace SSH con {host}"),
    (
        "与 {host} 握手结束但未获得服务端主机密钥",
        "El protocolo de enlace con {host} terminó pero no se obtuvo la clave del host del servidor",
    ),
    (
        "认证失败：{username}@{host} 密码不正确",
        "Error de autenticación: contraseña incorrecta para {username}@{host}",
    ),
    ("私钥不可用于认证：{error}", "La clave privada no se puede usar para autenticación: {error}"),
    (
        "认证失败：{username}@{host} 未接受该私钥",
        "Error de autenticación: {username}@{host} no aceptó esta clave privada",
    ),
    (
        "{host} 拒绝连接（端口未开放或被防火墙拦截）",
        "{host} rechazó la conexión (puerto cerrado o bloqueado por el cortafuegos)",
    ),
    ("连接 {host} 超时", "Se agotó el tiempo de espera de la conexión a {host}"),
    ("无法解析主机 {host}", "No se puede resolver el host {host}"),
    ("SSH 连接失败：{error}", "Error de conexión SSH: {error}"),
    // ssh-agent
    ("ssh-agent 响应超时", "Se agotó el tiempo de espera de ssh-agent"),
    ("ssh-agent 读取 identities 失败：{error}", "No se pudieron leer las identidades de ssh-agent: {error}"),
    ("ssh-agent 认证失败：{error}", "Error de autenticación con ssh-agent: {error}"),
    (
        "认证失败：ssh-agent 密钥被服务器拒绝",
        "Error de autenticación: el servidor rechazó la clave de ssh-agent",
    ),
    ("ssh-agent 中没有可用的 identity", "ssh-agent no tiene ninguna identidad disponible"),
    (
        "ssh-agent 中找不到匹配的 identity：{hint}",
        "No se encontró una identidad coincidente en ssh-agent: {hint}",
    ),
    ("无法连接 ssh-agent {addr}：{error}", "No se puede conectar a ssh-agent {addr}: {error}"),
    ("未找到 ssh-agent：SSH_AUTH_SOCK 未设置", "No se encontró ssh-agent: SSH_AUTH_SOCK no está definido"),
    ("无法连接 ssh-agent：{error}", "No se puede conectar a ssh-agent: {error}"),
    // SFTP / 传输
    ("远端路径不是普通文件：{path}", "La ruta remota no es un archivo normal: {path}"),
    ("本地路径不是普通文件：{path}", "La ruta local no es un archivo normal: {path}"),
    ("传输任务异常：{error}", "Error en la tarea de transferencia: {error}"),
    (
        "远端文件提前结束：已读 {off}+{done} 字节",
        "El archivo remoto terminó antes de tiempo: leídos {off}+{done} bytes",
    ),
    (
        "本地文件提前结束：已读 {off}+{done} 字节",
        "El archivo local terminó antes de tiempo: leídos {off}+{done} bytes",
    ),
    (
        "SSH 会话尚未就绪，无法开始传输",
        "La sesión SSH aún no está lista; no se puede iniciar la transferencia",
    ),
    ("打开通道失败：{error}", "No se pudo abrir el canal: {error}"),
    ("请求 sftp 子系统失败：{error}", "No se pudo solicitar el subsistema sftp: {error}"),
    ("SFTP 请求超时", "Se agotó el tiempo de espera de la solicitud SFTP"),
    ("目标已存在：{path}", "El destino ya existe: {path}"),
    ("传输被中断，可从断点继续", "Transferencia interrumpida; se puede reanudar desde el punto de control"),
    (
        "目录层级超过上限 {max_depth}（在 {rel}）",
        "La profundidad de directorios supera el límite de {max_depth} (en {rel})",
    ),
    (
        "文件数超过上限 {max_files}（在 {rel}）",
        "El número de archivos supera el límite de {max_files} (en {rel})",
    ),
    ("已存在：{path}", "Ya existe: {path}"),
    // 传输队列
    ("未知传输方向：{direction}", "Dirección de transferencia desconocida: {direction}"),
    ("未知冲突策略：{policy}", "Política de conflictos desconocida: {policy}"),
    ("传输任务不存在：{id}", "La tarea de transferencia no existe: {id}"),
    ("传输组不存在：{id}", "El grupo de transferencia no existe: {id}"),
    ("任务当前不可继续：{state}", "La tarea no se puede reanudar en su estado actual: {state}"),
    ("任务不在冲突状态", "La tarea no está en estado de conflicto"),
    ("任务状态锁失效", "El bloqueo del estado de la tarea está dañado"),
    ("无法生成不冲突的远端文件名", "No se puede generar un nombre de archivo remoto sin conflictos"),
    ("无法生成不冲突的本地文件名", "No se puede generar un nombre de archivo local sin conflictos"),
    // IPC / 标签
    ("标签已达上限 {max}，请先关闭标签", "Se alcanzó el límite de {max} pestañas; cierra una pestaña primero"),
    ("标签不存在", "La pestaña no existe"),
    ("会话锁失效", "El bloqueo de la sesión está dañado"),
    ("未知清理范围：{scope}", "Ámbito de limpieza desconocido: {scope}"),
    ("读取数据目录失败：{error}", "No se pudo leer el directorio de datos: {error}"),
    ("删除 {name} 失败：{error}", "No se pudo eliminar {name}: {error}"),
    ("删除 logs 失败：{error}", "No se pudo eliminar logs: {error}"),
    // 已知主机
    ("读取 known_host 失败：{error}", "No se pudo leer known_host: {error}"),
    ("写入 known_host 失败：{error}", "No se pudo escribir known_host: {error}"),
    (
        "首次连接未知主机 {host}:{port}（{key_type}）\nSHA256: {fp_sha256}\nMD5: {fp_md5}",
        "Primera conexión al host desconocido {host}:{port} ({key_type})\nSHA256: {fp_sha256}\nMD5: {fp_md5}",
    ),
    (
        "警告：主机 {host}:{port} 的主机密钥已变更，可能存在中间人攻击。\n已信任：{known}\n当前：{key_type} {fp_sha256}\n已阻断连接；请确认风险后手动删除该主机的信任记录再重连。",
        "Advertencia: la clave del host {host}:{port} ha cambiado; es posible un ataque de intermediario.\nDe confianza: {known}\nActual: {key_type} {fp_sha256}\nSe bloqueó la conexión; tras confirmar el riesgo, elimina manualmente el registro de confianza de este host y vuelve a conectar.",
    ),
    // 会话状态
    ("用户关闭", "Cerrado por el usuario"),
    ("远端关闭通道", "El remoto cerró el canal"),
    ("SSH 通道结束", "El canal SSH terminó"),
    ("会话结束", "La sesión terminó"),
    // 数据库
    ("数据库错误: {error}", "Error de base de datos: {error}"),
    ("文件错误: {error}", "Error de archivo: {error}"),
];
