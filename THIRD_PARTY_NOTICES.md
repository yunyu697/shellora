# 第三方声明 / Third-Party Notices

本仓库自身代码以 [MIT](LICENSE) 许可发布。安装包内含或运行时依赖的第三方组件如下。

## 运行时分发组件（Rust）

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| [Tauri](https://github.com/tauri-apps/tauri) | 2.12.5 | MIT OR Apache-2.0 | 桌面壳与 IPC |
| [tauri-plugin-opener](https://github.com/tauri-apps/plugins-workspace) | 2.7.2 | MIT OR Apache-2.0 | 打开外部链接 |
| [tauri-plugin-updater](https://github.com/tauri-apps/plugins-workspace) | 2.x | MIT OR Apache-2.0 | 应用内更新（minisign 校验） |
| [tauri-plugin-process](https://github.com/tauri-apps/plugins-workspace) | 2.x | MIT OR Apache-2.0 | 更新后重启 |
| [russh](https://github.com/Eugeny/russh) | 0.49.2 | Apache-2.0 | SSH 传输/认证 |
| [russh-sftp](https://github.com/Eugeny/russh) | 3.0.1 | Apache-2.0 | SFTP 协议 |
| [ssh-key](https://github.com/RustCrypto/SSH) | 0.6.7 | Apache-2.0 OR MIT | 主机密钥解析与指纹 |
| [portable-pty](https://github.com/wez/wezterm) | 0.9.0 | MIT | 本地 PTY（终端会话） |
| [rusqlite](https://github.com/rusqlite/rusqlite) | 0.40.2 | MIT | 连接/会话持久化（内置 SQLite） |
| [secrecy](https://github.com/iqlusioninc/crates) | 0.10.3 | Apache-2.0 OR MIT | 密钥内存保护 |
| [zeroize](https://github.com/RustCrypto/utils) | 1.8.2 | Apache-2.0 OR MIT | 敏感内存清零 |
| [tokio](https://github.com/tokio-rs/tokio) | 1.53.3 | MIT | 异步运行时 |
| [serde](https://github.com/serde-rs/serde) / [serde_json](https://github.com/serde-rs/json) | 1.0.x | MIT OR Apache-2.0 | 序列化 |
| [uuid](https://github.com/uuid-rs/uuid) | 1.20.0 | Apache-2.0 OR MIT | 会话 ID |
| [md5](https://github.com/stainless-steel/md5) | 0.7.0 | Apache-2.0/MIT | SFTP 主机密钥 MD5 指纹 |
| [data-encoding](https://github.com/ia0/data-encoding) | 2.9 | MIT | Base64 编解码 |
| [futures-util](https://github.com/rust-lang/futures-rs) | 0.3.34 | MIT OR Apache-2.0 | 异步工具 |
| [async-trait](https://github.com/dtolnay/async-trait) | 0.1.92 | MIT OR Apache-2.0 | 异步 trait |
| [thiserror](https://github.com/dtolnay/thiserror) | 2.0.21 | MIT OR Apache-2.0 | 错误类型 |
| [tracing](https://github.com/tokio-rs/tracing) / tracing-subscriber | 0.1.44 / 0.3.23 | MIT | 日志 |
| [rand_core](https://github.com/rust-random/rand) | 0.6 | MIT OR Apache-2.0 | 随机数 |

Rust 侧的**全部传递依赖**（含每个 crate 的 license 表达式）由 `cargo metadata` 生成，见
[`docs/deps-licenses.txt`](docs/deps-licenses.txt)（566 个包）。重新生成：

```powershell
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 |
  ConvertFrom-Json | ForEach-Object { $_.packages } |
  Sort-Object name -Unique | ForEach-Object { "{0} :: {1}" -f $_.name, $_.license } |
  Out-File -Encoding utf8 docs/deps-licenses.txt
```

## 前端依赖

| 组件 | 版本 | 许可 |
|---|---|---|
| [@xterm/xterm](https://github.com/xtermjs/xterm.js) | 5.5.0 | MIT |
| @xterm/addon-fit / web-links / search / unicode11 / clipboard / webgl | 见 `package.json` | MIT |
| [React](https://github.com/facebook/react) / react-dom | 18.3.1 | MIT |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | 2.x | MIT OR Apache-2.0 |
| @tauri-apps/plugin-opener | 2.7.2 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-updater / plugin-process | 2.x | MIT OR Apache-2.0 |

构建期工具（vite、typescript、vitest 等）不随产物分发。

## WebView2（Windows）

- 策略：`bundle.windows.webviewInstallMode = { type: "downloadBootstrapper", silent: true }`。
- 含义：安装包**不内嵌** WebView2 运行时，安装时由 NSIS 调用微软 Evergreen Bootstrapper
  （需联网）静默安装/升级；Windows 11 与多数 Windows 10 已预装，此时为快速 no-op。
- 许可：WebView2 Runtime 由 Microsoft 依据
  [Microsoft Edge WebView2 Runtime 分发条款](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)
  提供，不适用本项目 MIT 许可；用户安装运行时即接受微软条款。
- 离线/受控内网备选：改为 `{ "type": "offlineInstaller" }`（安装包增大）或
  `{ "type": "fixedRuntime", "path": "..." }`（固定版本）；当前未采用。

## 系统组件

- **Linux**：依赖发行版提供的 `webkit2gtk-4.1`、GTK3（LGPL-2.1+）、`libayatana-appindicator`。
  这些库由系统包管理器安装，不随本项目二进制分发。
- **macOS**：使用系统 WKWebView（随 macOS 提供）。
- **SQLite**：通过 `rusqlite` 的 `bundled` 特性静态编译（SQLite 为 Public Domain）。

## 许可文本

MIT / Apache-2.0 全文见各上游仓库；发行时可将 `LICENSE` 与本源文件一并放在安装目录。
