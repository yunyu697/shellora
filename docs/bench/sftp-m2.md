# SFTP 单文件传输基准（M2）

无头集成测试（`src-tauri/tests/sftp_m2.rs`），夹具为进程内 `fixture_sshd` 的本地磁盘 SFTP 后端，
全程无可见窗口、无定时任务。测试同时校验内容逐字节一致。

## 复现

```powershell
cd src-tauri
cargo test --test sftp_m2 -- --nocapture              # debug
cargo test --release --test sftp_m2 -- --nocapture    # release
```

## 实测（2026-11-04，Windows 11，本机环回）

| 场景 | debug | release |
|---|---|---|
| 下载 4MiB | 2.01–2.26 MiB/s | 42.7–101.2 MiB/s |
| 上传 4MiB | 2.03–2.58 MiB/s | 27.0–55.8 MiB/s |
| 下载 64MiB | 2.26–2.33 MiB/s | 87.7–101.5 MiB/s |
| 断点续传（32MiB，约 5.5–5.8MiB 处中断后续传） | 2.26 MiB/s | 85.4–96.8 MiB/s |

参数：4 通道、64KiB 请求、256KiB 分块、每通道 2 在途（`src-tauri/src/config.rs` 常量）。
debug 慢的原因是 SSH 加密/拷贝未优化，不是并发或续传缺陷（8 通道仅提升约 12%，且测试同机自测）。

## 用例

1KB / 4MB / 64MB 下载、4MB 上传、断点续传（`TRANSFER_INTERRUPTED` → 复用 `transfer_job` 偏移）、
目标已存在（`SFTP_TARGET_EXISTS`，不覆盖）、权限拒绝（`SFTP_PERMISSION_DENIED`）。

> 大文件用例在测试内向 `HEAVY` 锁串行，避免 debug 构建并行跑多个 64MiB 时把同机 CPU 打满。
