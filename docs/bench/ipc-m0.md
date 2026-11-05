# IPC 基准（M0）

对应里程碑 §3.4 的三项门禁。当前状态：**未验**。已三次授权临时窗口；第三次（90s，实跑 49.8s）已按
`additionalBrowserArguments` 关闭后台节流并用 Win32 前台化，但系统处于锁屏（实际前台为“Windows 默认锁屏界面”），
应用无法真正前置；且当轮 burst 因夹具“连续 bench 通道未归还”缺陷未启动（已修复并加无头回归），故无数字产出。

## 复现步骤

1. 终端 A：`cargo run --manifest-path src-tauri/Cargo.toml --bin fixture_sshd`
2. 终端 B：`pnpm tauri dev`
3. 应用 WebView 的 DevTools 控制台执行：

```js
const m = await import('/scripts/bench-ipc.ts');
await m.runIpcBench({ bytes: 200 * 1024 * 1024 });
```

脚本会打印：收齐吞吐（MB/s）、帧数、帧间隔 p95（ms）、ack 是否零丢失。

## 结果

| 指标 | 通过线 | 实测 | 结论 |
|---|---|---|---|
| 终端吞吐（JS 侧收齐） | ≥ 10MB/s，帧丢失 0 | 无 | 未验 |
| 单帧 32KB 端到端延迟 p95 | ≤ 12ms | 无 | 未验 |
| 空闲 IPC CPU（8 标签） | ≤ 3% | 无 | 未验（待 M1 多标签） |

说明：64MiB 冲量按无头 3.6–4MB/s 只能给出 **推算**（约 16–18s），且受夹具 debug 源上限约束，
不记实测、不参与判定。探针驱动时序与窗口置顶已实现（`scripts/m0-gui-probe.mjs` + `win-foreground.ps1`）；
按用户指令不再申请新窗口，三项维持**未验**，待未锁屏环境复测时按同一脚本直接跑。

## 已测（无头，仅作链路基线）

- 夹具 `bench burst 8`：8MiB 在约 2.2s 内收齐（≈3.6MB/s，debug）；同条件逐 `ChannelMsg` 读取时为 0.8MB/s。
- 结论：瓶颈在夹具源与读取方式，**不能**作为应用侧吞吐判定；已修复客户端窗口 8MiB/64KiB 包与 TCP_NODELAY。

降级判据：若 `Channel<Vec<u8>>` 被序列化为 JSON 数组导致吞吐 < 5MB/s，则按 §3.4 启用
base64 字符串路径（`EncodingMode` 开关，前端无分支）。
