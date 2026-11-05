# Shellora

跨平台 SSH 终端 + SFTP 双栏管理器。架构与里程碑见 [docs/ARCHITECTURE_AND_MILESTONES.md](docs/ARCHITECTURE_AND_MILESTONES.md)。

## 前置

- Rust 1.85+（含 MSVC 构建工具；Windows 需 WebView2 运行时，Win11 自带）
- Node 20+ 与 pnpm
- Linux 额外需要 Tauri 官方前置（`libwebkit2gtk-4.1-dev` 等）
- Windows 需 `cargo` 的 link.exe（VS Build Tools 的 “使用 C++ 的桌面开发”）

## 三条命令（开发）

```powershell
pnpm install
cargo run --manifest-path src-tauri/Cargo.toml --features fixture --bin fixture_sshd   # 终端 A：本地 SSH 夹具，127.0.0.1:2222
pnpm tauri dev                                                      # 终端 B：启动应用
```

应用内默认连接 `127.0.0.1:2222`，夹具账号 `alice` / `secret`。

> M0 不依赖 Docker/WSL：`fixture_sshd` 是进程内的 russh 服务（`src-tauri/src/bin/fixture_sshd.rs`），
> 支持 pty、resize、逐字符回显，以及 `echo $TERM`、`stty size`、`exit`。
> `scripts/dev-sshd.sh` / `scripts/dev-sshd.ps1` 是它的薄封装，等价于上面的 `cargo run`。

## 校验

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --features fixture --lib --tests   # 单测 + SSH 端到端
cargo clippy --manifest-path src-tauri/Cargo.toml --features fixture --all-targets -- -D warnings
pnpm lint && pnpm build
```

## 目录

- `src-tauri/src/`：`ssh/`（连接与认证）、`session/`（每标签 actor）、`terminal/`（合并器与信用窗口）、
  `ipc/`（命令与 DTO）、`secret/`（钥匙串探测）、`sftp/`、`knownhost/`（M2/M4 落地）
- `src/features/terminal/`：`useTerminal`（xterm + fit + WebGL + ack）与 `TerminalPane`
- `src/lib/ipc/`：唯一 Rust 交互出口（`types.ts` 与 `dto.rs` 一一对应）
- `scripts/`：`bench-ipc.ts`（IPC 基准）、`dev-sshd.*`（夹具启动）
