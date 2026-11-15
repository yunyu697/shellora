# 发布说明（M6）

版本：v1.1.1 · Windows x64（CI 构建 + 本机安装冒烟）、macOS universal / Linux x64（CI 构建，本地无对应系统，未实机运行）

## 0. 当前发布：v1.1.1（GitHub Actions，三平台）

仓库：https://github.com/yunyu697/shellora · Release：https://github.com/yunyu697/shellora/releases/tag/v1.1.1

七个产物全部由 `.github/workflows/release.yml` 在同一 tag 上构建并挂到同一个 Release。
publish job 会先校验 exe / msi / dmg / AppImage / deb 是否齐全，缺任一平台直接失败。

| 文件 | 平台 | 字节 | SHA-256 |
|---|---|---:|---|
| `Shellora_1.1.1_x64-setup.exe`（NSIS） | Windows x64 | 6,173,147 | `7748b9b14cce4bc975944369b9efa10be8e0f54aadce9775656b3658a1b56b5c` |
| `Shellora_1.1.1_x64_en-US.msi`（WiX） | Windows x64 | 8,556,544 | `e6d219f74b1a164e344c99036026d24172ad371cf90042d57ead996be9e4992a` |
| `Shellora_1.1.1_universal.dmg` | macOS universal | 17,288,410 | `493e98050f9d4cd4aab1b28a474ae9cd1214c72a89c8a8b5e75fc002baed39a6` |
| `Shellora.app.tar.gz` | macOS universal（.app 包） | 17,698,748 | `9000c128a21f28373fe98d7826ba1c010597911bb2e7da95c2b51c082280df60` |
| `Shellora_1.1.1_amd64.AppImage` | Linux x64 | 88,230,392 | `6e456b54e9bb1038356d055cfb62379e2bb8f91bdceaf65544964032e96d0736` |
| `Shellora_1.1.1_amd64.deb` | Linux x64 | 10,404,052 | `edd9a6c07ae6513c0378844455529de3cb902c4049b2fede6aed89389ceb4e41` |
| `Shellora-1.1.1-1.x86_64.rpm` | Linux x64 | 10,411,116 | `1e56e035be30ae4b188f4d9a68b77386c59ed1dfc94794eafaa82c6018d95301` |

完整哈希见 Release 附件 `SHA256SUMS.txt` 与 [manifest-1.1.1.json](manifest-1.1.1.json)。

本地验证边界（不要含糊）：Windows 的 NSIS 包在本机静默安装 → 版本 1.1.1 → 启动成功；
MSI 与 macOS / Linux 的全部产物**只经过 CI 构建**，本机没有对应系统，未实机运行。


本次发布解决的 CI 问题：`macos-14` 在本仓库返回「The configuration 'macos-14-arm64-us-default'
is not supported」（runner 从未分配，job 1 秒内 cancelled），改用 `macos-latest` 后 normal 调度；
publish 增加三平台齐全硬校验，避免「其它平台继续跑」把缺件发布出去。

上一版 v1.1.0 的 Release 只有 Windows 产物（当时同一 tag 的 release 工作流在 macOS job 卡住后被取消），
其 Windows 包与哈希仍保留，三平台从此版本起成为常态。

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

## 3. 跨平台（三平台均由 CI 构建）

| 平台 | 产物 | 状态 |
|---|---|---|
| Windows | NSIS + MSI | CI 构建；NSIS 在本机做过静默安装 + 启动冒烟 |
| macOS | universal `.app` + `.dmg`（未签名 / 未公证） | CI 构建（`macos-latest`，`universal-apple-darwin`）；本机无 macOS，未实机运行 |
| Linux | AppImage + deb + rpm（webKit2GTK 4.1 运行时依赖） | CI 构建（`ubuntu-22.04`）；本机无 Linux，未实机运行 |

CI：[`.github/workflows/release.yml`](../../.github/workflows/release.yml)，tag `v*` 触发，
windows / macos / linux 三个 job 并行 → publish 汇总 `SHA256SUMS.txt` 与
`manifest-<ver>.json`（含全部平台）→ 同一个 Release。任一平台 job 失败，publish 不会执行。
签名/公证缺失时允许产出未签名包并在 README「已知限制」中标注，不阻塞发布。


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

## 8. 发布流程（默认必发）

**规则：出包即发布，不再只把产物留在本地。** 任何一次构建出正式版，都必须完成下列步骤，
否则视为未发布。

1. 版本号三处同步并校验：`src-tauri/Cargo.toml`、`package.json`、`src-tauri/tauri.conf.json`，
   `node scripts/check-version.mjs` 必须通过（段值 ≤10 规则见 [../VERSIONING.md](../VERSIONING.md)）。
2. 构建：`pwsh scripts/build-release.ps1`（含冒烟断言，子进程 BelowNormal、离屏）。
3. 生成清单：`node scripts/release-manifest.mjs` → `docs/release/manifest-<ver>.json|.md`。
4. 打 tag 并推送：`git tag -a v<ver> -m "..."` + `git push origin v<ver>`。
5. 建 Release 并上传资产（**必须包含**）：
   - `Shellora_<ver>_x64-setup.exe`（NSIS）
   - `Shellora_<ver>_x64_en-US.msi`（WiX）
   - `SHA256SUMS`（`<sha256>  <文件名>`，两空格）
   - `manifest-<ver>.json`
   - Release 说明：本版做了什么 + 已知限制（macOS/Linux 未实机、Linux 无产物）
6. 上传后核对：`gh release view v<ver> --json assets` 的 `digest` 必须与本机
   `Get-FileHash -Algorithm SHA256` 完全一致，不一致则重新上传。
7. 最新正式版用 `--latest` 接管 `releases/latest`；历史版本补发时**不得**抢 Latest。

## 8.1 pre-release 口径

| 情况 | 是否标 pre-release |
|---|---|
| 正式版（版本号无 `-alphaN/-betaN/-rcN` 后缀，冒烟通过） | 否，且最新一个接管 Latest |
| 预发布（带 `-alphaN`/`-betaN`/`-rcN` 后缀） | 是；即使版本号更大也不接管 Latest |
| 仅为补齐历史版本而补发的 Release | 否；不带 `--latest`，Latest 保持在最新正式版 |
| 仅 CI 临时产物 / 未过冒烟 | 不发 Release，只留 Actions artifact |

已有 origin 早于本规则的版本（1.0.4–1.0.8）如补发，按「历史补发」处理。

## 9. 发布历史与断点（2026-11 核查）

| 版本 | tag | Release | 资产 | Latest |
|---|---|---|---|---|
| 1.0.0 | 有 | 有 | exe/msi | — |
| 1.0.1 | 有 | **无** | — | — |
| 1.0.2 | 有 | 有 | exe/msi/dmg | — |
| 1.0.3 | 有 | 有 | exe/msi/dmg | 曾为 Latest |
| 1.0.4–1.0.8 | 无 | **无** | 仅本地产物 | — |
| 1.0.9 | 有（本地补推） | 已补发 | exe/msi/SHA256SUMS/manifest | 否 |
| 1.0.10 | 有（本地补推） | 已补发 | exe/msi/SHA256SUMS/manifest | 否 |
| 1.1.0 | 有 | 有 | exe/msi/SHA256SUMS/manifest | 曾为 Latest（仅 Windows 产物） |
| 1.1.1 | 有 | 有 | exe/msi/dmg/app.tar.gz/AppImage/deb/rpm/SHA256SUMS/manifest/latest.json | **是**（首个三平台版本） |

断点结论：**从 1.0.4 起只在本地产物、未发 Release**；1.0.9 / 1.0.10 已按本流程补发并核对
远端 digest。1.1.0 的 release 工作流因 `macos-14` runner 不可用被取消，只留下 Windows 产物；
从 **1.1.1** 起三平台由 CI 同 tag 构建并一起发布。
