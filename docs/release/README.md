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

## 10. 三平台出包的出处与可复现性（2026-11-15 澄清）

### 10.1 谁出的包

**不是本地手动出包。** v1.1.1 的 7 个产物由 `.github/workflows/release.yml` 在 tag `v1.1.1` 上构建，
三台 **GitHub 托管 runner**，`publish` job 汇总后挂到同一个 Release。

| 平台 | runner | 命令 | 工具链 | 产物 |
| --- | --- | --- | --- | --- |
| Windows x64 | `windows-latest`（GitHub 托管） | `pnpm tauri build --bundles nsis,msi --config <临时 cfg>`，随后 `scripts/smoke-windows.ps1` | pnpm 9、Node 20、`dtolnay/rust-toolchain@stable`（stable 未钉版本） | `*-setup.exe`、`*.msi`（+ `.sig`） |
| macOS universal | `macos-latest`（GitHub 托管） | `pnpm tauri build --target universal-apple-darwin --bundles app,dmg` | rust targets `aarch64-apple-darwin` + `x86_64-apple-darwin`（均为 stable） | `Shellora.app.tar.gz`、`Shellora_1.1.1_universal.dmg`（+ `.sig`） |
| Linux x64 | `ubuntu-22.04`（GitHub 托管） | 先 `apt-get install libwebkit2gtk-4.1-dev … rpm`，再 `pnpm tauri build --bundles appimage,deb,rpm` | 同上；apt 包**未钉版本** | `.AppImage`、`.deb`、`.rpm`（+ `.sig`） |
| 汇总发布 | `ubuntu-22.04` | 下载三份 artifact → 校验齐全 → `updater-manifest.mjs` → `release-manifest.mjs` → `find … sha256sum` → `softprops/action-gh-release` | — | `latest.json`、`SHA256SUMS.txt`、`manifest-1.1.1.*` |

判定依据（不是推测）：

1. `docs/release/SHA256SUMS-1.1.1.txt` 的路径是 `./windows-bundles/…`、`./macos-bundles/…`、
   `./linux-bundles/…`、`./latest.json` —— 这种前缀只可能来自 publish job 的
   `cd artifacts && find … | xargs sha256sum`；本地 `build-release.ps1` 生成的是
   `src-tauri/target/…/bundle/…`，没有 `artifacts/` 与 `*-bundles` 层。
2. `manifest-1.1.1.json` 里每个 `path` 以 `artifacts/` 开头，`generatedAt = 2026-11-15T01:14:08Z`
   （= 09:14 +0800），与 HEAD `49c4718`（09:16:09）相隔两分钟，即「publish 产出清单 → 随即提交」。
3. 7 个产物与 workflow 的 `--bundles` 参数一一对应；`macos-latest` 的注释还留着
   `macos-14` 返回 `configuration not supported` 的排查记录。

### 10.2 可复现性判定

| 口径 | 结论 |
| --- | --- |
| 可重复出包（re-runnable） | **是**。重推同一 tag 或 `workflow_dispatch` 能再走一遍同一条流水线 |
| 可复现构建（bit-for-bit） | **否**。runner 镜像、rust stable、Node/pnpm 次版本、apt 包全部浮动；dmg/AppImage/rpm/MSI 内嵌时间戳与构建路径 |
| 产物可核对 | **部分**。有 SHA-256 与 manifest；但缺构建来源证明（无 attestation、manifest 不含 commit SHA 与 runner 版本） |

差距清单（要把它变成「可复现可核验」还缺什么）：

1. **钉死 runner 并记录**：`windows-latest` / `macos-latest` 是浮动标签，`ubuntu-22.04` 也将在
   EOL 后消失。改成显式版本，并把 `sw_vers`、`rpm --version`、`makensis -VERSION`、`rustc -Vv`、
   `node -v`、`pnpm -v` 写进 `manifest-*.json`。
2. **钉死工具链**：新增 `rust-toolchain.toml`（精确版本 + targets）；`package.json` 加
   `packageManager` 并由 corepack 接管；Node 用 `.nvmrc` 固定到次版本。
3. **确定性归档**：`SOURCE_DATE_EPOCH`、`tar --sort=name --mtime=@$SOURCE_DATE_EPOCH`、
   Rust `--remap-path-prefix` 去掉构建路径；用 `diffoscope` 对两次构建做二进制对比，
   逐个消掉时间戳/路径差异。这是最大的一块工作量，且 NSIS/MSI/dmg 由上游工具生成，
   能否完全确定化要先做可行性验证。
4. **签名与公证**：Windows Authenticode（EV 证书或 Azure Trusted Signing）+ macOS Developer ID
   + `notarytool`。当前两者**都未签**（README §5）；证书有效期本身会让「永远可复现」失效，
   所以只能承诺「同证书有效期内可复现」。
5. **齐全性校验有洞（现存缺陷）→ 已修**：publish 的循环原来只查 `*.exe`、`*.msi`、`*.dmg`、
   `*.AppImage`、`*.deb`，**漏了 `*.rpm`**；`action-gh-release` 也用了 `fail_on_unmatched_files: false`。
   现在期望清单只有一处（`scripts/release-artifacts.mjs` 的 7 项数组），校验交给
   `scripts/release-verify.mjs`；上传改用 `artifacts/**/*` 通配（不再逐类枚举，加 bundle 只改
   `release-artifacts.mjs`），`fail_on_unmatched_files` 改为 `true`——原先因 `latest.json` 可能不存在
   而单独拆出的第二个 gh-release 步骤连同 `hashFiles` 条件一并删掉：通配里没有 `latest.json` 时
   其它文件仍能匹配，不会误触发失败。
6. **来源证明**：manifest 已带 `build.commit` / `build.runner.{os,image,imageVersion,arch}`
   （`scripts/release-manifest.mjs`，本地跑时这些字段为 `null`）；还缺 `actions/attest-build-provenance`
   与 `gh attestation verify`，以及把 `GITHUB_RUN_ID` 写进 `latest.json`。
7. **改动范围**：全部集中在 `release.yml` + `scripts/release-manifest.mjs` + `scripts/updater-manifest.mjs`
   + 一个 `rust-toolchain.toml`，不碰业务代码；难点只在第 3、4 项。

### 10.3 本地验证这段检查逻辑（不需要 GitHub、不依赖网络）

`scripts/release-verify.mjs` 是 CI 里唯一跑的那份检查，本地可以原样跑。做法是先造一棵假的
`artifacts/` 树，确认「齐全时退出 0、缺件时退出 1」：

```powershell
# 1) 造 7 个假产物 + 1 个 .sig（内容随便，只要路径名对；版本号取仓库当前版本）
$T = Join-Path $env:TEMP "reltest"
Remove-Item $T -Recurse -Force -ErrorAction SilentlyContinue
$V = node -p "require('./src-tauri/tauri.conf.json').version"
@(
  "windows-bundles\src-tauri\target\release\bundle\nsis\Shellora_${V}_x64-setup.exe",
  "windows-bundles\src-tauri\target\release\bundle\nsis\Shellora_${V}_x64-setup.exe.sig",
  "windows-bundles\src-tauri\target\release\bundle\msi\Shellora_${V}_x64_en-US.msi",
  "macos-bundles\bundle\dmg\Shellora_${V}_universal.dmg",
  "macos-bundles\bundle\macos\Shellora.app.tar.gz",
  "linux-bundles\bundle\appimage\Shellora_${V}_amd64.AppImage",
  "linux-bundles\bundle\deb\Shellora_${V}_amd64.deb",
  "linux-bundles\bundle\rpm\Shellora-${V}-1.x86_64.rpm"
) | ForEach-Object {
  $p = Join-Path $T $_
  New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
  Set-Content -Path $p -Value "x" -NoNewline
}
node scripts/release-manifest.mjs --assets $T --out (Join-Path $T "meta")
$M = (Get-ChildItem (Join-Path $T "meta") -Filter "manifest-*.json").FullName
$S = Join-Path $T "SHA256SUMS.txt"

# 2) 齐全 → exit=0（7 项、SHA256SUMS 7 行、manifest 7 条）
node scripts/release-verify.mjs --dir $T --write-sums --manifest $M
echo "exit=$LASTEXITCODE"

# 3) 删掉 rpm → exit=1（这条就是本轮补的洞）
Remove-Item (Join-Path $T "linux-bundles\bundle\rpm\*.rpm") -Force
node scripts/release-verify.mjs --dir $T --write-sums --manifest $M
echo "exit=$LASTEXITCODE"

# 4) SHA256SUMS 多一行 → exit=1（行数自洽校验）
#    先把 rpm 补回来并重写清单，再往清单末尾追加一行不存在的文件
Set-Content -Path (Join-Path $T "linux-bundles\bundle\rpm\Shellora-${V}-1.x86_64.rpm") -Value "x" -NoNewline
node scripts/release-verify.mjs --dir $T --write-sums --manifest $M | Out-Null
Add-Content $S ("0" * 64 + "  ./linux-bundles/bundle/deb/ghost.deb")
node scripts/release-verify.mjs --dir $T --manifest $M
echo "exit=$LASTEXITCODE"

# 5) SHA256SUMS 少一行 → exit=1（磁盘上文件仍在，只是清单漏了）
(Get-Content $S) | Where-Object { $_ -notmatch "(\.rpm|ghost\.deb)" } | Set-Content $S
node scripts/release-verify.mjs --dir $T --manifest $M
echo "exit=$LASTEXITCODE"
```

四条判据各自能看到什么（2026-11-15 实测）：

| 场景 | 退出码 | 实际输出 |
| --- | ---: | --- |
| 7 项齐全 | `0` | `[verify] OK：7 项产物齐全，SHA256SUMS 与 manifest 条数一致`，随后逐项列出 `nsis/msi/dmg/app-tar/appimage/deb/rpm` |
| 删掉 rpm | `1` | 3 项：`缺少产物：Linux 安装包（.rpm）（期望 1 个，实际 0 个）`、`SHA256SUMS.txt 有多余行：./…/Shellora-<ver>-1.x86_64.rpm`、`manifest 多出产物：Shellora-<ver>-1.x86_64.rpm` |
| 往 `SHA256SUMS.txt` 追加一行 | `1` | `SHA256SUMS.txt 行数 8 != 期待 7`、`SHA256SUMS.txt 有多余行：./linux-bundles/bundle/deb/ghost.deb` |
| 从 `SHA256SUMS.txt` 删掉 rpm 那一行（文件仍在） | `1` | `SHA256SUMS.txt 行数 6 != 期待 7`、`SHA256SUMS.txt 缺少 Linux 安装包（.rpm）：./…rpm` |

说明两点，免得误读输出：

- 删掉 rpm 时之所以报「多余行」而不是「行数 6≠7」：`--write-sums` 只在**齐全**时才重写清单，
  所以旧的 7 行清单原样留着，缺的那一项表现为「清单里有、磁盘上没有」。要单独看行数校验，
  就是上表后两行（清单多一行 / 少一行）。三条判据都在 `release-verify.mjs` 里，触发条件不同而已。
- manifest 的条数校验用的是 `--manifest` 指向的那个文件；本地跑 `--assets` 生成时
  `build.commit` / `build.runner.*` 为 `null`（没有 `GITHUB_SHA` / `ImageOS`），属预期。

CI 里就是同一个脚本，分两次调用：先 `--artifacts-only` 查齐全（此时 SHA256SUMS 与合并 manifest
还没生成），生成清单后再 `--write-sums --manifest` 查自洽。

### 10.4 出包前置条件：产物必须对应仓库里的某个 commit

这条是硬要求：**发布物对应的源码必须在版本里**。产物一旦公开，就应当能回答「它是哪个 commit 编出来的」，
且那个 commit 必须已在仓库中、可 checkout。三条前置：

1. **工作树干净**：打 tag 前 `git status --porcelain` 必须为空。有改动就先按性质提交，再打 tag；
   不允许「工作树带改动直接 build 后发布」——那样产物里混着仓库里不存在的代码。
2. **tag 与 commit 绑定**：用 annotated tag 指向确切 commit，出包工作流只从 tag 触发；
   tag 解析出的 commit 就是产物对应的源码快照。
3. **事后能核对**：manifest 的 `build.commit` 必须等于 `git rev-parse <tag>^{commit}`。
   从 1.1.2 起 `release-manifest.mjs` 会写入 `build.commit` 与 `build.runner.*`（v1.1.1 的 manifest
   `build` 为 `null`，因为那个字段是出包之后才加的，1.1.1 只能靠 tag 推断）。

```powershell
git status --porcelain                          # 必须为空
git rev-parse "v1.1.1^{commit}"                 # 与 manifest 的 build.commit 比对
node -p "require('./docs/release/manifest-1.1.1.json').build?.commit ?? 'null'"
```

反面案例（本轮核对）：v1.1.1 于 2026-11-15 09:14 出包（`generatedAt=2026-11-15T01:14:08Z`，HEAD `49c4718`）。
之后 `src/` 与 `tauri.*.conf.json` 又有一批改动，提交于 10:06–11:53（`45b3c5b`…`2adbc26`）。
**这批改动未进入 1.1.1 产物**：1.1.1 安装包里是最小窗口尺寸 900×600 与旧圆角档位，
与仓库 HEAD 不一致，只能靠下一版补齐。这就是为什么上面第 1 条必须先于 tag 执行。

