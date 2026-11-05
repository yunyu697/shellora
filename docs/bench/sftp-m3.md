# SFTP 双栏 / 队列基准（M3）

无头集成测试（`src-tauri/tests/sftp_m3.rs`），复用 `fixture_sshd` 本地磁盘 SFTP 后端；
全程无可见窗口、无定时任务。队列默认并发 2 个任务，任务内部仍是 M2 的 4 通道引擎。

## 复现

```powershell
cd src-tauri
cargo test --test sftp_m3 -- --test-threads=1 --nocapture
```

## 实测（2026-11-04，Windows 11，本机环回，debug）

| 验收点 | 结果 | 说明 |
|---|---|---|
| 入队 → 暂停 → 继续 → 完成 | 通过 | 8MiB 下载；暂停保留 `.part`，继续后 `resumedBytes > 0`，内容逐字节一致 |
| 冲突：覆盖 / 跳过 / 重命名 | 通过 | 覆盖替换旧内容；跳过保留旧文件且无 `.part`；重命名落到新名字、原文件不动 |
| 取消后 `.part` 保留且可续传 | 通过 | 取消不产生最终文件；原路径重新入队后复用库中偏移并完成 |
| 万级条目分页 | 通过 | 10000 条远端按 500/页 → 20 页；夹具服务端每次 `readdir` 只回 100 条，客户端多轮拉取；无重复/遗漏 |
| 本地万级分页 | 通过 | 同一目录按 500/页连续拉取，总数 10000 |

单进程 debug 全量用例约 21.6s；整套 `cargo test --lib --tests` 约 45s（含 M2 64MiB 大文件）。

## 未验（GUI）

- 真实拖拽手感：跨栏 HTML5 DnD 的落点提示/多选拖拽未做人工操作验证。
- 虚拟滚动帧率：万级条目下的滚动 FPS、长任务并发时的 UI 抖动未测。
- 冲突弹窗的真实交互路径（覆盖/跳过/重命名按钮）仅通过管理器无头用例覆盖，未在打包 GUI 内点击验证。

# 递归目录传输（M3.5）

无头集成测试（`src-tauri/tests/sftp_m35.rs`），同样的进程内夹具；拖拽目录时先扫描整棵树再按文件建任务，
同一组共享聚合进度与整组控制。

## 复现

```powershell
cd src-tauri
cargo test --test sftp_m35 -- --nocapture
```

## 实测（2026-11-04，Windows 11，本机环回，debug，7 个用例）

| 验收点 | 用例 | 结果 |
|---|---|---|
| 目录树递归上传 + 整棵下载，层级/内容一致 | `m35_recursive_upload_and_download_keep_hierarchy` | 通过（3 文件、2 层子目录，逐字节一致） |
| 深目录（5 层、600 文件） | `m35_deep_tree_five_levels_600_files` | 通过（5 层 `l1..l5`，600×256B，约 9s） |
| 整组暂停 / 继续 | `m35_group_pause_and_resume` | 通过（3×4MiB，暂停后 `transferred < 12MiB`，继续后内容一致） |
| 整组取消后 `.part` + 偏移保留、重新入队续传 | `m35_group_cancel_keeps_part_and_resumes` | 通过（`.part` 保留，重新入队 `resumedBytes > 0`） |
| 整组统一冲突策略：覆盖 / 跳过 / 重命名 | `m35_group_unified_conflict_policies` | 通过（跳过计入已处理；重命名落到 `a (1).txt`，原文件不动） |
| 空目录开关（默认关） | `m35_empty_dir_switch` | 通过（关：只建文件所需目录；开：空目录也建；纯空树关时零目录） |
| 最大深度/文件数超限提示 | `m35_depth_and_file_limits_are_reported` | 通过（`TRANSFER_LIMIT_EXCEEDED`，不卡死） |

整套 M3.5 约 21s；M2/M3 回归（6 + 4 用例）、`cargo test --lib`（8）、`cargo clippy -D warnings` 均通过。

## 过程中发现并修复的引擎缺陷

取消/暂停时原本用 `JoinSet::abort_all()` 硬中止 worker，会在 SFTP 请求在途时直接丢弃会话，
russh 客户端收到延迟的 `window_adjust` 后以 `WrongChannel` 断开**整条 SSH 连接**（终端一起掉线）。
现改为协作式停止：设置内部 `stop` 标记，worker 在本次请求返回后于块边界自行退出，会话干净关闭。
整组取消用例连跑 12 次稳定通过。

## 已知限制

- GUI 未验：拖拽目录的手感、树选项弹窗、组进度展开在打包窗口内未人工操作。
- 整组「重命名」忽略自定义新名字（组级无逐文件输入），按各自原名追加 ` (n)`；单文件仍可自定义。
- 「逐个询问」模式下组内每个冲突仍走单任务弹窗；组面板另有「全部覆盖/跳过/重命名」一键整组处理。
- 扫描是同步阻塞入队（5000 文件上限内）：超深/超大目录会先提示上限，不做后台增量扫描。
- 空目录只在目标侧创建，不复制空目录的时间戳/权限。
