# 跨平台 SSH 终端 + SFTP 双栏管理器 · 技术架构与里程碑

| 项 | 内容 |
|---|---|
| 文档版本 | v1.1（附录 C 五项已定稿） |
| 日期 | 2026-11-04 |
| 状态 | 已定稿：M0 可开工；D1–D5 见附录 C |
| 目标平台 | Windows 10/11 (x64, arm64)、macOS 12+ (arm64, x64)、Linux (x64, glibc ≥ 2.31) |
| 交付形态 | 单一代码库，三平台桌面安装包；无服务端组件 |
| 参考产品 | Xshell（终端体验）、WinSCP（双栏文件管理） |

本文档只写可执行细节与可判定标准。所有"验收标准"均以**可运行的命令、可观察的屏幕内容或可度量的数值**表述；不可判定项一律改写或删除。

---

## 0. 技术基线确认与替代方案评估

基线不自推翻，逐项标注版本约束与"如果它出问题，退路是什么"。

| 层 | 选定 | 版本约束 | 备选 | 选它的理由 | 退路与代价 |
|---|---|---|---|---|---|
| 宿主壳 | Tauri 2 | 2.1+ | Electron 33 | 安装包 ~8–12MB、常驻内存 60–110MB（Electron 同场景 200MB+）；Rust 侧可直接持有 TCP 连接 | WebView 一致性风险高（见 R-03）。退路：仅把 `src/` 前端搬到 Electron，Rust 侧改为 sidecar 可执行文件，IPC 换 JSON-RPC over stdio，预估 +15 人日 |
| SSH | `russh` | 0.5x（锁 minor） | `ssh2`(libssh2 绑定)、`thrussh` | 纯 Rust async、无 libssh 系统依赖、`direct-tcpip` 与 agent 转发可直接用 | 老服务器算法协商失败时，为单个连接启用 `ssh2` 兼容后端（需抽象 `SshBackend` trait，代价 +6 人日，见 R-06） |
| SFTP | `russh-sftp` | 2.x | 自研 v3 客户端 | 与 russh channel 直接互操作，支持 `limits@openssh.com` 扩展协商 | 自研约 +10 人日，仅在 russh-sftp 阻塞主流程时启动 |
| 本地 PTY | `portable-pty` | 0.8+ | `wezterm-pty` 直用 | 三平台一致，Windows 走 ConPTY | 直接调 ConPTY/openpty 系统 API，+4 人日 |
| 终端前端 | xterm.js + WebGL | 5.5+ | `@xterm/headless` 自绘 | 生态最全，addon 覆盖 fit/web-links/search/unicode11/clipboard | 无（自研仿真器属不可接受成本） |
| 会话存储 | `rusqlite`（bundled） | 0.32+ | `sqlx`+SQLite | 同步 API 简单、无编译期 DB 依赖、事务可控 | 迁移到 sqlx 约 +3 人日 |
| 凭据 | 系统钥匙串（`keyring` 3.x） | — | 自建加密文件 | 不落自有密文，符合"凭据不出现在应用数据目录" | Linux 无 secret-service 时降级为"每次输入"，见 R-04 |
| 密钥 | `ssh-key` + 自研 PPK 解码 | — | `russh-keys` 独占 | `ssh-key` 覆盖 OpenSSH/PKCS#8；PPK v2/v3 自行解码（格式稳定、约 300 行） | 无 |

**已定决策（ADR 摘要）**

- ADR-01：单个 Tauri 进程 + 单个 tokio multi-thread runtime；不为每个会话开子进程。理由：会话数上限 32 时进程模型反而更省内存，且凭据不必跨进程传递。
- ADR-02：终端字节流不走全局事件总线，走**每标签页一个 `tauri::ipc::Channel`**（详见 3.3）。理由：全局事件会对所有窗口广播并重复序列化，10MB/s 输出时抖动不可接受。
- ADR-03：终端输出采用**ACK 驱动的信用窗口**，不是"发完就算"。理由：xterm.js 的 `write` 是异步排队的，无背压会导致 JS 堆暴涨直至掉帧。
- ADR-04：SQLite 单写连接（`Mutex<Connection>`）+ 读连接池；所有写入在 `spawn_blocking` 中执行。理由：WAL 下并发写无收益，反而引入 `SQLITE_BUSY`。
- ADR-05：凭证本体永不落 SQLite，只存 `CredentialRef`。`CredentialRef` 是"指针"，不是密文。

---

## 1. 总体架构

### 1.1 进程与线程模型

物理进程拓扑（三平台一致，仅 WebView 实现不同）：

```mermaid
graph LR
    subgraph P1["主进程（Rust / Tauri）"]
        RT["tokio runtime<br/>workers = min(8, cores)"]
        DB["SQLite 写线程<br/>(spawn_blocking)"]
        PTY["本地 PTY 线程<br/>(每标签 1 个 OS 线程)"]
    end
    subgraph P2["WebView 渲染进程"]
        WEB["xterm.js + React<br/>(WebView2 / WKWebView / WebKitGTK WebProcess)"]
    end
    RT -->|"IPC: 命令 / Channel 字节流"| WEB
```

| 执行单元 | 载体 | 数量 | 职责 | 退出条件 |
|---|---|---|---|---|
| `SessionActor` | tokio task | 每连接 1 个 | 持有 `russh::client::Handle`、状态机、通道注册表、重连计时器 | 用户关闭 / 重连放弃 |
| `ChannelReader` | tokio task | 每 SSH 通道 1 个 | `channel.wait()` 循环；合并输出 → 发 `Channel`；处理 `ExitStatus`/`Eof` | 通道关闭 |
| `ChannelWriter` | tokio task + `mpsc` | 每 SSH 通道 1 个 | 串行化 `data()`，保证字节序 | 通道关闭 |
| `SftpWorker` | tokio task | 每连接 ≤ 4 | 独占一条 `russh-sftp` 通道，执行 `open/read/write/close` | 空闲 60s 或连接断开 |
| `PtyThread` | OS 线程 | 每本地标签 1 个 | `portable-pty` 阻塞读取 → 同一套合并器 | 进程退出 |
| `ProgressAggregator` | tokio task | 全局 1 个 | 4Hz 汇总所有 `TransferJob` 进度 | 应用退出 |
| `DbWriter` | `spawn_blocking` 池 | 串行 | 所有写 SQL；事务粒度 ≤ 50ms | — |

**硬性约束**（进 Code Review checklist）：

1. 任何 `#[tauri::command]` 函数体 **不得** 直接做 I/O 阻塞；必须 `spawn_blocking` 或投递到 actor，返回耗时 ≤ 5ms。
2. async 任务内单次同步计算 ≤ 1ms；超出的（如 50k 条目录排序）下沉到 `spawn_blocking`。
3. 禁止在 `ChannelReader` 中做字符串格式化/日志拼接（每字节路径上零分配，见 3.4）。
4. 所有 `russh::client::Handle` 只被 `SessionActor` 拥有，其他模块通过 `mpsc` 消息请求，不 `Arc` 共享可变连接。

### 1.2 连接状态机

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Resolving: open 传入 connectionId
    Resolving --> Transport: DNS / 代理链就绪
    Transport --> HostKeyCheck: 收到 host key
    HostKeyCheck --> Authenticating: 已信任或用户接受
    HostKeyCheck --> Failed: 指纹不符且用户拒绝
    Authenticating --> Ready: auth ok
    Authenticating --> Failed: 认证失败（不可重试）
    Ready --> Suspended: IO 错误 / 心跳超时
    Suspended --> Resolving: 自动重连（≤ 8 次）
    Ready --> Closing: disconnect
    Suspended --> Closed: 重连耗尽
    Closing --> Closed
    Failed --> Closed
    Closed --> [*]
```

状态迁移全部经 `SessionActor` 单点处理，每次迁移发出 `conn_state` 事件（含 `reason` 枚举）。`Suspended` 期间前端保留 tab、不清屏，只置顶一条内联提示条。

### 1.3 三种回传路径与适用边界

| 路径 | 机制 | 适用 | 上限 |
|---|---|---|---|
| 命令返回值 | `#[tauri::command]` 的 `Result<T, AppError>` | 请求-响应型（列目录一页、读设置） | 单次 ≤ 4MB |
| 每标签 Channel | `tauri::ipc::Channel<StreamMsg>`，在 `terminal_open` 时由前端创建并传入 | 终端字节流、该标签的 ctrl 消息（bell/title/clipboard 请求） | 见 3.4 信用窗口 |
| 全局事件 | `app.emit("sftp:progress", …)` | 低频状态（<4Hz）、跨窗口通知 | 载荷 ≤ 8KB |

规则：**任何 > 4KB 或 > 10Hz 的数据都不允许走全局事件。**

### 1.4 模块边界

| 模块 | 拥有 | 禁止 |
|---|---|---|
| `ssh/` | TCP/代理链建立、host key 校验、认证、算法协商、通道开闭 | 不得触碰 SQLite、不得 emit UI 事件（只返回 `Result`） |
| `sftp/` | 路径规范化、目录流、文件读写、属性 | 不得管理传输队列优先级（属 `transfer/`） |
| `terminal/` | 本地 PTY、输出合并器、编码转换（UTF-8 直通，GBK 由 profile 指定时转码） | 不得解释 VT 序列（仿真在前端） |
| `session/` | 聚合根：会话 CRUD、状态机、重连策略 | 不得直接读钥匙串（走 `secret/`） |
| `secret/` | 钥匙串读写、密钥文件/PPK 解析、agent 客户端、日志脱敏 | 不得返回裸 `String` 密码（只返回 `SecretString`） |
| `ipc/` | DTO、命令注册、参数校验、`Channel` 封装、错误码映射 | 不得包含业务分支 |
| `transfer/` | 队列、优先级、断点、冲突策略、进度聚合 | 不得直接开 SFTP 通道（走 `sftp::pool`） |
| `db/` | schema、迁移、仓储（repo） | 不得含业务规则 |

前端按 feature 切分，feature 之间只能通过 `lib/ipc` 与 `lib/store` 通信，禁止跨 feature 直接 import 组件。

### 1.5 目录结构

```
repo/
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  └─ src/
│     ├─ main.rs                # 仅调 app::run()
│     ├─ lib.rs
│     ├─ app/            # 启动装配、tray、window、单实例
│     ├─ ipc/
│     │   ├─ mod.rs
│     │   ├─ commands/{terminal,session,sftp,transfer,secret,key,knownhost,settings}.rs
│     │   ├─ channel.rs  # 信用窗口、合并器、StreamMsg
│     │   ├─ dto.rs      # 所有 serde 类型，camelCase
│     │   └─ error.rs    # AppError + 稳定错误码表
│     ├─ ssh/
│     │   ├─ mod.rs
│     │   ├─ connect.rs      # 握手编排
│     │   ├─ handler.rs      # russh client::Handler 实现
│     │   ├─ auth.rs         # password / pubkey / agent / keyboard-interactive
│     │   ├─ transport.rs    # 直连 / SOCKS5 / HTTP CONNECT 隧道
│     │   ├─ tunnel.rs       # ProxyJump = direct-tcpip 链
│     │   └─ algo.rs         # 算法优先级与本机配置合并
│     ├─ sftp/{mod,session,pool,ops,path,attrs}.rs
│     ├─ terminal/{pty,coalesce,encoding,title}.rs
│     ├─ session/{actor,manager,reconnect,store}.rs
│     ├─ transfer/{queue,job,resume,conflict,progress}.rs
│     ├─ secret/{keyring,keyfile,ppk,agent,redact}.rs
│     ├─ knownhost/{mod,policy,fingerprint}.rs
│     ├─ db/{mod,schema,migrate,repo/{sessions,connections,transfers,knownhosts}}.rs
│     └─ config.rs  error.rs
│  └─ tests/            # 集成测试，夹具见 §8.2
├─ src/
│  ├─ main.tsx
│  ├─ app/{router,providers,layout}
│  ├─ features/
│  │   ├─ terminal/{TerminalPane.tsx,useTerminal.ts,addons.ts,keymap.ts,pasteGuard.ts,search.ts}
│  │   ├─ sessions/{SessionTree.tsx,SessionForm,QuickConnect}
│  │   ├─ sftp/{DualPane.tsx,LocalPane.tsx,RemotePane.tsx,FileList.tsx,useDirStream.ts}
│  │   ├─ transfers/{QueuePanel.tsx,TransferRow.tsx,useProgress.ts}
│  │   ├─ keys/{KeyList,KeyImport,HostKeyDialog}
│  │   └─ settings/
│  ├─ lib/{ipc/{commands.ts,events.ts,channel.ts,types.ts},store/{sessions.ts,ui.ts},ui,theme}
│  └─ styles/
├─ scripts/{dev-sshd.sh,bench-ipc.ts,sign-macos.sh}
├─ docs/
└─ .github/workflows/{ci.yml,release.yml}
```

### 1.6 模块依赖图

```mermaid
graph TD
    FE["frontend: features/*"] --> LIB["frontend: lib/ipc + store"]
    LIB --> IPC["ipc/ (commands · channel · dto)"]
    IPC --> SESS["session/ (actor · manager · reconnect)"]
    IPC --> TRANS["transfer/ (queue · progress)"]
    SESS --> SSH["ssh/ (connect · auth · transport · tunnel)"]
    SESS --> SFTP["sftp/ (pool · ops)"]
    SSH --> SECRET["secret/ (keyring · ppk · agent)"]
    SSH --> KH["knownhost/ (policy)"]
    SFTP --> SSH
    TRANS --> SFTP
    SESS --> DB["db/ (repo · migrate)"]
    TRANS --> DB
    KH --> DB
    TERM["terminal/ (pty · coalesce)"] --> IPC
    IPC --> SECRET
    SSH --> RUSSH[("russh + russh-sftp")]
    TERM --> PP[("portable-pty")]
    DB --> SQL[("SQLite (WAL)")]
    SECRET --> KS[("OS keychain")]
```

依赖方向铁律：`ipc → 业务 → 基础设施`；反向依赖必须用 trait 注入（如 `transfer` 通过 `SftpPool` trait 拿通道）。

### 1.7 关键时序：连接 + 首次信任 + 开 shell

```mermaid
sequenceDiagram
    participant U as 前端
    participant C as ipc/commands
    participant A as SessionActor
    participant T as ssh/transport
    participant H as knownhost
    participant K as secret
    U->>C: terminal_open(connection_id, profile, Channel)
    C->>A: Open(conn, ch)
    A->>K: 取 CredentialRef → SecretString
    A->>T: 逐跳建链(SOCKS5/HTTP CONNECT/direct-tcpip)
    T-->>A: TcpStream/通道流
    A->>H: verify(host,port,key_blob)
    alt 未记录
        H-->>U: hostkey_verify_request(指纹)
        U-->>H: accept / reject(记忆策略)
    end
    A->>A: auth(password | pubkey | agent)
    A->>A: channel_open_session + request_pty + shell
    A-->>U: conn_state=Ready
    loop 每通道
        A->>U: Channel.send(term_data ≤32KB 分片)
        U->>A: terminal_ack(bytes)
    end
```

---

## 2. 关键数据模型

### 2.1 实体字段

**Session（会话 = 用户可见的一个连接配置）**

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK, UUIDv7 | 时间有序，利于列表分页 |
| `connection_id` | TEXT | FK → connection, NOT NULL | 连接参数独立成实体，便于"多会话共享一套连接" |
| `name` | TEXT | NOT NULL, ≤64 | 标签页标题默认值 |
| `group_id` | TEXT | FK → session_group, NULL | 树形分组 |
| `terminal_profile_id` | TEXT | FK → terminal_profile | 外观/行为 |
| `color_tag` | TEXT | NULL | 侧边色条 `#RRGGBB` |
| `sort_order` | INTEGER | NOT NULL DEFAULT 0 | 同组内排序 |
| `last_used_at` | INTEGER | NULL | 毫秒时间戳；快速连接排序 |
| `note` | TEXT | NULL, ≤4KB | 备注 |
| `created_at`/`updated_at` | INTEGER | NOT NULL | 毫秒 |

**Connection（连接 + 跳板链）**

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | |
| `name` | TEXT | NOT NULL | |
| `host` | TEXT | NOT NULL | 仅存主机名/IP，不含 `user@` |
| `port` | INTEGER | NOT NULL DEFAULT 22 | 1–65535 |
| `username` | TEXT | NOT NULL | |
| `auth_kind` | TEXT | NOT NULL | `password` / `publickey` / `agent` / `keyboard-interactive` |
| `credential_ref_id` | TEXT | FK → credential_ref, NULL | `agent` 时可为空 |
| `proxy_mode` | TEXT | NOT NULL DEFAULT 'direct' | `direct` / `socks5` / `http_connect` / `jump` |
| `proxy_hop_id` | TEXT | FK → proxy_hop, NULL | `proxy_mode ∈ {socks5,http_connect}` 时的前置代理 |
| `keepalive_ms` | INTEGER | NOT NULL DEFAULT 30000 | 0 = 关闭；心跳发 `keepalive@openssh.com` |
| `connect_timeout_ms` | INTEGER | NOT NULL DEFAULT 15000 | |
| `compression` | INTEGER | NOT NULL DEFAULT 0 | 0/1（zlib 由 russh 协商） |
| `algo_overrides` | TEXT | NULL | JSON：仅覆盖 `kex`/`cipher`/`mac`/`hostkey` 列表 |
| `created_at`/`updated_at` | INTEGER | NOT NULL | |

**ProxyHop（跳板链，有序）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | |
| `connection_id` | TEXT FK, CASCADE | 归属的最终连接 |
| `seq` | INTEGER | 0 为最外层跳板，逐跳递增；`UNIQUE(connection_id, seq)` |
| `kind` | TEXT | `ssh_jump` / `socks5` / `http_connect` |
| `host` / `port` | TEXT / INTEGER | |
| `username` | TEXT NULL | 仅 `ssh_jump` |
| `credential_ref_id` | TEXT FK NULL | 仅 `ssh_jump` 需要认证时 |
| `options_json` | TEXT NULL | `{"socks5":{"remote_dns":true,"auth":false}}` 等 |

连接算法：`seq` 升序折叠。`ssh_jump` → 上一跳 `direct-tcpip`；`socks5`/`http_connect` → 在上一跳的 `TcpStream` 上手写协议握手，再交给 `russh::client::connect_stream`。最后一跳即目标主机。

**KnownHost**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | |
| `host` / `port` | TEXT / INTEGER | 规范化：小写、去方括号 |
| `key_type` | TEXT | `ssh-ed25519` / `ecdsa-sha2-nistp256` / `rsa-sha2-512` … |
| `public_key` | BLOB | 原始 key blob（不解 base64） |
| `fingerprint_sha256` | TEXT | `SHA256:base64(no padding)`，UI 显示与比对用 |
| `trust` | INTEGER | 0=待确认 1=已信任 2=已撤销 |
| `first_seen_at` / `last_seen_at` | INTEGER | |
| `note` | TEXT NULL | 用户备注（如"变更单 CHG-123"） |

`UNIQUE(host, port, fingerprint_sha256)`：允许同主机同算法保留历史指纹（密钥轮换），命中"当前 key 不在信任集但同 host 有历史"即触发**严重告警**而非静默接受。

**CredentialRef（只存指针）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | |
| `kind` | TEXT | `password` / `passphrase` / `key_file` / `agent_identity` |
| `backend` | TEXT | `keychain` / `file` / `agent` |
| `service` | TEXT NULL | 钥匙串 service 名，固定 `com.shellora.v1` |
| `account` | TEXT NULL | 钥匙串条目名，形如 `cred/{uuid}` |
| `key_file_path` | TEXT NULL | 仅 `key_file`，绝对路径；文件本体不复制 |
| `has_passphrase` | INTEGER | 提示 UI 是否需要解锁 |
| `created_at` / `updated_at` | INTEGER | |

**TransferJob**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | |
| `connection_id` | TEXT FK | |
| `direction` | TEXT | `upload` / `download` |
| `src_path` / `dst_path` | TEXT | 远端路径用 POSIX 规范化；本地用平台绝对路径 |
| `size_bytes` | INTEGER | 大小未知为 -1（显示"未知"而非 0） |
| `bytes_done` | INTEGER | 每 8MB 或 2s 落盘一次 |
| `state` | TEXT | `queued`/`running`/`paused`/`failed`/`done`/`canceled` |
| `priority` | INTEGER | 0–9，9 最高；默认 5 |
| `conflict_policy` | TEXT | `overwrite`/`skip`/`rename`/`ask` |
| `attempt` | INTEGER | 已重试次数 |
| `error_code` | TEXT NULL | 映射自 `AppError` |
| `resume_offset` | INTEGER | 断点位置（= `bytes_done` 已提交部分） |
| `created_at`/`started_at`/`finished_at` | INTEGER | |

**TerminalProfile**

| 字段 | 默认 | 说明 |
|---|---|---|
| `id`/`name` | — | |
| `font_family` | `"JetBrains Mono, Menlo, Consolas, monospace"` | |
| `font_size` | 14 | 9–32 |
| `line_height` | 1.2 | |
| `cursor_style` | `block` | block/underline/bar（可被 DECSCUSR 覆盖，见 4 表） |
| `cursor_blink` | true | |
| `scrollback` | 10000 | 1000–50000，>20000 时提示内存占用 |
| `color_scheme` | `"One Dark"` | 主题 ID |
| `bell` | `visual` | none/visual/audio |
| `paste_safety` | `confirm_multiline` | `confirm_multiline`/`confirm_always`/`off` |
| `encoding` | `utf-8` | **仅 `utf-8`（D2）**；字段保留为扩展点，其它值在校验阶段直接拒绝 |
| `copy_on_select` | false | |
| `word_separators` | 默认集合 | 双击选词 |

### 2.2 关系图

```mermaid
erDiagram
    SESSION_GROUP ||--o{ SESSION : "分组"
    CONNECTION ||--o{ SESSION : "被引用"
    CONNECTION ||--o{ PROXY_HOP : "跳板链"
    CREDENTIAL_REF ||--o{ CONNECTION : "认证指针"
    CREDENTIAL_REF ||--o{ PROXY_HOP : "跳板认证指针"
    TERMINAL_PROFILE ||--o{ SESSION : "外观"
    SESSION ||--o{ TRANSFER_JOB : "运行期关联"
    KNOWN_HOST }o--|| CONNECTION : "按 host 与 port 校验"
```

`KNOWN_HOST` 与 `CONNECTION` 的连线表示"运行期按 host:port 查找"，非数据库外键（禁止级联删除信任记录）。

### 2.3 SQLite 表结构（迁移 v1）

```sql
-- 连接级 PRAGMA（每次开库执行）
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE session_group (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES session_group(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE terminal_profile (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  font_family    TEXT NOT NULL,
  font_size      INTEGER NOT NULL DEFAULT 14,
  line_height    REAL NOT NULL DEFAULT 1.2,
  cursor_style   TEXT NOT NULL DEFAULT 'block',
  cursor_blink   INTEGER NOT NULL DEFAULT 1,
  scrollback     INTEGER NOT NULL DEFAULT 10000,
  color_scheme   TEXT NOT NULL DEFAULT 'One Dark',
  bell           TEXT NOT NULL DEFAULT 'visual',
  paste_safety   TEXT NOT NULL DEFAULT 'confirm_multiline',
  encoding       TEXT NOT NULL DEFAULT 'utf-8',
  copy_on_select INTEGER NOT NULL DEFAULT 0,
  word_separators TEXT
);

CREATE TABLE credential_ref (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('password','passphrase','key_file','agent_identity')),
  backend        TEXT NOT NULL CHECK (backend IN ('keychain','file','agent')),
  service        TEXT,
  account        TEXT,
  key_file_path  TEXT,
  has_passphrase INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE connection (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  host               TEXT NOT NULL,
  port               INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  username           TEXT NOT NULL,
  auth_kind          TEXT NOT NULL CHECK (auth_kind IN ('password','publickey','agent','keyboard-interactive')),
  credential_ref_id  TEXT REFERENCES credential_ref(id) ON DELETE SET NULL,
  proxy_mode         TEXT NOT NULL DEFAULT 'direct'
                     CHECK (proxy_mode IN ('direct','socks5','http_connect','jump')),
  proxy_hop_id       TEXT REFERENCES proxy_hop(id) ON DELETE SET NULL,
  keepalive_ms       INTEGER NOT NULL DEFAULT 30000,
  connect_timeout_ms INTEGER NOT NULL DEFAULT 15000,
  compression        INTEGER NOT NULL DEFAULT 0,
  algo_overrides     TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(name)
);

CREATE TABLE proxy_hop (
  id                TEXT PRIMARY KEY,
  connection_id     TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('ssh_jump','socks5','http_connect')),
  host              TEXT NOT NULL,
  port              INTEGER NOT NULL,
  username          TEXT,
  credential_ref_id TEXT REFERENCES credential_ref(id) ON DELETE SET NULL,
  options_json      TEXT,
  UNIQUE (connection_id, seq)
);

CREATE TABLE session (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  group_id            TEXT REFERENCES session_group(id) ON DELETE SET NULL,
  terminal_profile_id TEXT NOT NULL REFERENCES terminal_profile(id),
  color_tag           TEXT,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  last_used_at        INTEGER,
  note                TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE known_host (
  id                 TEXT PRIMARY KEY,
  host               TEXT NOT NULL,
  port               INTEGER NOT NULL,
  key_type           TEXT NOT NULL,
  public_key         BLOB NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  trust              INTEGER NOT NULL DEFAULT 0 CHECK (trust IN (0,1,2)),
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  note               TEXT,
  UNIQUE (host, port, fingerprint_sha256)
);

CREATE TABLE transfer_job (
  id              TEXT PRIMARY KEY,
  connection_id   TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN ('upload','download')),
  src_path        TEXT NOT NULL,
  dst_path        TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL DEFAULT -1,
  bytes_done      INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued','running','paused','failed','done','canceled')),
  priority        INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
  conflict_policy TEXT NOT NULL DEFAULT 'ask',
  attempt         INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  resume_offset   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER
);

CREATE TABLE sftp_bookmark (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  label         TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (connection_id, path)
);

CREATE TABLE app_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 索引：全部对应真实查询路径，无"以防万一"索引
CREATE INDEX idx_session_group_sort ON session(group_id, sort_order);
CREATE INDEX idx_session_recent     ON session(last_used_at DESC);
CREATE INDEX idx_session_conn       ON session(connection_id);
CREATE INDEX idx_proxyhop_conn_seq  ON proxy_hop(connection_id, seq);
CREATE INDEX idx_knownhost_lookup   ON known_host(host, port);
CREATE INDEX idx_transfer_pick      ON transfer_job(state, priority DESC, created_at);
CREATE INDEX idx_transfer_conn      ON transfer_job(connection_id, state);
CREATE INDEX idx_bookmark_conn      ON sftp_bookmark(connection_id, sort_order);
```

### 2.4 迁移策略

1. **版本载体**：`PRAGMA user_version`。不使用 `schema_migrations` 表，避免"迁移记录本身也要迁移"的死循环。
2. **方向**：只向前（forward-only）。发布版不含 down 迁移；降级安装包直接拒绝启动并提示"数据库版本高于应用"。
3. **执行**：`db/migrate.rs` 内 `const MIGRATIONS: &[Migration]`，每项 `{ version: u32, sql: &str }`。启动时在**单个事务**内 `BEGIN → 逐条 exec → PRAGMA user_version = N → COMMIT`。
4. **备份**：`user_version < target` 时，先 `VACUUM INTO 'app.db.bak.v{old}'`（SQLite 3.27+ 原子快照），失败即中止启动。
5. **测试**：CI 用 v1…vN-1 的数据库夹具，逐个执行到 vN，断言：无错误、`PRAGMA integrity_check` = ok、关键表行数不变、所有索引存在（`SELECT name FROM sqlite_master WHERE type='index'`）。
6. **规则**：改列一律"新列 + 回填 + 保留旧列至下一个大版本"；禁止 `DROP COLUMN` 与 `ALTER TYPE` 在同一次迁移里并存。

---

## 3. IPC 契约

DTO 全部 `camelCase`（`#[serde(rename_all = "camelCase")]`）；二进制字段以 `Vec<u8>` 直传（未知支持时降级 base64，见 3.4 决策门）。所有命令返回 `Result<T, AppError>`，错误体固定 `{ code, message, retriable, detail? }`。

### 3.1 命令清单

| 命令 | 入参 | 返回 | 备注 |
|---|---|---|---|
| `session_list` | — | `SessionDto[]` | 含 connection 摘要与分组 |
| `session_upsert` | `SessionInput` | `SessionDto` | 同时校验 connection 完整性 |
| `session_delete` | `{id}` | `void` | 级联删 transfer_job |
| `session_reorder` | `{groupId, ids[]}` | `void` | 单事务批量更新 |
| `conn_test` | `connectionId` | `{ok, latencyMs, hostKeyFingerprint, banner}` | 只握手到认证前，不建 shell |
| `terminal_open` | `{connectionId, profileId, channel: Channel<StreamMsg>}` | `{tabId}` | 异步推进；立刻返回 tabId |
| `terminal_close` | `{tabId}` | `void` | 幂等 |
| `terminal_input` | `{tabId, data: string}` | `void` | 入站字节；≤ 64KB/次 |
| `terminal_resize` | `{tabId, cols, rows}` | `void` | Rust 侧 60ms 合并 + `window_change` |
| `terminal_ack` | `{tabId, bytes}` | `void` | 信用窗口归还；必须与 `Channel` 发送量严格对账 |
| `clipboard_read` | `{tabId}` | `{text, lines}` | 读系统剪贴板，供中键/右键粘贴 |
| `clipboard_write` | `{text}` | `void` | 仅用于"选中复制" |
| `paste_check` | `{tabId, text}` | `{action: 'send'|'confirm', lines}` | 多行/含控制字符时前端弹确认 |
| `reconnect` | `{tabId}` | `void` | 手工重连，重置退避 |
| `sftp_open` | `{connectionId}` | `{sftpId}` | 从通道池借通道 |
| `sftp_read_dir` | `{sftpId, path, cursor?, limit=500}` | `{entries[], nextCursor?, exhausted}` | 流式分页，见 5.3 |
| `sftp_stat` | `{sftpId, path}` | `EntryDto` | |
| `sftp_mkdir`/`sftp_rmdir`/`sftp_rename`/`sftp_remove` | 路径参数 | `void` | 批量删除走数组入参 |
| `sftp_chmod` | `{sftpId, path, mode}` | `void` | mode 为八进制整数 |
| `sftp_readlink` / `sftp_realpath` | 路径 | `string` | |
| `local_read_dir` | `{path, cursor?, limit=500}` | 同 `sftp_read_dir` | 本地栏，Rust 侧 `readdir` |
| `transfer_enqueue` | `{jobs: TransferInput[]}` | `{ids[]}` | 入队即返回，不同步传 |
| `transfer_pause`/`transfer_resume`/`transfer_cancel` | `{ids[]}` | `void` | |
| `transfer_set_priority` | `{id, priority}` | `void` | 重排队 |
| `transfer_retry` | `{ids[]}` | `void` | `attempt` 自增 |
| `transfer_list` | `{state?, connectionId?}` | `TransferDto[]` | ≤ 1000 条，超出分页 |
| `knownhost_answer` | `{host, port, fingerprint, decision: 'trust'|'reject'|'trustOnce'}` | `void` | 对接 1.7 时序 |
| `knownhost_list` / `knownhost_revoke` | — / `{id}` | `KnownHostDto[]` / `void` | |
| `key_import` | `{path, format: 'auto'|'openssh'|'ppk', passphrase?}` | `{keyId, fingerprint, algo}` | PPK 内部转 OpenSSH 后统一处理 |
| `key_list` / `key_delete` | — / `{keyId}` | `KeyDto[]` / `void` | 不返回私钥 |
| `agent_list` | — | `{identities: {fingerprint, comment, algo}[]}` | 失败返回 `agent_unavailable` |
| `secret_probe` | — | `{backend: 'keychain'|'none', detail}` | Linux 启动时判定，见 R-04 |
| `settings_get` / `settings_set` | `{key}` / `{key, value}` | `string` / `void` | 白名单 key |

### 3.2 事件清单

| 事件 | 载荷 | 频率上限 | 说明 |
|---|---|---|---|
| `conn_state` | `{tabId, state, reason?, since}` | 变化时 | 对应 1.2 状态机 |
| `hostkey_verify_request` | `{tabId, host, port, keyType, fingerprint, isChanged, knownFingerprints[]}` | 变化时 | `isChanged=true` 走红色告警文案 |
| `tab_title` | `{tabId, title, source: 'osc'|'user'}` | 200ms | 来自 OSC 0/2 |
| `transfer_progress` | `{items: [{id, bytesDone, speedBps, etaSec}]}` | **4Hz 聚合** | 只发变化项 |
| `transfer_state` | `{id, state, errorCode?}` | 变化时 | |
| `sftp_dir_error` | `{sftpId, path, code}` | 变化时 | 目录列举失败（无权限等） |
| `app_notice` | `{level, code, message}` | ≤1/s | 非致命提醒（如 agent 不可用） |

**终端字节流不进事件表**：`term_data`、`term_bell`、`term_clipboard_request`、`term_search_result` 全部封装在 `StreamMsg` 内，经每标签 `Channel` 投递：

```ts
// src/lib/ipc/channel.ts
export type StreamMsg =
  | { k: 'data'; seq: number; b: Uint8Array }   // 数据帧
  | { k: 'bell' } | { k: 'title'; s: string }
  | { k: 'eof'; code: number | null }
  | { k: 'clip'; op: 'read' | 'write'; s?: string };
```

### 3.3 为什么是每标签 Channel 而不是全局事件

- 全局事件 `emit` 会把载荷序列化一次再分发给所有监听的 webview；32 个标签时每帧重复 32 次派发，且无法保证到达顺序。
- `tauri::ipc::Channel` 是**点对点**、**有序**的，创建时绑定到一次调用，天然按标签隔离。
- 关键：Channel 的 `send` 可跨线程调用，`ChannelReader` 任务无需 `async` 回主线程。

### 3.4 大流量限流与批量化

**合并器（Rust，每通道一个）**

```
输入：russh ChannelMsg::Data（通常 1–8KB 一次）
规则：累积到 ≥ 32KB 或距首字节 ≥ 8ms → 立即 flush 一帧
      exit/EOF/shutdown → 强制 flush 并追加 {k:'eof'}
      flush 时 seq 自增；seq 仅用于前端乱序检测（正常应为严格连续）
```

依据：8ms ≈ 半帧，合并后帧数下降 5–15 倍，xterm 的 `write` 批处理路径效率最高；32KB 单帧在 WebView2 postMessage 下约 0.2ms 序列化开销。

**信用窗口（端到端背压）**

```
windowCapacity = 256 KB / tab
ChannelReader:
    acquire(permit) before send     // tokio Semaphore，1 permit = 8KB
    发一帧 len → 消耗 ceil(len/8KB) permits
前端:
    term.write(bytes, () => invoke('terminal_ack', {tabId, bytes: len}))
    ack 到达 → release 对应 permits
异常保护:
    ack 超过 5s 未回 → 记一次 starvation 指标，窗口减半（下限 64KB）
```

效果：xterm 渲染跟不上时，`russh` 的读循环自然停住（TCP 窗口随之收缩），不会把 10MB 塞进 JS 堆。

**传输进度**：`ProgressAggregator` 每 250ms 扫一遍活跃 job，只发 `bytesDone` 变化 ≥ 1% 或状态变化的项；`speedBps` 用 5 点滑动窗口。100 个 job 时单次载荷 < 6KB。

**目录列举**：`sftp_read_dir` 单次 ≤ 500 条、单次载荷 ≤ 64KB；前端滚动到 60% 时预取下一页；不存在的路径直接返回 `sftp_dir_error`，不做空数组。

**IPC 基准门（M0 第一周必须出数）**：

| 指标 | 通过线 | 测量方法 |
|---|---|---|
| 终端吞吐（JS 侧收齐） | ≥ 10MB/s，帧丢失 0 | `scripts/bench-ipc.ts` + `dd if=/dev/urandom bs=1M count=200 status=none` 输出到终端 |
| 单帧 32KB 端到端延迟 p95 | ≤ 12ms | 打时间戳帧，前端 `performance.now()` 差值 |
| 空闲时 IPC CPU 占用 | ≤ 3%（8 标签） | 任务管理器 / `ps` 采样 10s |

若 `Channel<Vec<u8>>` 在目标 WebView 上被序列化为 JSON 数组（体积膨胀 3–4 倍）导致吞吐 < 5MB/s，则启用**降级路径**：Rust 侧 base64 编码成 `string`（膨胀 1.33 倍 + 解码约 0.05ms/32KB），代码由 `channel.rs` 内 `EncodingMode` 开关切换，前端无分支。

### 3.5 断线重连契约

- 触发：`russh` 收到 `Disconnect`/IO 错误/心跳连续 2 次超时。
- 策略：指数退避 `1s, 2s, 4s, 8s, 16s, 30s…`（≤30s，±20% 抖动，最多 8 次），已开通道全部作废并置 `eof`。
- 重连成功：新开 shell，前端**不清屏**，插入一行 `[reconnected at 10:32:11, previous session detached]`；若已知上次 OSC 7 cwd 且 shell 为 bash/zsh，执行 `cd -- <cwd>` 并回显命令。
- 重连失败：`conn_state=Closed`，标签保留，可点"重试"（重置退避）。
- 不做：会话恢复（tmux/screen 接管需用户显式配置，不在本期）。

---

## 4. 终端仿真验收清单

约定：所有"验证方法"中的 `\e` 表示 ESC(0x1B)；除标注"手工"外，均需在 CI 的 golden 夹具中固化（见 8.4）。**通过 = 实际截图/缓冲区快照与期望逐字符一致。**

| # | 能力 | 期望行为 | 验证方法 | 期望结果 | 自动化 |
|---|---|---|---|---|---|
| T01 | 真彩色 | `38;2;r;g;b` 与 `48;2` 精确还原；256 色 `38;5;n` 正确 | `printf '\e[38;2;12;200;99mX\e[0m'`；`printf '\e[38;5;196mX\e[0m'` | 取色器采样 RGB=(12,200,99)；256 色表第 196 项 = `#FF0000` | golden + 像素采样 |
| T02 | 基础 16 色与亮度 | SGR 1/2/3/4/5/7/9 叠加正确；`\e[3m` 斜体在字体缺失时不崩 | 构造 16 色 × 属性矩阵 | 与 `xterm-256color` 参考截图一致 | golden |
| T03 | resize / SIGWINCH | 拖拽窗口后 `stty size` 与视口一致；`trap 'echo R' WINCH` 触发 | 打开 `bash`，执行 `stty size; trap 'echo R' WINCH`，把窗口从 120×30 拖到 80×20 | 输出立即变为 `20 80`；随后每次拖拽打印一行 `R`；无残留错位字符 | 手工 + Playwright 改视口 |
| T04 | 宽字符与 emoji | CJK 占 2 列；emoji 组合序列（ZWJ）占 2 列不撕裂；宽度表与 unicode11 一致 | 打印 `中文ab`、`👨‍👩‍👧‍👦`、`e\u0301`，再 `printf '\e[10G|\n'` 定位第 10 列 | 竖线严格落在第 10 列；emoji 不出现半格残影；`e` + 组合符占 1 列 | golden（buffer 维度） |
| T05 | IME 中文输入 | 组合中不提交中间态；提交后字节恰好一次；组合期间不触发快捷键 | 搜狗/微软拼音输入"测试"，输入中途按 Esc 取消；再输入并按回车 | 取消后无字符残留；提交后终端只收到一次 `测试`；输入"测试"时按 Ctrl+C 不触发中断 | 手工（三平台）+ composition 事件单测 |
| T06 | 鼠标上报 | 1000/1002/1003 按下/拖动/移动上报；1006(SGR) 编码；禁用时不干扰选中 | 运行 `printf '\e[?1000h\e[?1006h'` + `python3 -c "print(input())"` 观察 | 点击输出 `\e[<0;x;yM`；松开 `m`；1002 下拖动持续上报；`\e[?1000l` 后恢复选区 | golden（Rust 侧断言输入字节） |
| T07 | 滚轮 | normal screen 滚动 scrollback；alternate screen 转成 ↑↓ 按键 | 在 `less` 中滚轮；回到 shell 后滚轮 | `less` 内逐行滚动不退出；shell 里滚轮翻历史；alternate 下滚轮产生 `\e[A`/`\e[B` | 手工 + 输入字节断言 |
| T08 | alternate screen | `1049h/l` 进入/退出；退出后恢复原屏幕内容与光标 | `\e[?1049h` 清屏写内容，再 `\e[?1049l` | 恢复前内容逐字符一致；无多余空行；不污染 scrollback | golden |
| T09 | bracketed paste | `2004h` 时粘贴包 `\e[200~…\e[201~`；未开启时不包裹 | `printf '\e[?2004h'` 后粘贴 `a\nb` | 应用收到单次 paste 事件；`read -e` 下多行不自动执行 | 输入字节断言 |
| T10 | 链接识别 | OSC 8 显式链接优先；纯文本 URL 可点；`file:line` 支持 | 打印 OSC 8 链接与 `https://example.com/x`、`src/main.rs:42` | Ctrl+点击（mac Cmd+点击）打开默认浏览器/编辑器；hover 显示下划线 + tooltip；链接不吞标点 | golden + 点击回调单测 |
| T11 | 搜索 | 增量高亮、`Enter` 下一个、`Shift+Enter` 上一个、大小写开关、结果计数 | `addon-search` 输入 `error` | 计数与可见高亮一致；循环不越界；搜索结果不影响正常输出 | 组件测试 |
| T12 | 选中复制 | 拖选复制到剪贴板；`copy_on_select` 开关；三击选行、双击选词 | 选中含换行文本后粘贴回编辑器 | 内容逐字节一致（无多余 `\r`）；双击只在分隔符边界断词 | 手工 + 剪贴板单测 |
| T13 | 粘贴多行确认 | 含换行或控制字符时弹确认，展示行数与风险提示；`confirm_always` 每次确认 | 复制 3 行命令粘贴 | 弹出"将粘贴 3 行（含回车），可能立即执行"，选"取消"后终端无输入 | 组件测试 |
| T14 | 光标形状 | DECSCUSR `\e[N q` 覆盖：0/1 块闪烁、2 块常亮、3/4 下划线、5/6 竖线 | 循环输出 `\e[1q`…`\e[6q` | 形状/闪烁与参数一一对应；vim `:set guicursor` 切模式生效 | golden（截图比对形状） |
| T15 | 字符集与绘图符 | `\e(0` 切换到 DEC 图形集，边框线用 `─│┌` 等；`\e(B` 恢复 ASCII | `printf '\e(0lqqk\e(B'` 后 `htop` | 输出 `┌───┐` 而非 `lqqk`；`htop` 边框完整 | golden |
| T16 | 焦点事件与标题 | `1004h` 切换光标/上报名；OSC 0/2 设标题；OSC 7 记 cwd | `printf '\e]0;demo\a'`；`\e[?1004h` 后切换窗口 | 标签名 = `demo`；失焦光标变空心；cwd 记录并可被 SFTP 栏沿用 | golden + 事件断言 |
| T17 | 同步输出 | `2026h/2026l` 期间不重绘，结束后一次性提交 | 运行 `printf '\e[?2026h…\e[?2026l'` 压力脚本 | 无中间撕裂帧（录屏逐帧检查）；结束后内容完整 | 手工（录屏） |

**已知取舍（写进验收文档，避免反复争论）**：不实现 Sixel/Kitty 图形协议；不实现 `modifyOtherKeys`；`\e]1337;` iTerm2 专有序列仅识别 File/SetMark 两类，其余忽略并记录 debug 日志。

---

## 5. SFTP 性能设计

### 5.1 通道与块大小默认值

| 参数 | 默认值 | 可调范围 | 理由 |
|---|---|---|---|
| 每连接 SFTP 通道数 `C` | **4** | 2–16 | OpenSSH `sftp-server` 单通道是串行的（一个请求等一个响应）。4 条通道足以覆盖 100Mbps × 20ms 的带宽时延积（BDP ≈ 250KB），同时留给交互式浏览 1–2 条 |
| 单次协议请求数据量 `R` | **64 KiB**（启动时按服务器 `limits@openssh.com` 的 `max-write-size`/`max-read-size` 取 `min`，无该扩展则 32 KiB） | 16–256 KiB | 大于 64KB 的请求在部分服务端（旧版 OpenSSH、ProFTPD）会被拒或截断；32KB 是兼容性兜底 |
| 逻辑分块 `B` | **256 KiB** | 64 KiB–4 MiB | 一条分块 = 4 个 64KB 请求；分块是**断点续传与进度统计单位**，与协议请求解耦 |
| 每通道在途请求数 `P` | **2** | 1–4 | 单请求 RTT 内再塞 1 个请求，可再提升约 30% 吞吐；>4 会放大丢包重传影响 |
| 读本地文件缓冲 | 1 MiB | — | 减少系统调用；与分块边界对齐 |
| 并发 job 数（同连接） | **2** | 1–4 | 加上浏览用通道，通道预算 4 不被打满；避免交互卡顿 |

**吞吐估算（验收线）**：LAN（1Gbps/1ms）≥ 60MB/s；跨地域（100Mbps/40ms）≥ 9MB/s。若低于验收线，先加 `C` 到 8，再加 `P` 到 4（脚本 `bench-sftp.sh` 记录组合）。

### 5.2 传输流水线

```mermaid
sequenceDiagram
    participant Q as Queue
    participant W as SftpWorker 通道 i
    participant S as 服务器 sftp-server
    participant D as 本地文件
    Q->>W: 取分块 [off, B)
    loop 每 64KB 请求（P=2 并发）
        W->>S: WRITE(handle, off+k, 64KB)
        S-->>W: STATUS OK
    end
    W->>D: 校验已写字节数，更新 bytes_done
    W->>Q: 分块完成 → 归还配额
```

**断点续传**：
- 下载：目标文件先写 `dst.part`，偏移从 `resume_offset` 开始（服务器 `STAT` 的 size 与本地 `.part` 长度取 `min`，且要求 `mtime` 未变，否则重新开始）。
- 上传：用 `SSH_FXP_WRITE` 指定绝对偏移，先 `STAT` 远端文件长度，不一致则从 0 开始。
- 全部完成才 `RENAME` 到最终名（同目录，避免跨设备失败），随后 `SETSTAT` 还原 `mtime`/权限（可选开关）。
- `bytes_done` 每 8MB 或 2s 落库；进程崩溃后重启可续（`state` 回 `queued` 且 `resume_offset` 保留）。
- 续传正确性校验：完成时若 `size_bytes` 已知则比对总长度；可选 `sha256` 抽样（每 64MB 一段）仅在用户勾选"校验"时执行。

### 5.3 万级目录：流式列举 + 虚拟滚动

- **不假设服务端分页**：SFTP `OPENDIR/READDIR` 是流式的，没有 offset。因此 `sftp_read_dir` 的 `cursor` 是**会话内句柄游标**（`HandleId + 已读条目数`），Rust 侧保持一个 `DirStream`（最多存活 90s，LRU 上限 16 个），每次取 500 条。
- 前端用 `@tanstack/react-virtual`，只渲染可视区 ±10 行；列表项用固定行高（28px），避免测量抖动。
- 首屏目标：**200 条可见 ≤ 150ms 出现**；50k 条目，滚到底 ≤ 6s 完成（分批 500 条，滚动到 60% 预取下一批）。
- 排序：由于流式，**不在服务端排序**。UI 先按到达顺序展示；用户点列头时对**已加载条目**前端排序，并在状态栏提示"基于已加载 N 项排序"。这是有意的取舍，避免为了排序把 5 万条全载入。
- 符号链接：`READDIR` 返回 `attrs` 无法区分时，用 `lstat` 批量补齐（每批 200 个并发上限 8）；失败项降级为"未知类型"图标。
- 内存上限：5 万条目 ≈ 8–12MB（含路径字符串）。超过 20 万条时提示用户"该目录过大，建议用筛选"，并把加载上限设为 20 万。

### 5.4 拖拽上传

- 来源 A：OS 文件拖入窗口 → 用 Tauri `onDragDropEvent` 拿绝对路径（**不读取文件内容进前端**，直接交给 Rust）。这是唯一正确的做法，HTML5 `DataTransfer` 在 WebView 下拿不到真实路径。
- 来源 B：窗口内远端栏 ↔ 本地栏拖拽 → 用 HTML5 DnD 传 `{sftpId, path, kind}` 的 rebase 指令，Rust 侧执行远端→远端（`read→write` 流式，256KB 块）或本地→远端。
- 拖拽态：目标行高亮 + 光标变 `copy`/`move`；`Alt` 按下表示"移动"，否则复制。
- 目录拖入：递归展开（先 `readdir` 建目录树，再按文件入队），深度上限 32，符号链接不跟随。

### 5.5 传输队列

| 机制 | 规则 |
|---|---|
| 排队 | 按 `priority DESC, created_at ASC`；`running` 数受 `min(2, 通道预算)` 限制 |
| 暂停 | `paused` 立即停止（不等待当前分块）：取消 token → 当前 in-flight 请求完成后不再提交，`bytes_done` = 已确认字节 |
| 优先级 | 运行中调高优先级不会抢占，但会在下一个分块边界让出通道给更高优先级 job |
| 冲突 | `overwrite`（保留远端 mtime）/`skip`（日志记一条）/`rename`（`name (1).ext`）/`ask`（批量任务一次性弹窗，带"全部应用"） |
| 失败 | 可重试错误（网络、超时、`FAILURE`）自动重试 3 次（退避 2/4/8s）；不可重试（权限、空间不足）直接 `failed` 并保留断点 |
| 并发目录任务 | 一个"目录上传"是 N 个 job，共用父 `batchId`；批量取消 = 取消该 batch 下所有 queued/running |
| 结果汇总 | 队列面板按 batch 汇总：成功/跳过/失败数，失败可"仅重试失败项" |

---

## 6. 安全设计

### 6.1 主机指纹与首次信任

**校验流程**（每次连接、每次重连都执行；不存在"会话内缓存跳过"）：

1. 收到 host key → 计算 `SHA256:` 指纹（base64 去 padding）。
2. 查 `known_host`：
   - 命中且 `trust=1` → 通过。
   - 命中但 `trust=2`（已撤销）→ 直接失败，文案"该指纹已被手动撤销"。
   - 未命中但同 `host:port` 存在**其他**指纹 → `isChanged=true` 红色告警：显示旧指纹列表 + "这可能是中间人攻击，也可能是服务器更换密钥"；仅提供"取消"与"仅本次信任"，**不提供"永久信任"按钮**（需先在 Known Hosts 页手动删除旧记录，强制二次确认）。
   - 完全未知 → 首次信任对话框：显示 `host:port`、算法、指纹（按 4×4 分组并支持"比较"模式）+ 提示"请通过带外渠道核对"。
3. 用户选择：`仅本次`（内存记录，重连仍提示）/ `永久信任`（写库）/ `取消`（连接失败）。
4. 严格模式（设置项 `strict_host_key`，默认开）：关闭时对已撤销指纹也只警告不阻断——但 UI 顶部常驻红色条。

**存储（D5 定稿）**：只存 SHA256 指纹 + 原始 key blob；**不读** `~/.ssh/known_hosts` 作为信任源，仅提供一次性"导入"（逐条确认后写入自有 `known_host` 表）；**永不回写**用户的 `known_hosts` 文件。理由：共享信任源会让"首次信任"退化为静默接受，回写还会污染用户其他 SSH 工具的信任状态。

**算法**：host key 优先级 `ssh-ed25519 > ecdsa-sha2-nistp256 > rsa-sha2-512 > rsa-sha2-256`；拒绝 `ssh-rsa`(SHA-1) 与 `ssh-dss`。

### 6.2 密钥格式兼容

| 格式 | 支持 | 实现要点 |
|---|---|---|
| OpenSSH 私钥（`-----BEGIN OPENSSH PRIVATE KEY-----`） | 是 | `ssh-key` 解析；支持 bcrypt KDF 加密的私钥 |
| PEM/PKCS#1/#8（RSA/EC） | 是 | `ssh-key` + `pkcs8` |
| PuTTY PPK v2 | 是 | 自研解码：`MAC` 校验（HMAC-SHA1）先验证完整性，再抽 `Private-Lines`；带 passphrase 时用 SHA1 派生（PPK v2 规范） |
| PuTTY PPK v3 | 是 | Argon2id 参数从文件头读取；**上限校验**：`memory ≤ 1GiB`、`passes ≤ 64`、`parallelism ≤ 4`，超出即拒绝（防 Argon2 参数 DoS，见 R-09） |
| PKCS#12 / `.pfx` | 否（明确不支持） | 提示用户用 `openssl pkcs12 -in x.pfx -nodes` 转换 |
| FIDO2/`sk-ssh-ed25519` | 否（本期） | 明确文案"暂不支持安全密钥" |

导入后**统一规范化**为 `ssh-key::PrivateKey`，再按 `auth_kind=publickey` 使用。私钥内容**不复制**到应用数据目录：`CredentialRef.kind=key_file` 只存路径；passphrase 存钥匙串。导入成功后计算公钥指纹并展示，供用户与服务器 `~/.ssh/authorized_keys` 核对。

**agent 兼容层**：`secret/agent.rs` 通过 `russh-keys::agent::client::AgentClient` 连接；Unix 取 `$SSH_AUTH_SOCK`，Windows 依次尝试 OpenSSH agent 命名管道与 Pageant 窗口消息。**只做签名请求，不上传私钥**；agent 不可用时 `agent_list` 返回 `agent_unavailable` 并回退到其他认证方式，不阻塞连接流程。

### 6.3 凭据不出现在日志

| 措施 | 实现 |
|---|---|
| 类型级隔离 | 密码/passphrase 一律 `secrecy::SecretString`；自定义类型 `Secret` 只为脱敏 `Debug`/`Display` 实现（输出 `Secret(***)`） |
| 日志入口收口 | 只允许 `tracing` 宏；CI 中搜索 `println!`、`dbg!`、`eprintln!` 三个宏，命中数必须为 0 |
| 字段脱敏 | `Connection` 的 `Debug` 派生手写：`host` 保留、`username` 保留、其余打码；`CredentialRef` 全字段打码 |
| SSH 报文 | 禁止打印 `ChannelMsg::Data` 原始内容；调试模式只打印长度与前 16 字节十六进制摘要 |
| 崩溃/遥测 | 不采集任何会话内容；`tauri-plugin-log` 落到 `app_log_dir`，权限 0600，单文件 5MB × 3 滚动 |
| 剪贴板 | 不记录；`paste_check` 只统计行数，不落日志 |
| 前端 | 禁止 `console.log` 输出 IPC 全量载荷；`lib/ipc` 统一在 dev 构建下做字段裁剪 |

**自动化门禁**：`tests/security/no_secret_in_logs.rs` 用一个含 `P@ssw0rd!` 的假凭据跑完整连接流程（对本地 sshd 夹具），断言日志目录内所有文件不包含该字符串，也不包含私钥 `BEGIN` 标志。

### 6.4 内存中的敏感数据

- `SecretString` 使用 `zeroize`：`drop` 时覆写；不实现 `Clone`（需要第二份时重新从钥匙串取）。
- 私钥使用 `ssh-key::PrivateKey`（内部 `Zeroizing`）；解析完成后立即丢弃 PEM 中间体，只保留 `PrivateKey`。
- 缓冲策略：认证完成后立即 `drop` 密码对象；`ChannelReader` 的输出缓冲不含凭据（仅终端数据），无需清理；但**screen buffer 属敏感数据**：锁屏/最小化 10 分钟后可选"清屏"（设置项，默认关）。
- 不做 `mlock`（跨平台实现差异大、收益有限）；以"缩短存活时间"为主要手段。已知残留：JVM/JS 堆中的字符串无法可靠清零 → 记为已知弱点 W-05。

### 6.5 已知弱点与缓解

| 编号 | 弱点 | 影响 | 缓解 |
|---|---|---|---|
| W-01 | 首次连接为 TOFU，没有带外验证就无法防 MITM | 高 | 首次信任强制显示指纹并要求勾选"我已核对"；提供"导入 known_hosts"与"指纹比对"模式；企业场景可预置指纹（设置项 `pinned_fingerprints`） |
| W-02 | `russh` 未经 OpenSSH 级别安全审计 | 中 | 锁版本 + `cargo audit` 进 CI；关键算法显式白名单；保留 `ssh2` 后端切换口 |
| W-03 | WebView 内 XSS → IPC 面被滥用（可开 SFTP、读文件） | 高 | 严格 CSP（禁 `unsafe-inline`，仅允许 `self`）；不做远程内容渲染；不做插件/脚本注入；IPC 命令全部做入参校验（路径规范化 + 白名单根目录） |
| W-04 | 剪贴板明文（复制密码/密钥） | 中 | `confirm_always` 粘贴策略；提供"复制后 30s 清空剪贴板"开关（默认关） |
| W-05 | JS 堆字符串无法清零 | 中 | 前端不持有凭据（凭据只存在于 Rust 侧与钥匙串）；密码输入框的值提交后立即置空 |
| W-06 | agent 转发（本期不启用）若被滥用可横向移动 | 中 | 本期不实现 `agent forwarding`，仅本地签名；设置项显式标注"未实现" |
| W-07 | 明文 HTTP CONNECT/SOCKS5 代理可被旁路监听 | 中 | UI 明示"代理链路非加密，仅 SSH 内层加密保护"；支持 SOCKS5 用户名密码时走钥匙串 |
| W-08 | PPK Argon2 参数过大导致 CPU/内存耗尽 | 低 | 6.2 的参数上限校验 + 解析放 `spawn_blocking` + 15s 超时 |

---

## 7. 里程碑 M0–M6

工作量单位为**人日（pd）**，按 1 名熟悉 Rust/Tauri 的全栈 + 1 名前端（M1 起 50%）估算；已含自测，不含评审与返工。总量 64 pd，另留 15% 缓冲（约 10 pd）。

### 依赖与关键路径

```mermaid
graph LR
    M0["M0 骨架+单会话终端 8pd"] --> M1["M1 多标签+会话库 7pd"]
    M1 --> M2["M2 SFTP 单文件 9pd"]
    M2 --> M3["M3 双栏+队列 11pd"]
    M1 --> M4["M4 跳板/代理/密钥 11pd"]
    M3 --> M5["M5 终端对齐 9pd"]
    M4 --> M5
    M5 --> M6["M6 打包签名发布 9pd"]
```

M4 与 M2/M3 可并行（不同人）；M5 依赖 M4 的密钥体系（因为要对齐"认证失败/中断"的终端表现）；M6 的最后一周可与 M5 并行做签名流水线预演。

### M0 · 骨架与单会话终端闭环（8 pd）

**目标**：从零到"输入 IP/用户名/密码 → 出现 shell → 能跑 `top` 不卡、能 Ctrl+C"。

**交付物**
- 可运行的 `pnpm tauri dev` 工程（三平台），CI 三平台 `cargo check` + `cargo test` 绿。
- `ipc/channel.rs` 的合并器 + 信用窗口实现；`ssh/connect.rs` 直连 + 密码认证。
- 终端页：xterm + fit + webgl；最小标签栏（1 个标签）。
- `scripts/bench-ipc.ts` 与首轮基准数据（写入 `docs/bench/ipc-m0.md`）。

**验收标准**
1. 在干净的 Windows 11 / macOS 14 / Ubuntu 22.04 上，按 README 三条命令完成构建，无手工安装除 Rust/Node 外的依赖（Linux 允许 `libwebkit2gtk-4.1-dev` 等 Tauri 官方前置）。
2. 连接本地 sshd 容器（`scripts/dev-sshd.sh` 起 `localhost:2222`），输入正确密码后 ≤ 2s 出现提示符；输入 `echo $TERM` 回显 `xterm-256color`。
3. `top` 连续运行 60s：`term_data` 累计 ≥ 20MB，前端无掉帧（`requestAnimationFrame` 间隔 p95 ≤ 20ms），JS 堆增长 ≤ 30MB（DevTools 采样两次）。
4. 窗口从 120×30 拖到 60×15 再拖回：`stty size` 每次都准确；无花屏，无残留字符（截图对比）。
5. 断开服务器（`docker stop`）→ 5s 内 UI 显示"连接已断开"且不崩溃；重启后点"重试"可恢复。
6. IPC 基准三项达到 3.4 表门槛，或记录"未达标 + 已启用 base64 降级"的结论。
7. `cargo clippy -- -D warnings` 与 `pnpm lint` 均通过。

**依赖**：无。**风险**：WebGL 在 Linux WebKitGTK 上不可用（回退 canvas，性能降 40%）→ 见 R-03 预案。

---

### M1 · 多标签与会话库（7 pd）

**目标**：8 个标签并行不互扰；会话可持久化、可分组、可搜索；崩溃后重开不丢配置。

**交付物**
- `session/manager.rs`（每会话 actor + 注册表）、`db/` 全套 schema + 迁移 v1、会话树 UI、快速连接、`conn_test`。
- 单实例锁 + 窗口状态持久化（尺寸/位置）。

**验收标准**
1. 同时开 8 个标签（其中 2 个连同一主机）：`ps`/任务管理器显示**单进程**；RSS ≤ 400MB；切换标签 ≤ 80ms（DevTools Performance 采样 10 次取 p95）。
2. 关闭标签后对应 `SessionActor` 任务在 3s 内退出（`tokio` 任务计数断言 + 日志 `session actor exited`），无连接泄漏（服务器 `ss -tn | grep 2222` 连接数归零）。
3. 新建/编辑/删除/排序会话后重启应用，树结构与字段逐项一致（表单 12 个字段全比对）。
4. 会话数 500 时，会话树首屏 ≤ 120ms，搜索输入到结果 ≤ 60ms（本地测量，含 200ms 防抖后的纯渲染时间）。
5. `conn_test` 对错误端口返回 `ECONNREFUSED` 映射文案（中文），对错误密码返回"认证失败"，均在 15s 内完成。
6. 迁移测试：用 v1 夹具库启动，`PRAGMA integrity_check` = ok；`user_version` 正确；备份文件生成。
7. 崩溃恢复：`kill -9` 后重启，无半写数据库（WAL 正常回放），会话数量不变。
8. 已开 30 个标签时新建被拒绝，提示"已达上限 30，请先关闭标签"；第 9 个起新标签的 `scrollback` 实际值 = 5000（`terminal.options.scrollback` 断言），已有标签不回改（D4）。

**依赖**：M0。**风险**：多标签内存与 WebGL 上下文数量上限（WebView 对 WebGL context 有硬上限，超过会丢上下文）→ 非活跃标签降级 canvas 渲染，达 `MAX_TABS=30` 拒绝新建，见 R-10。

---

### M2 · SFTP 单文件传输（9 pd）

**目标**：单文件上传/下载可用、可续传、进度准确、失败可诊断。

**交付物**
- `sftp/pool.rs`（4 通道池）、`sftp/ops.rs`（readdir/stat/open/read/write/rename/setstat）、`transfer/job.rs`（单 job 全生命周期）、进度聚合器。
- 远端栏最小 UI：路径输入 + 列表（无虚拟滚动，仅 500 条上限）+ 上传/下载按钮。

**验收标准**
1. 上传 1GB 随机文件到本地 sshd：完成时间 ≤ 25s（LAN，≥ 40MB/s）；`sha256sum` 与源文件一致。
2. 下载同一文件：≥ 40MB/s；校验和一致；`mtime` 与远端一致（`stat -c %Y` 比对）。
3. 传输中 `kill -9` 应用 → 重启后同一文件续传，最终校验和正确，且**不重传前 90% 数据**（用服务器 `sftp-server -l INFO` 日志或 iftop 观察字节数 ≤ 剩余量 × 1.2）。
4. 传输 100 个 1MB 文件：进度面板显示速率稳定（波动 ≤ ±15%），CPU ≤ 25%（单核折算）。
5. 权限拒绝（目标目录 555）→ 3s 内 `failed`，错误码 `SFTP_PERMISSION_DENIED`，中文文案含路径；重试 3 次后停止（日志可见退避间隔）。
6. 服务器断连时 running job 转 `failed` 且 `resume_offset` 保留；重连后可"继续"。
7. 进度事件频率实测 ≤ 4Hz（抓 IPC 事件计数 10s）。

**依赖**：M1（需要会话与 DB）。**风险**：`russh-sftp` 的 `limits@openssh.com` 未实现 → 固定 32KB 请求，吞吐降约 20%（R-06 预案）。

---

### M3 · 双栏管理器与队列（11 pd）

**目标**：本地栏 + 远端栏并排，万级目录可用，拖拽与队列完整。

**交付物**
- `features/sftp/DualPane`、`LocalPane`、`RemotePane`、`useDirStream`；虚拟滚动；书签；`transfer/queue.rs`（优先级/暂停/冲突/batch）。
- 本地文件操作（打开、删除、重命名、新建目录、在系统文件管理器中显示）。

**验收标准**
1. 远端目录 50,000 个文件：进入后 200 条 ≤ 150ms 可见；滚动到底 ≤ 6s；滚动过程帧率 ≥ 50fps（Performance 采样）；内存增量 ≤ 60MB。
2. 本地栏 50,000 条同样达标（使用 `scripts/gen-dir.ps1` 生成夹具）。
3. 从 OS 拖 10 个文件到远端栏：全部入队，文件大小与 `sha256` 正确；拖拽期间 UI 不冻结（可继续操作终端）。
4. 远端→远端复制 500MB：流式（内存增量 ≤ 40MB），完成后源与目标 `mtime` 一致。
5. 队列：设置 job A 优先级 9、B 为 5，两者都在 queued → A 先跑；运行中把 B 升到 9 → B 在下一个分块边界接管通道（日志可见 `yield to higher priority`）。
6. 冲突：目标已存在且策略 `rename` → 生成 `name (1).ext`，原文件不变。
7. 暂停后 `bytes_done` 不再增长（10s 内差值为 0）；恢复后从该偏移继续。
8. 目录上传 1,000 个文件：batch 汇总正确（成功/失败计数之和 = 1,000），"仅重试失败项"生效。
9. 双栏布局在 1024×720 与 2560×1440 下不重叠、不横向滚动（截图比对）。

**依赖**：M2。**风险**：本地栏与远端栏的路径语义差异（Windows 盘符、UNC、大小写）→ `sftp/path.rs` 集中处理，见 R-11。

---

### M4 · 跳板 / 代理 / 密钥体系（11 pd）

**目标**：能连"只能经跳板到达"的内网机；能导入 OpenSSH/PPK 密钥；agent 可用；host key 全流程可审计。

**交付物**
- `ssh/tunnel.rs`（`direct-tcpip` 多跳）、`ssh/transport.rs`（SOCKS5 + HTTP CONNECT）、`secret/{keyfile,ppk,agent,keyring}.rs`、`knownhost/` 完整策略 + 管理页。

**验收标准**
1. 三跳链（本地 → A → B → 目标，全部 sshd 容器）：连通并在目标执行 `hostname` 正确；`ss` 显示所有连接来自 127.0.0.1（链路上无直连目标）。
2. SOCKS5（dante/`gost`）与 HTTP CONNECT（`tinyproxy`）各一条链路：远端 DNS 解析生效（目标主机名只在代理侧可解析时仍能连通）。
3. 导入 OpenSSH ed25519、RSA(PEM)、PPK v2、PPK v3（带 passphrase）：四次均成功认证；指纹展示与 `ssh-keygen -lf` 输出一致。
4. PPK 错误 passphrase → 明确"口令错误"，不泄露密钥内容，日志无密钥片段（6.3 门禁测试通过）。
5. agent：`ssh-add` 加入一个身份后，`agent_list` 可见且能认证；停掉 agent 后连接回退到密钥文件认证，UI 提示"agent 不可用"。
6. host key：首次连接弹窗 → 选"取消"则连接失败且不写库；再连选"永久信任"→ 第二次不再弹窗；服务端换 key 后连接 → 红色告警且**无"永久信任"按钮**。
7. 严格模式关闭 + 已撤销指纹：连接被警告但放行，顶部红条常驻。
8. 所有跳板/代理连接的 keepalive：30s 周期在服务器 `sshd -d` 日志中可见 `keepalive@openssh.com`。
9. `known_hosts` 只读（D5）：导入后与连接后，用户 `~/.ssh/known_hosts` 的 mtime 与内容哈希不变（`stat` + `sha256sum` 前后比对）；导入条目只进自有表。

**依赖**：M1。**风险**：不同代理实现对 SOCKS5 认证方式（0x00/0x02）支持不一；PPK v3 的 Argon2 参数异常 → R-09。Linux 无钥匙串时按 D1 禁用保存密码，不做明文兜底。

---

### M5 · 终端仿真对齐与打磨（9 pd）

**目标**：§4 清单 17 项全绿；交互细节达到"可日常替代 Xshell"。

**交付物**
- addon 全接入（fit/web-links/search/unicode11/clipboard）；键位映射表（mac 的 `Option` 作为 Meta、Windows 的 `Alt` 行为）；主题包（≥6 套）；搜索/复制/粘贴确认 UI；光标形状；OSC 7 cwd 同步到 SFTP 栏。

**验收标准**
1. §4 表格 17 项：14 项由自动化断言（golden 缓冲区比对 / 组件测试 / Playwright），3 项（T05 IME、T07 滚轮、T17 同步输出）由三平台手工记录表 + 录屏归档，全部"通过"。
2. macOS 门禁（D3）：`docs/qa/macos-checklist.md` 42 项全过，截图存入 `docs/qa/macos/v1.1/`；同版本回归截图差异为 0（人工比对记录）。
3. 中文 IME：macOS 自带拼音、Windows 微软拼音、Linux fcitx5 三平台各输入 20 个词，0 次重复提交/丢字（记录表 60 行全通过）。
4. 粘贴 500 行脚本：确认弹窗正确显示行数；选"发送"后 `bash` 收到的行数与内容逐字节一致（用 `cat > /tmp/x` 校验）。
5. `vim` / `htop` / `tmux` / `less` / `mysql` 交互 5 分钟无花屏；tmux 分屏 resize 后边框对齐（截图）。
6. 8 标签 × 6 小时挂机（`top` + `tail -f` 日志）：内存增长 ≤ 80MB，无 WebGL 上下文丢失（`webglcontextlost` 事件计数 0）。
7. 终端输出 10MB 洪峰（`base64 /dev/urandom`）不丢字节：输出重定向到远端文件后 `wc -c` 与预期一致。
8. `prefers-reduced-motion` 与 200% 缩放下布局无溢出（截图比对）。

**依赖**：M4、M3。**风险**：仿真长尾（这是本项目最大返工源）→ R-01。

---

### M6 · 打包 / 签名 / 跨平台发布（9 pd）

**目标**：三平台可下载安装、可自动更新、可回滚。

**交付物**
- `.github/workflows/release.yml`：tag 触发 → 三平台矩阵构建 → 签名 → 公证 → 上传 Release。
- Windows：`msi` + `nsis`，`signtool` 签名 + 时间戳（EV 证书或 Azure Trusted Signing）。
- macOS：`universal` dmg，`codesign --deep --options runtime`，`notarytool submit --wait`，`stapler validate`。
- Linux：`AppImage` + `deb` + `rpm`；`webkit2gtk-4.1` 依赖声明；Flatpak 清单（可选，不阻塞发布）。
- 自动更新：`tauri-plugin-updater` + 独立签名密钥（与代码签名密钥分离），支持"检查-下载-安装-重启"。

**验收标准**
1. 三个干净虚拟机（Win11 / macOS 14 / Ubuntu 22.04）从 Release 页面下载安装包，双击安装 → 启动 → 连接测试主机，全程 ≤ 5 分钟，无安全警告（Windows SmartScreen 不拦、macOS Gatekeeper 通过）。
2. macOS：`spctl -a -vv /Applications/App.app` 输出 `accepted source=Notarized Developer ID`；`codesign -dv --verbose=4` 显示 hardened runtime。
3. Windows：`Get-AuthenticodeSignature` 返回 `Valid`；证书链含时间戳。
4. 升级：v1.0.0 → v1.0.1 通过应用内更新完成，配置与数据库完整保留（会话数与 known_hosts 条数不变）。
5. 卸载：AppData/Roaming 与 `~/Library/Application Support` 下的数据目录保留（不误删用户数据）；提供手动"清除数据"入口。
6. 首次启动冷启动时间：Windows ≤ 2.5s、macOS ≤ 2s、Linux ≤ 3s（`--release` 构建，三次取中位数）。
7. Release 产物体积：Windows ≤ 15MB、macOS dmg ≤ 20MB、AppImage ≤ 25MB。
8. macOS 发布门禁（D3）：`docs/qa/macos-checklist.md` 42 项人工执行完毕，截图归档，执行人签字记录在 Release 说明中。

**依赖**：M5。**风险**：签名/公证的账号与流程审批周期（R-05）→ 必须在 M3 阶段就申请 Apple Developer Program 与 Windows 证书，否则 M6 阻塞。

---

## 8. 测试策略

### 8.1 分层与工具

| 层 | 工具 | 覆盖对象 | 目标 |
|---|---|---|---|
| Rust 单元 | `cargo test` | `sftp/path`、`ppk`、`coalesce`、`fingerprint`、`backoff`、`conflict` | ≥ 80% 行覆盖（这几个模块 ≥ 90%） |
| Rust 集成 | `cargo test --test *` + Docker | 连接/认证/通道/传输/迁移 | 每个里程碑的验收项至少 1 条自动化 |
| 前端单元/组件 | Vitest + Testing Library | pasteGuard、keymap、useDirStream、QueuePanel | 关键交互分支全覆盖 |
| 终端 golden | `@xterm/headless` + 字节夹具 | §4 的 T01/T02/T04/T08/T09/T10/T15/T16 | 屏幕缓冲区逐行比对 |
| E2E | `tauri-driver` + WebdriverIO（Windows/Linux） | 连接→输入→SFTP 上传→断线重连 | 每个里程碑 1 条主路径 |
| 手工 | 记录表 + 录屏 + 截图 | IME、滚轮、同步输出；macOS 42 项清单（D3）；Gatekeeper | 三平台各一份，归档到 `docs/qa/` |

### 8.2 本地 sshd 夹具

`scripts/dev-sshd.sh` 起一个 compose：

- `sshd`：OpenSSH 9.x，暴露 `2222`；建 3 个用户：
  - `alice`：密码认证，home 下预置 50k 文件的 `big/` 目录（由 init 容器生成）。
  - `bob`：仅公钥（测试用 ed25519 密钥随仓库放在 `tests/fixtures/keys/`，仅测试用途）。
  - `carol`：`ChrootDirectory` + 只读 SFTP subsystem（验证权限错误路径）。
- `sshd-b`、`sshd-c`：供跳板链（容器网络内互相可达）。
- `proxy`：`gost` 同时开 SOCKS5(1080) 与 HTTP CONNECT(8080)。
- `evil`：一个伪造 host key 的 sshd（用于验证"指纹变更"告警）。

所有测试用 `testcontainers` 拉起（CI ubuntu runner 原生支持 Docker）；Windows/macOS 开发者本地可 `docker compose up` 后跑 `SKIP_CONTAINERS=1` 的集成测试。

**夹具纪律**：测试**不得**依赖公网；所有传输测试用 `dd` 生成的随机文件，测试结束即删（`/tmp` 清理钩子）。

### 8.3 Rust 集成测试清单（必须存在）

| 测试 | 断言 |
|---|---|
| `connect_password_ok` / `connect_password_fail` | 状态机到 `Ready` / `Failed`；错误码正确 |
| `hostkey_first_trust_flow` | 未信任时挂起等待决策；拒绝后不写库 |
| `hostkey_changed_alarm` | 指纹变更时 `is_changed=true` 且不提供永久信任 |
| `pty_resize_propagates` | 服务端 `stty size` 与请求一致 |
| `channel_backpressure` | 注入 50MB 输出，窗口未超 320KB，ack 后恢复 |
| `sftp_upload_resume` | 中断后续传，最终校验和一致 |
| `sftp_permission_denied` | 映射到 `SFTP_PERMISSION_DENIED` |
| `dir_stream_50k` | 100 次分页取完，条目数精确 50,000，无重复 |
| `migration_v1_to_vN` | 每版本夹具升级成功 + 索引齐全 |
| `no_secret_in_logs` | 日志扫描无凭据/私钥标志 |

### 8.4 终端黄金文件对比

- 夹具格式：`tests/fixtures/term/*.bin`（原始字节）+ `*.expect.txt`（期望屏幕文本，按行）。
- 生成方式：真机跑一次录制（`ssh` 输出 tee 到文件），人工核对后固化为期望值；**期望值必须人工审核过**，不允许"跑一次结果就是标准"。
- 执行：Rust 侧不做任何仿真，把 `.bin` 字节原样喂给 `@xterm/headless` 的 `Terminal`；`write` 后 `await` 写队列空闲，再取 `buffer.active` 逐行 `translateToString(true)` 与 `.expect.txt` 比对。
- 差异输出：首个不一致的 `(row, col)` + 上下文 3 行，便于定位。
- 覆盖：T01/T02/T04/T08/T09/T15/T16 各自的字节序列；再加 3 个"真实场景"夹具（`htop` 一帧、`vim` 打开文件一帧、`tmux` 分屏一帧）。

### 8.5 端到端冒烟（每次 PR 必跑，≤ 6 分钟）

1. 启动应用（`--test-mode`，跳过钥匙串用内存假实现）。
2. 连接夹具 sshd → 等提示符 ≤ 3s。
3. 输入 `echo SMOKE_OK` → 屏幕出现 `SMOKE_OK`。
4. 打开 SFTP → 列出 `/home/alice` → 上传 10MB 文件 → 远端 `sha256` 一致。
5. 断开容器 → UI 显示断开 → 重启容器 → 点重试 → 提示符恢复。
6. 截图存档为 CI 产物。

### 8.6 CI 矩阵

| 维度 | 配置 |
|---|---|
| OS | `windows-2022`、`windows-11-arm`（若可用，否则标 skip）、`macos-14`(arm64)、`macos-13`(x64)、`ubuntu-22.04`、`ubuntu-24.04` |
| Rust | stable（锁 `rust-toolchain.toml`），`cargo fmt --check`、`clippy -D warnings`、`cargo audit` |
| 前端 | `pnpm lint`、`tsc --noEmit`、`vitest run --coverage` |
| 集成 | 仅 ubuntu runner（Docker 可用）；其余平台跑单元 + 编译 |
| 打包 | tag 时跑 `tauri build` 全矩阵，PR 时仅 `ubuntu` 出 debug 包验证可构建 |
| 缓存 | `Swatinem/rust-cache`、`pnpm store`；目标：冷缓存 ≤ 18 分钟，热缓存 ≤ 7 分钟 |

**准入线**：`main` 分支保护要求 "CI 全绿 + 覆盖率不低于基线 -1%"；发布 tag 要求 "M6 验收清单 7 项全勾"。

---

## 9. 风险清单（按 影响×可能性 降序）

影响/可能性取值：高=3、中=2、低=1，分值为乘积。

| # | 风险 | 影响 | 可能性 | 分值 | 触发信号（可观测） | 预案 |
|---|---|---|---|---|---|---|
| R-01 | 终端仿真长尾返工（宽字符/IME/滚动/交替屏组合场景） | 高 | 高 | 9 | M5 前两周 golden 失败率 > 15%；用户报"vim 花屏"类 issue 每周 > 3 | ① M2 起每周跑一次 golden 全量，不等 M5 集中对齐；② 把 §4 拆成"必过 12 项"与"尽力 5 项"，必过项不达标不发布；③ 预留 5 pd 专项缓冲；④ 必要时引入 `@xterm/headless` 做"前端仿真 vs 服务端 tmux 捕获"的差分测试定位 |
| R-02 | SFTP 大目录卡顿 / 内存暴涨 | 中高 | 高 | 6 | 50k 目录首屏 > 500ms；滚动掉帧 < 40fps；RSS 增量 > 100MB | ① 目录加载上限 20 万 + 虚拟列表强制开启；② 关闭符号链接批量 `lstat`（改为懒加载）；③ 极端场景提供"精简模式"（只显示名称/大小，不解析权限）；④ 5.3 的分页参数可运行时下调到 200 |
| R-03 | WebView 差异（WebGL 不可用、字体渲染、IME 行为、postMessage 性能） | 高 | 中 | 6 | Linux 上 `webglcontextlost`；中文输入重复提交；macOS `Option` 键位异常；IPC 吞吐 < 5MB/s | ① WebGL 失败自动回退 canvas（`renderer` 探测 + 用户可强制）；② 三平台每周一次真机冒烟（`docs/qa/weekly.md`）；③ IPC 走 base64 降级开关（3.4）；④ 键位表按平台静态配置，不做运行时猜测 |
| R-04 | Linux 无 secret-service（无 DBus、WSL、纯 SSH 环境） | 中 | 高 | 6 | `secret_probe` 返回 `none` | **已决策（D1）**：不落明文，禁用"保存密码"、仅本次会话内存保存、优先引导 ssh-agent、提示安装 `gnome-keyring`/`kwallet`；启动探测 + UI 明示 |
| R-05 | 代码签名与公证的成本/周期（Apple 年费、Windows EV 证书审核、企业审批） | 高 | 中 | 6 | M3 结束仍未拿到证书；`notarytool` 返回 `Invalid`（缺 hardened runtime/entitlements） | ① M1 就启动证书申请（关键路径外的前置任务）；② 先用 ad-hoc 签名保证内部可用，发布前再替换；③ macOS 预留 `entitlements.plist`（network client + 用户选择文件）；④ 若 Windows 证书未到，先发"未签名 + 安装说明"，并把自动更新延后 |
| R-06 | `russh` 算法/协议覆盖不足（老服务器只支持 `diffie-hellman-group14-sha1`、`ssh-rsa`） | 中高 | 中 | 6 | 连接失败日志 `no common algorithm`；用户报告特定型号设备连不上 | ① 抽象 `SshBackend` trait（M0 就留接口，1 天成本）；② 维护"已知不兼容清单"，允许用户按连接覆盖算法；③ 极端情况启用 `ssh2` 后端（+6 pd）；④ 明确不支持 SHA-1 类算法时给出可读文案而非静默失败 |
| R-07 | IPC 大流量抖动（终端洪峰 + 传输进度叠加） | 中 | 中 | 4 | 输入延迟 p95 > 40ms；进度事件 > 8Hz；`terminal_ack` 超时告警 | ① 3.4 三项基准进门禁；② 进度聚合固定 4Hz；③ 终端帧上限 32KB，超长行强制切分；④ 传输与终端共用 runtime 时限制 SFTP worker 数 |
| R-08 | 断线重连后状态不一致（半开通道、重复 shell、cwd 丢失） | 中 | 中 | 4 | 重连后出现两个提示符；`ps` 有孤儿 shell；cwd 回到 home | ① 重连前显式 `close` 所有通道并等 `Eof`；② 服务端 `ClientAliveInterval` 与本地 keepalive 双保险；③ cwd 恢复仅对 bash/zsh 且校验路径存在；④ 集成测试 `reconnect_no_orphan_shell` |
| R-09 | PPK/密钥兼容长尾（PPK v3 Argon2 参数异常、加密 PEM、超长 comment） | 低中 | 中 | 4 | 导入失败率 > 10%（内部测试集）；解析耗时 > 3s | ① 参数上限校验 + 15s 超时（6.2）；② 失败文案给出"用 `ssh-keygen -p -f` 转换后重试"；③ 维护 20 个真实样本的导入回归集（含 4 个损坏文件） |
| R-10 | 多标签 WebGL 上下文耗尽 / 内存膨胀 | 中 | 中 | 4 | 第 9 个标签白屏；`webglcontextlost` 事件；RSS > 600MB | **上限已定（D4，`MAX_TABS=30`）**：① 非活跃标签自动切 canvas；② >8 标签时新标签 `scrollback` 降为 5000；③ 达 30 拒绝新建并提示 |
| R-11 | 路径语义差异（Windows 盘符/UNC/大小写、远端 POSIX） | 中 | 中 | 4 | 上传到 `C:\` 失败；同名不同大小写被覆盖 | ① 路径处理集中 `sftp/path.rs` 并有单测（> 30 例）；② 本地路径一律 `PathBuf`，远端一律 POSIX 字符串，禁止互转；③ 冲突检测在远端做大小写敏感 `stat` |
| R-12 | 大文件传输的磁盘/内存占用（本地临时 `.part` 与远端配额） | 低 | 低 | 1 | 磁盘剩余 < 2×文件大小；远端 `No space left` | ① 入队前预检可用空间（本地 `fs2` 查询，远端 `statvfs`）；② 空间不足直接 `failed` 并提示所需空间 |

---

## 10. 首个两周冲刺任务清单（M0）

**节奏**：Day 1–2 脚手架与基准；Day 3–6 连接与通道；Day 7–8 终端接入；Day 9–10 加固与验收。每周五下午做一次"验收项逐条过"（对着 M0 的 7 条打勾，未过项进下周）。

### 第 1 周

- [ ] **S1.1 工程脚手架**：`pnpm create tauri-app`（React-TS 模板）→ 目录按 §1.5 重整；`rust-toolchain.toml` 锁定；`src-tauri/Cargo.toml` 加入 `russh`、`russh-sftp`、`portable-pty`、`rusqlite(bundled)`、`keyring`、`secrecy`、`zeroize`、`tokio(rt-multi-thread, sync, time)`、`tracing`。
  **验收**：`cargo check` 三平台 CI 绿；`pnpm tauri dev` 出窗口；`cargo clippy -D warnings` 通过。
- [ ] **S1.2 IPC 骨架**：`ipc/error.rs`（AppError + 12 个稳定错误码）、`ipc/dto.rs`（`StreamMsg`、`ConnState`）、`ipc/channel.rs`（合并器 + 信用窗口 + `EncodingMode` 开关）。
  **验收**：单测覆盖合并器三种 flush 条件（达 32KB / 达 8ms / EOF）；信用窗口在 ack 缺失时 5s 触发降窗（单测用 `tokio::time::pause`）。
- [ ] **S1.3 IPC 基准**：`scripts/bench-ipc.ts` + Rust 侧假数据命令（发 200MB 随机字节）。
  **验收**：三平台各跑一次，产出吞吐/延迟/CPU 三项数据写入 `docs/bench/ipc-m0.md`；据此确定 `EncodingMode` 默认值并在 ADR-02 追加结论。
- [ ] **S1.4 sshd 夹具**：`scripts/dev-sshd.sh` + `docker-compose.yml`（alice/bob/carol + 50k 目录 + 伪造 host key 容器）。
  **验收**：`docker compose up -d` 后 `ssh -p 2222 alice@localhost` 可登录；`sftp` 可列目录；`scripts/dev-sshd.sh --verify` 自检 6 项全过。
- [ ] **S1.5 直连 + 密码认证**：`ssh/connect.rs`、`ssh/handler.rs`（先只做 `AcceptAll`，host key 待 S2.2）、`ssh/auth.rs`（password）。
  **验收**：`cargo test connect_password_ok` 对夹具通过；错误密码返回 `AUTH_FAILED`；连接耗时 ≤ 2s（本地）。
- [ ] **S1.6 会话 actor 最小版**：`session/actor.rs`（`Open/Close` 消息、状态机骨架、任务句柄表）。
  **验收**：`terminal_close` 后任务在 3s 内退出（日志断言）；重复 close 幂等。

### 第 2 周

- [ ] **S2.1 shell 通道 + PTY 请求**：`channel_open_session` + `request_pty("xterm-256color", cols, rows)` + `shell`；`terminal_input/resize/ack` 命令。
  **验收**：`echo $TERM` → `xterm-256color`；`stty size` 与请求一致；输入 100KB 数据无丢失（回显计数比对）。
- [ ] **S2.2 host key 校验（最小闭环）**：`knownhost/fingerprint.rs` + `knownhost/policy.rs`；首次连接发 `hostkey_verify_request` 并阻塞等待 `knownhost_answer`；`AcceptAll` 移除。
  **验收**：拒绝后连接失败且不写库；接受后第二次连接不弹窗（用内存 repo 版）。
- [ ] **S2.3 终端页**：`TerminalPane.tsx` + `useTerminal.ts`；xterm + fit + webgl + `unicode11`；`StreamMsg` 消费与 ack 回传；深色主题 1 套。
  **验收**：交互式 `bash` 可用（ls/vim/top 不出花屏）；`cat` 10MB 文本无丢字节（`wc -c` 比对）；中文显示正常。
- [ ] **S2.4 断线与重连**：`session/reconnect.rs`（退避 1→30s、8 次、抖动）；`conn_state` 事件与 UI 提示条；`reconnect` 命令。
  **验收**：`docker stop` 后 5s 内 UI 提示断开；`docker start` 后自动重连成功并插入重连提示行；无孤儿 shell（服务端 `ps -u alice` 无残留）。
- [ ] **S2.5 崩溃与日志**：panic hook、`tracing` 落盘（0600、5MB×3）、脱敏层；`tests/security/no_secret_in_logs.rs`。
  **验收**：日志目录内无 `P@ssw0rd!` 字样；注入 panic 后应用重启正常，日志含 backtrace。
- [ ] **S2.6 M0 验收冲刺**：逐条过 M0 的 7 条验收标准；补 README（三条命令构建）；产出 `docs/bench/ipc-m0.md` 与 `docs/qa/m0-checklist.md`。
  **验收**：7 条全绿并附证据（截图/终端输出/性能数字）；未过项写入 M1 风险清单。

---

## 附录 A · 关键常量（集中定义在 `src-tauri/src/config.rs`，禁止散落魔法数）

| 常量 | 值 | 说明 |
|---|---|---|
| `TERM_COALESCE_BYTES` | 32 KiB | 合并阈值 |
| `TERM_COALESCE_MS` | 8 | 合并超时 |
| `TERM_WINDOW_BYTES` | 256 KiB | 每标签信用窗口 |
| `TERM_PERMIT_BYTES` | 8 KiB | 单 permit 粒度 |
| `TERM_ACK_TIMEOUT_MS` | 5000 | 触发降窗 |
| `SFTP_CHANNELS` | 4 | 每连接通道数 |
| `SFTP_REQ_BYTES` | 64 KiB（默认上限，按 server limits 收紧） | 协议请求 |
| `SFTP_CHUNK_BYTES` | 256 KiB | 分块/续传单位 |
| `SFTP_PIPELINE` | 2 | 每通道在途请求 |
| `SFTP_MAX_JOBS_PER_CONN` | 2 | 传输并发 job |
| `DIR_PAGE` | 500 | 目录分页 |
| `DIR_STREAM_TTL_MS` | 90000 | 目录流句柄存活 |
| `PROGRESS_HZ` | 4 | 进度事件频率 |
| `KEEPALIVE_MS` | 30000 | 心跳 |
| `RECONNECT_BACKOFF` | 1,2,4,8,16,30 | 秒，±20% 抖动 |
| `RESIZE_DEBOUNCE_MS` | 60 | resize 合并 |
| `DB_FLUSH_BYTES` | 8 MiB | `bytes_done` 落库 |
| `DIR_MAX_ENTRIES` | 200000 | 单目录加载上限 |
| `MAX_TABS` | 30 | 标签硬上限（D4） |
| `SCROLLBACK_DEGRADE_TABS` | 8 | 超过该标签数，新标签 `scrollback` 降为 5000 |

## 附录 B · 稳定错误码

`AUTH_FAILED`、`AUTH_CANCELED`、`HOSTKEY_UNKNOWN`、`HOSTKEY_CHANGED`、`HOSTKEY_REVOKED`、`NET_TIMEOUT`、`NET_REFUSED`、`NET_DNS`、`PROXY_FAILED`、`PROXY_AUTH_FAILED`、`AGENT_UNAVAILABLE`、`KEY_PARSE_FAILED`、`KEY_PASSPHRASE_WRONG`、`KEY_PARAM_TOO_LARGE`、`KEYCHAIN_UNAVAILABLE`、`SFTP_PERMISSION_DENIED`、`SFTP_NOT_FOUND`、`SFTP_NO_SPACE`、`SFTP_PROTOCOL`、`SFTP_CONFLICT`、`CHANNEL_CLOSED`、`DB_MIGRATION_FAILED`、`DB_BUSY`、`INTERNAL`。

前端按 `code` 做 i18n 文案映射，**不得**按 `message` 文本判断。

## 附录 C · 已定稿决策记录（D1–D5）

以下 5 项已于 2026-11-04 定稿，不再作为待议项；变更需走 ADR 追加，不得在实现中私自偏离。

### D1 · 凭据存储：Linux 不落明文

**决策**：只支持系统钥匙串（Windows Credential Manager / macOS Keychain / Linux secret-service）。Linux 无 DBus 或 secret-service 时：① `secret_probe` 返回 `none`；② 禁用"保存密码"复选框并说明原因；③ 允许"仅本次会话"（存内存，随 tab 关闭即失）；④ 优先引导使用 ssh-agent 公钥认证；⑤ UI 给出安装指引（`gnome-keyring` 或 `kwallet` + `libsecret`）。**不实现自建加密文件兜底。**

**理由**：自建加密文件等于把密钥管理责任搬到应用侧（KDF 参数、密钥轮换、备份泄露面），安全收益为负；且与"凭据不落自有密文"基线冲突。

**影响**：R-04 变为"已决策缺陷"而非风险；`keychain_unavailable` 成为一等错误码；M0 需实现 `secret_probe` 桩（真实钥匙串读写推迟到 M4）；Linux CI 需断言"无 secret-service 时不写入任何磁盘文件"。

### D2 · 终端编码：本期只支持 UTF-8

**决策**：`TerminalProfile.encoding` 保留字段但仅接受 `utf-8`；非 UTF-8 输入在导入/校验时直接拒绝（不静默回退）。`terminal/encoding.rs` 只留 trait 与恒等实现作为扩展点。

**理由**：GBK 需双向转码 + 宽度表差异，收益仅覆盖极少数老系统，成本与 T04/T05 的黄金测试冲突。

**影响**：§2.1 `encoding` 说明改为"仅 utf-8；扩展点预留"；M5 不做编码相关用例；`terminal/encoding.rs` 保留 `<10 个 trait 方法` 的空实现，后续接入 `encoding_rs` 不需改调用方。

### D3 · macOS 验证策略：手工清单 + 截图回归

**决策**：macOS 不做自动化 E2E（tauri-driver 不支持 WKWebView）。发布门禁改为：`docs/qa/macos-checklist.md` 固定 42 项手工清单（连接/输入/resize/IME/粘贴/拖拽/更新），每项附截图，版本对比用 `docs/qa/macos/{version}/` 目录做**截图回归**（人工比对差异）。

**理由**：为 WKWebView 引入 AppleScript/AX 驱动成本 > 收益，且脆弱。

**影响**：M5/M6 验收中 macOS 项以清单为准；CI 的 `macos-14` 仅做编译 + 单元测试 + golden（headless 不受 WKWebView 限制）；发布前必须有 1 名人工执行清单并签字。

### D4 · 标签上限：软上限 30

**决策**：硬上限 30 个标签。达到 30 时禁止新建并提示"请先关闭标签"。非活跃标签一律降级 canvas 渲染；标签数 > 8 时 `scrollback` 实际生效值降为 5000（仅对新开标签生效，已有标签不回改）。

**理由**：WebGL 上下文与内存随标签线性增长，30 已覆盖真实使用峰值（典型用户 ≤ 12）。

**影响**：§附录 A 增加 `MAX_TABS = 30`；R-10 的"上限 32"改为 30；M1 验收增加"第 31 个标签被拒绝且有明确提示"。

### D5 · known_hosts：只读不写

**决策**：不读 `~/.ssh/known_hosts` 作为信任源；仅提供一次性"导入"（导入时逐条确认并写入自有 `known_host` 表）。**永不回写**用户的 `~/.ssh/known_hosts`。

**理由**：共享信任源会让"首次信任"退化为静默接受，且回写会污染用户其他 SSH 工具的信任状态。

**影响**：§6.1 的存储段落定稿；M4 验收第 6 条保持；新增一条验收：`known_hosts` 文件 mtime 在导入/连接后不变（`stat` 比对）。

