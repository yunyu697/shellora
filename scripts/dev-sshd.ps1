# 启动 M0 本地 SSH 夹具（127.0.0.1:2222，用户 alice / 密码 secret）。
# 不依赖 Docker/WSL。可用 FIXTURE_PORT / FIXTURE_USER / FIXTURE_PASS 覆盖。
cargo run --manifest-path (Join-Path $PSScriptRoot "..\src-tauri\Cargo.toml") --features fixture --bin fixture_sshd
