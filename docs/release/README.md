# 发布说明（M6）

版本：v1.0.0 · 平台：Windows x64（本机构建）、macOS universal / Linux x64（CI 脚本就绪，**未构建**）

## 1. 版本号来源

唯一来源是 [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml) 的 `version`（二进制内用
`env!("CARGO_PKG_VERSION")`）。`package.json` 与 `src-tauri/tauri.conf.json` 必须一致，
由 `node scripts/check-version.mjs` 在打包前校验（CI 同样执行）。

## 2. Windows 产物

| 文件 | 说明 |
|---|---|
| `Shellora_1.0.0_x64-setup.exe` | NSIS，`currentUser` 安装（`%LOCALAPPDATA%\Shellora`），**不触发 UAC** |
| `Shellora_1.0.0_x64_en-US.msi` | WiX MSI（perMachine，`C:\Program Files\Shellora`，静默安装需管理员） |

生成：

```powershell
./scripts/build-release.ps1        # 校验版本 -> nsis+msi -> SHA-256 清单
```

安装/卸载为静默模式：`setup.exe /S`、`uninstall.exe /S`。安装包内**不含**开发夹具
`fixture_sshd.exe`（Cargo `fixture` feature 隔离），冒烟脚本会断言这一点。

### 2.1 冒烟结果（本机，Windows）

`powershell -File scripts/smoke-windows.ps1`（全程隐藏窗口、子进程 BelowNormal、无定时任务）。

**28/28 PASS**（NSIS 17 项 + MSI 11 项），原始记录见 [smoke-windows.log](smoke-windows.log)。

- **NSIS**（currentUser，无需管理员）：`setup.exe /S` → HKCU 卸载项 → `%LOCALAPPDATA%\Shellora` 与
  `shellora.exe` → 不含 `fixture_sshd.exe` → `--version=Shellora 1.0.0` → `--health-check` ok →
  开始菜单与桌面快捷方式存在 → `uninstall.exe /S` → 目录、卸载键、两个快捷方式全部清除 →
  `%APPDATA%\com.shellora.desktop` 数据保留。
- **MSI**（`InstallScope=perMachine`，需管理员令牌）：`msiexec /i ... /qn /norestart` → HKLM 卸载键
  `{B585ABA8-C937-4C2B-B60D-A2BA1AABA17C}` → `C:\Program Files\Shellora\shellora.exe` → 开始菜单快捷方式 →
  `msiexec /x {B585ABA8-...} /qn` → 目录 / 卸载键 / 快捷方式全部清除。
- 提权方式：脚本自身不提权；MSI 段需由调用方以管理员身份运行（本机 UAC 策略为「不提示直接提升」，
  未弹出 UAC 窗口，也未要求交互）。
- MSI 包内容旁证（静态查表 + 免提权 `msiexec /a` 解包）：`ALLUSERS=1`、`INSTALLDIR=ProgramFiles64Folder\Shellora`、
  Programs 下开始菜单项与桌面项、`shellora.exe`（无夹具），解包后 `--version` / `--health-check` 均正常。

### 2.1.1 进程优先级与窗口约束

- `scripts/build-release.ps1`：`pnpm tauri build` 子进程创建后立即设 `PriorityClass=BelowNormal`。
- `scripts/smoke-windows.ps1`：脚本自身、NSIS 安装/卸载、`msiexec` 子进程均为 `BelowNormal`，`-WindowStyle Hidden`。
- 本机未创建定时任务。NSIS 段非提权即可；MSI 段因 perMachine 需要管理员令牌，
  由调用方提权运行（脚本内不做自提升）。

### 2.2 WebView2 依赖策略

`tauri.conf.json` → `bundle.windows.webviewInstallMode`：

```json
{ "type": "downloadBootstrapper", "silent": true }
```

- 安装包**不内嵌**运行时，安装时由 NSIS 调微软 Evergreen Bootstrapper（**需联网**）静默安装；
  Win11 / 多数 Win10 已预装时直接跳过。
- WebView2 由 Microsoft 按其分发条款提供，见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
- 内网/离线改用 `offlineInstaller`（包体增大）或 `fixedRuntime`（固定版本），当前未采用。

## 3. 跨平台（脚本就绪、未构建）

| 平台 | 产物 | 状态 |
|---|---|---|
| Windows | NSIS + MSI | 本机已构建（见第 2 节） |
| macOS | universal `.app` + `.dmg`（`codesign --deep --options runtime` + `notarytool` + `stapler`） | **未构建**；`scripts/build-release.sh` 与 CI 矩阵已就绪，签名/公证需 Apple 证书 secrets |
| Linux | AppImage + deb + rpm（webKit2GTK 4.1 运行时依赖） | **未构建**；CI 已声明 `libwebkit2gtk-4.1-dev` 等前置；未出 Flatpak 清单（M6 标注为可选） |

CI：[`\.github/workflows/release.yml`](../.github/workflows/release.yml)，tag `v*` 触发，
三平台构建 → 汇总 `SHA256SUMS.txt` → Release。Windows job 内含冒烟。

## 4. 自动更新（tauri-plugin-updater）

- 已接入 `tauri-plugin-updater` + `tauri-plugin-process`，侧栏「检查更新」按钮执行
  检查 → 下载安装 → 重启（`UpdateButton`）。
- 签名密钥与代码签名证书**分离**：本机私钥在 `%USERPROFILE%\.shellora\updater.key`
  （**不入库**），公钥写入 `tauri.conf.json` → `plugins.updater.pubkey`。
  CI 需设置 `TAURI_SIGNING_PRIVATE_KEY`（或 `_PATH`）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 端点当前为占位 `https://updates.example.com/shellora/{{target}}/{{arch}}/{{current_version}}`，
  未部署更新服务器，因此「v1.0.0 → v1.0.1 升级保留数据」**未验**。
- 发布 updater 产物需 `bundle.createUpdaterArtifacts = true` 并上传 `.sig`；本次未开启（未验）。

## 4.1 手动清理本地数据（M6 验收 5）

侧栏「数据清理」入口，两档 + 二次确认（勾选「我已了解上述影响」后才可执行）：

| 档位 | 删除项 |
|---|---|
| 仅清缓存 | `transfer_job`（传输任务与断点）、`<appData>/logs` |
| 全部清除 | 上面两项 + `session` / `connection` / `credential_ref` / `known_host`、迁移备份 `*.bak`、前端 `localStorage`（主题/界面偏好） |

实现要点：

- 后端 `data_clear(scope)` 按外键顺序 `DELETE` 后 `wal_checkpoint(TRUNCATE)`，schema 保留，重启即为空库；
  不删除、不改写系统 `~/.ssh/known_hosts`；密码本体从未入库（D1）。
- 清完后弹窗提供「立即重启」（`plugin-process`），也可稍后手动重启。
- 验证：`db::tests::clear_cache_keeps_connections`、`clear_all_data_leaves_empty_schema` 通过；
  GUI 按钮的点击路径**未人工验证**（按"无可见窗口"约束未启动交互会话）。

## 4.2 品牌改名：SSHTerm → Shellora

- 标识：`productName=Shellora`、identifier=`com.shellora.desktop`、窗口标题 `Shellora`、
  Cargo 包/二进制 `shellora` / `shellora.exe`、`--version` 输出 `Shellora 1.0.0`、
  `--health-check` 新增 `"product":"Shellora"`。
- 安装包、卸载键、开始菜单、快捷方式、安装目录均按 `Shellora` 生成
  （NSIS `%LOCALAPPDATA%\Shellora`、MSI `C:\Program Files\Shellora`）。
- 数据目录迁移：新库为 `%APPDATA%\com.shellora.desktop\shellora.db`。首次启动若新库不存在而
  旧目录 `%APPDATA%\com.sshtool.desktop\sshtool.db` 存在，则复制旧库（含 `-wal`/`-shm`）到新目录；
  复制失败则回退直接读旧库，会话不丢。实现见 `src-tauri/src/paths.rs`，
  单测覆盖三种路径（空装 / 迁移成功 / 迁移失败回退）。
- 前端偏好键随之改为 `shellora.theme` / `shellora.copyOnSelect`（旧键不再读取，主题偏好需重设一次）。
- 改名残留扫描（ASCII 字符串）：`shellora.exe` 中 `SSHTerm` / `ssh-terminal` 均为 0，
  `sshtool` 仅 2 处——迁移常量 `com.sshtool.desktop`、`sshtool.db`，属预期保留；
  安装包与前端 bundle 无旧品牌字样。
- 旧品牌产物（`SSHTerm_1.0.0_x64-*`）保留在 `bundle` 目录未删，见下节清单说明。

## 5. 签名状态

- Windows Authenticode：**未签**（无 EV 证书 / Azure Trusted Signing 账号）。
  `Get-AuthenticodeSignature` 预期 `NotSigned`；SmartScreen 可能拦截，属未验项。
- macOS codesign / notarize：**未执行**（无 Apple Developer 证书；本机无 macOS）。

## 6. M6 验收状态

| # | 验收项 | 状态 |
|---|---|---|
| 1 | 三台干净 VM 下载→安装→连接（≤5 分钟、无安全警告） | **未验**（仅本机 Windows 冒烟） |
| 2 | macOS `spctl` / hardened runtime | **未验**（未构建、未签） |
| 3 | Windows `Get-AuthenticodeSignature` = Valid | **未验**（未签） |
| 4 | v1.0.0 → v1.0.1 应用内升级保留数据 | **未验**（无更新服务器） |
| 5 | 卸载保留 AppData 数据；提供手动清除入口 | 数据保留：NSIS 冒烟已验证（AppData 标记文件保留）；卸载无残留：NSIS + MSI 均断言目录/卸载键/开始菜单清零（28/28 PASS）；清除入口已实现（两档 + 二次确认，db 单测通过），GUI 点击路径未人工验证 |
| 6 | 冷启动 ≤2.5s / ≤2s / ≤3s | **未验**（未做三平台 release 计时） |
| 7 | 体积上限（Win ≤15MB / dmg ≤20MB / AppImage ≤25MB） | Windows 已满足；其余**未验** |
| 8 | macOS 42 项人工清单 | **未验**（[macOS 清单](../qa/macos-checklist.md) 42 行全部待执行） |

## 7. 产物清单与校验

`node scripts/release-manifest.mjs` 生成：

- [manifest-1.0.0.json](manifest-1.0.0.json)：每个产物的相对路径、字节数、SHA-256
- [manifest-1.0.0.md](manifest-1.0.0.md)：可直接贴到 Release 页面

本机 1.0.0：

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `Shellora_1.0.0_x64_en-US.msi` | 8,028,160 | `294dea14f7d827c617ec6ccddce61346586faf5f6be9ea587c2a943a2f10c2f2` |
| `Shellora_1.0.0_x64-setup.exe` | 5,773,475 | `9f04093c8e23847d8eed091ef1c70a5a81c0ab542110b2e9599a82ab1deed50c` |
| `shellora.exe`（裸二进制） | 20,943,872 | `a09b50348b8396768963447b911152bc03c2b4f8d2734620cc18380510b8918b` |

**旧品牌产物保留**：改名前的 `SSHTerm_1.0.0_x64_en-US.msi`（`9b17da01…`）与
`SSHTerm_1.0.0_x64-setup.exe`（`695b0c93…`）仍留在 `bundle` 目录，未删除，便于回溯；
不在本版发布清单内（见 `manifest-1.0.0.md` 的「旧品牌产物」小节）。
