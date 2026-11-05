#!/usr/bin/env sh
# 启动 M0 本地 SSH 夹具（127.0.0.1:2222，用户 alice / 密码 secret）。
# 不依赖 Docker/WSL。可用 FIXTURE_PORT / FIXTURE_USER / FIXTURE_PASS 覆盖。
exec cargo run --manifest-path "$(dirname "$0")/../src-tauri/Cargo.toml" --features fixture --bin fixture_sshd
