# Shellora

Shellora 是一个跨平台 SSH 终端与 SFTP 双栏文件管理器，基于 Tauri 2 + React + Rust 构建。

当前版本：**1.1.2**（版本号规则见 [docs/VERSIONING.md](docs/VERSIONING.md)）

## 下载与安装

每个版本都发布 Windows / macOS / Linux 三平台产物，见 [Releases](https://github.com/yunyu697/shellora/releases/latest)。

| 平台 | 产物 | 说明 |
|---|---|---|
| Windows x64 | `Shellora_<ver>_x64-setup.exe`、`Shellora_<ver>_x64_en-US.msi` | NSIS 按用户安装 / MSI；自带 WebView2 引导安装 |
| macOS（Universal） | `Shellora_<ver>_universal.dmg` | 同时包含 arm64 与 x86_64，另附 `.app.tar.gz` |
| Linux x64 | `Shellora_<ver>_amd64.AppImage`、`Shellora_<ver>_amd64.deb`、`Shellora-<ver>-1.x86_64.rpm` | AppImage 免安装；deb/rpm 走系统包管理器 |

同目录附 `SHA256SUMS.txt` 与 `manifest-<ver>.json`（全平台产物的字节数、SHA-256 与构建来源）。

## 功能范围

- **SSH 终端**：多标签会话、密码 / 私钥 / SSH Agent 认证、跳板链、SOCKS5 / HTTP CONNECT 代理、已知主机指纹校验。
- **SFTP 双栏工作站**：远程与本地双窗格、可交换方向、面包屑导航、多选与框选、拖拽复制。
- **传输队列**：文件与递归目录传输、进度、暂停 / 继续 / 取消，冲突时覆盖 / 跳过 / 重命名三选。
- **可折叠终端**：Files 屏默认收起，按需展开为上下分栏，队列区自动压缩。
- **会话栏**：可折叠为窄图标栏，`Ctrl+B` / `Cmd+B` 快速切换；展开时定位当前会话并高亮。
- **主题**：浅色 / 深色设计令牌主题，无写死颜色，状态持久化。
- **更新**：内置 Tauri Updater 检查、下载、签名校验与重启安装（发布侧需配置签名密钥）。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2 |
| 前端 | React 18 + TypeScript + Vite 5 |
| 终端 | xterm.js（fit / WebGL / ack 流控） |
| 后端 | Rust、russh、rusqlite |
| 包管理 | pnpm |

## 构建

前置：Rust 1.85+（Windows 需 MSVC Build Tools 与 WebView2）、Node 20+、pnpm；Linux 还需 Tauri 官方系统依赖（`libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev` 等）。

```bash
pnpm install
pnpm tauri dev          # 开发
pnpm tauri build        # 打包（NSIS / MSI / dmg / AppImage / deb / rpm，取决于平台）
```

本地 SSH 夹具（可选）：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --features fixture --bin fixture_sshd
# 127.0.0.1:2222，账号 alice / secret
```

## 校验

```bash
pnpm tsc --noEmit
pnpm vitest run
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm build
```

CI 在 Ubuntu / Windows / macOS 三平台运行上述检查；发布由 `v*` tag 触发的 `.github/workflows/release.yml` 完成。

### 应用内更新的发布配置

更新源为 `https://github.com/yunyu697/shellora/releases/latest/download/latest.json`，公钥写在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。发布时在仓库 Secrets 中配置：

| Secret | 说明 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `tauri signer generate` 生成的私钥文件内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设置的密码 |

配置后，tag 构建会生成带签名的 updater 产物，并由 `scripts/updater-manifest.mjs` 汇总为 `latest.json` 一起发布。未配置 Secrets 时构建仍可完成，但不会生成真实升级通道。私钥只保存在本地/Secrets，不入库。

## 已知限制

- **Windows x86（32 位）不支持**，仅提供 x64 构建。
- **三平台产物均未做代码签名**（未配置证书），表现分别是：
  - Windows：NSIS / MSI 未做 Authenticode 签名，SmartScreen 会提示「Windows 已保护你的电脑」，需点「更多信息 → 仍要运行」。
  - macOS：`.dmg` 未签名、未公证，Gatekeeper 提示「无法验证开发者」。首次需右键 →「打开」，或执行 `xattr -dr com.apple.quarantine /Applications/Shellora.app`。Apple Silicon 用户若不希望跑 Rosetta，请使用 universal 包（同时含 arm64 与 x86_64）。
  - Linux：`.deb` / `.rpm` / `.AppImage` 均未做仓库签名。AppImage 需要 FUSE（Ubuntu 22.04+ 装 `libfuse2`，或加 `--appimage-extract-and-run` 运行）；`deb`/`rpm` 依赖 `webkit2gtk-4.1`、`libgtk-3-0`、`libayatana-appindicator3`，发行版版本过旧时请用 AppImage。
- 自动更新依赖发布侧签名密钥与 `latest.json`，未配置 Secrets 时不会启用真实升级通道。
- 仅支持 SSH / SFTP，不含 SCP、FTP、WebDAV 等其他协议。
- 未提供团队协作、同步设置或云端会话库；会话数据保存在本机。

## 安全说明

- 密码不写入会话库；私钥由用户指定路径读取，应用不复制私钥。
- 首次连接需确认主机指纹，指纹变更会被阻断并提供手动删除信任记录的入口。
- 应用不写入系统 `~/.ssh`，已知主机记录保存在应用自有数据目录。

## 许可证

见 [LICENSE](LICENSE)。第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
