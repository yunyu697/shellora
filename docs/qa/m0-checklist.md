# M0 验收记录

范围：骨架 + 单会话 SSH 终端闭环。日期 2026-11-04。执行约束：默认无头；可见窗口仅在用户授权时开启并即时销毁。

| # | 验收标准 | 状态 | 证据 |
|---|---|---|---|
| 1 | 按 README 三条命令完成构建 | 部分 | `pnpm install` 通过；`cargo build` 通过；`pnpm build` 通过。三平台未逐一验证（仅 Windows）。`tauri dev` 会起窗口，未执行 |
| 2 | 连接本地 sshd ≤2s 出现提示符；`echo $TERM` = `xterm-256color` | 通过（服务端） | `cargo test --lib --tests` → `m0_connect_echo_resize_disconnect`：1.57s 内完成连接、提示符、`echo $TERM` 断言 |
| 3 | `top` 60s 吞吐/掉帧/堆增长 | 未验 | 三次授权窗口均未产出数字：前两次遮挡节流停摆，第三次受锁屏限制；详见下节 |
| 4 | 120×30 → 60×15 → 120×30，`stty size` 准确 | 部分 | 端到端断言 `stty size` = `24 80`，resize 后 = `30 100`；小档截图通过，回大档截图未完成 |
| 5 | 断开 → 5s 内 UI 显示断开且不崩溃；重试可恢复 | 部分 | 端到端断言断开后 5s 内收到 Eof/Close/None；UI 状态条与“重连”按钮接线完成，GUI 未执行 |
| 6 | IPC 三项基准达标或记录降级结论 | 未验 | 三次窗口均未跑到基准；见 [docs/bench/ipc-m0.md](../bench/ipc-m0.md) |
| 7 | `cargo clippy -- -D warnings` 与 `pnpm lint` 通过 | 通过 | clippy：0 警告；`pnpm lint`（tsc --noEmit）：通过 |

## 已完成的自动化断言

- 合并器：5 项单测（阈值、关闭 drain、permits 取整、空块、窗口总量上限）。
- 端到端：连接 → 提示符 → `echo $TERM` → `stty size` 24 80 → resize 30 100 → 断线 5s 内明确结束。
- 端到端：错误密码返回 `AUTH_FAILED`，不静默重试。

## GUI 实测（一次性窗口，累计约 115s，已关闭、无残留进程/托盘）

| 项 | 结果 | 证据 |
|---|---|---|
| 尺寸回归（小档） | 通过 | [m0-small.png](shots/m0-small.png)：58×16，`stty size` 回 `16 58`（行/列正确） |
| 尺寸回归（回大档） | 未完成 | [m0-back.png](shots/m0-back.png) 仅截到切换瞬间；后续命令未执行 |
| 30s 类 top 吞吐/掉帧/堆 | 未产出 | 窗口被遮挡触发 Chromium 后台节流（定时器/rAF 停摆），自测第 8.5s 后未再发命令 |
| 64MiB 冲量吞吐 | 未产出 | 同上；且当时夹具源吞吐仅 0.8MB/s，64MiB 需 ~80s，超出探针 95s 期限 |

**根因与已修复项**：
1. 夹具/客户端逐消息读取开销：0.8MB/s → `make_reader` 读取后 3.6MB/s（debug 构建）。
2. TCP 无 `NODELAY`，大包被 delayed-ACK 拖慢：客户端改用 `connect_stream` + `set_nodelay(true)`；夹具自建 accept 循环同样开启。
3. 客户端窗口/包尺寸过小：提升为 8MiB 窗口 + 64KiB 包（[connect.rs](../../src-tauri/src/ssh/connect.rs)）。
4. 遮挡节流：复测时追加 `--disable-background-timer-throttling`、`--disable-renderer-backgrounding`、`--disable-backgrounding-occluded-windows`，并在探针开头 `Page.bringToFront`。

### 第二次窗口复测（同日，累计 45.7s，已销毁、无残留）

- 条件：8MiB 窗口 / 64KiB 包 / 两端 `TCP_NODELAY`；`--disable-background-timer-throttling`、`--disable-renderer-backgrounding`、`--disable-backgrounding-occluded-windows`，探针开头 `Page.bringToFront`；硬上限 60s，实跑 45.7s 后强制关闭。
- 结果：**仍未产出任何性能数字**。`node exit=1`（`probe failed: 40s 内未产出结果`）；仅 `small`/`back` 两张截图（13:35:49 / 13:35:53），页面 `phase=back` 后定时器与 rAF 停摆，`top`/`burst` 未启动。
- 判定：吞吐、掉帧、堆增长三项均记 **未验**，不放宽判定。64MiB 冲量仅可作推算（按无头 3.6–4MB/s 约 16–18s，且受同一源上限约束），**不记实测**。
- 残留：应用、夹具、vite、node 均已退出，端口 1420/9223 释放。

复测命令（窗口 ≤60s）：`m0-gui-probe.mjs` + 上述 WebView2 参数，`top 20s` + `burst 24MiB`。

### 第三次窗口（90s 授权，Win32 前台化）— 2026-11-04 14:03

- 参数：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223 --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding"`（即 WebView2 的 `additionalBrowserArguments` 入口，不依赖脚本 `bringToFront`）；Win32 侧 `ShowWindow(SW_SHOWNORMAL)` + `SetForegroundWindow` + `SetWindowPos(HWND_TOPMOST)`。
- 前台实测：`foregroundTitle="Windows 默认锁屏界面"`、`foregroundPid=3068`、`foregroundIsApp=false` —— 当前会话处于锁屏，系统不允许应用成为前台，遮挡节流条件无法消除。
- 探针驱动时序（`window.__m0Api`：resize → `stty size` → `top 12s` → `burst 16MiB`），实跑 **49.8s** 后在 90s 上限内销毁；`node exit=1`，`probe failed: burst 25s 内未结束`。`top` 阶段在 20s 内结束，但 burst 未启动。
- 已定位并修复夹具缺陷：`bench` 任务取走通道后未归还，导致同一会话第二次 `bench` 静默不执行；改为 `Arc<Mutex<Option<Channel>>>` 并在结束时归还。新增无头回归 `m0_fixture_bench_top_then_burst`（3.15s 通过）。
- 指标：吞吐、掉帧、堆增长、`visibilityState`/`document.hidden` 采样与 rAF 间隔日志均**未产出**（`publish` 未执行，`m0-raf.log` 未生成）；截图 `m0-small.png`/`m0-back.png` 于 14:04:16/17 重新生成。
- 判定：全部记 **未验**，原因是环境限制（会话锁屏 → 无法取得真实前台）叠加夹具缺陷；不放宽判定，**不再申请第三次**。
- 清理：`shellora`/`fixture_sshd` 残留为 0，端口 1420/9223 已释放；窗口销毁后 topmost 随窗口消失。

**驱动与采样脚本**：[m0-window-run.ps1](../../scripts/m0-window-run.ps1)（启动/前台化/90s 看护/清理）、[win-foreground.ps1](../../scripts/win-foreground.ps1)、[win-cpu.ps1](../../scripts/win-cpu.ps1)、[m0-gui-probe.mjs](../../scripts/m0-gui-probe.mjs)。

## 无头实测（可复现）

- 夹具 burst 8MiB（debug）：2.6s 内完成（含全部 3 个 e2e），约 3.6–4MB/s；这是夹具源上限，不是应用上限。
- 通过线（10MB/s）需 release 构建 + 真实 sshd 才能判定；当前记为 **未判定**，不记通过。

## M1 进展（持久层）

| 项 | 状态 |
|---|---|
| 迁移 v1：session / connection / credential_ref / known_host | 完成，`user_version=1` |
| 约束：name 唯一、port CHECK、auth_kind/proxy_mode CHECK、session 级联删除 | 完成（6 项测试全绿） |
| known_host TOFU 去重（同 host+port+指纹 只更新 last_seen） | 完成 |
| 迁移前备份 + 重开幂等 + `integrity_check` | 完成 |
| `conn_test`（仅认证不开通道） | 完成 |
| 会话库 IPC（list/insert/delete connection、create/list session） | 完成 |
| 多标签 UI + 会话库界面 | 完成（`pnpm lint`/`pnpm build` 通过；GUI 未执行） |

### M1 前端 UI 状态

| 项 | 状态 |
|---|---|
| 标签栏：新建/切换/关闭、状态点、`30` 上限前端兜底 | 完成 |
| 非活动标签保持挂载、`visibility:hidden` 保尺寸；切回时 fit + focus | 完成 |
| D4：第 9 个起新标签 `scrollback=5000`（按挂载时序号，已有标签不回改） | 完成（未 GUI 断言） |
| 会话库：列表、载入表单、打开、删除（级联会话）、`conn_test` 测试 | 完成 |
| 保存连接（密码按 D1 不入库，每次输入） | 完成 |
| 从库打开时写入 `session`（同连接同名称去重） | 完成 |
| 非活跃标签降级 canvas 渲染（R-10） | 未做，仅隐藏，仍保留 WebGL |
| 8 标签 RSS ≤400MB / 切换 ≤80ms / 第 31 个标签拒绝 | 未验（需 GUI） |

## 待补（进入 M1 风险清单）

1. GUI 三项（吞吐/掉帧/堆）与两档 resize 截图回归：复测脚本与参数已就绪，需再次授权窗口（≤60s）。
2. 三平台构建矩阵：当前仅 Windows；Linux/macOS 待 CI。
3. 自动重连退避：M0 仅 `terminal_retry` 手动重连，按计划留到 M1。
4. 阈值判定基准：吞吐/掉帧指标需 release 构建数据，debug 数据不作为结论。
