//! 应用入口：模块声明 + Tauri 装配。

pub mod app;
pub mod config;
pub mod db;
pub mod error;
pub mod ipc;
pub mod knownhost;
pub mod local;
pub mod paths;
pub mod secret;
pub mod session;
pub mod sftp;
pub mod ssh;
pub mod terminal;
pub mod transfer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(code) = cli_probe() {
        std::process::exit(code);
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,shellora_lib=debug,russh=info".into()),
        )
        .with_target(true)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app::AppState::new())
        .setup(|app| {
            use tauri::Manager as _;
            let dir = app.path().app_data_dir()?;
            let db = db::Database::open(&paths::resolve_db_file(&dir))?;
            app.manage(db);
            tracing::info!(target: "app", "shellora starting");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::terminal_open,
            ipc::commands::terminal_input,
            ipc::commands::terminal_resize,
            ipc::commands::terminal_ack,
            ipc::commands::terminal_close,
            ipc::commands::terminal_retry,
            ipc::commands::terminal_state,
            ipc::commands::secret_probe,
            ipc::commands::conn_test,
            ipc::commands::knownhost_list,
            ipc::commands::knownhost_delete,
            ipc::commands::db_list_connections,
            ipc::commands::db_insert_connection,
            ipc::commands::db_delete_connection,
            ipc::commands::db_create_session,
            ipc::commands::db_list_sessions,
            ipc::commands::sftp_upload,
            ipc::commands::sftp_download,
            ipc::commands::sftp_mkdir,
            ipc::commands::sftp_rename,
            ipc::commands::sftp_remove,
            ipc::commands::sftp_list_dir,
            ipc::commands::sftp_cancel_list,
            ipc::commands::local_home,
            ipc::commands::local_list_dir,
            ipc::commands::local_remove,
            ipc::commands::local_mkdir,
            ipc::commands::local_rename,
            ipc::commands::transfer_enqueue,
            ipc::commands::transfer_pause,
            ipc::commands::transfer_resume,
            ipc::commands::transfer_cancel,
            ipc::commands::transfer_resolve,
            ipc::commands::transfer_list,
            ipc::commands::transfer_enqueue_tree,
            ipc::commands::transfer_pause_group,
            ipc::commands::transfer_resume_group,
            ipc::commands::transfer_cancel_group,
            ipc::commands::transfer_resolve_group,
            ipc::commands::transfer_list_groups,
            ipc::commands::data_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 安装包冒烟用的无窗口入口：`--version` / `--health-check` 在创建任何窗口前返回。
/// 版本号唯一来源是 `Cargo.toml`（`CARGO_PKG_VERSION`），`tauri.conf.json` 由
/// `scripts/check-version.mjs` 校验一致。
fn cli_probe() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("Shellora {}", env!("CARGO_PKG_VERSION"));
        return Some(0);
    }
    if args.iter().any(|a| a == "--health-check") {
        let db_path = std::env::temp_dir().join(format!("shellora-health-{}.db", std::process::id()));
        let (ok, detail) = match db::Database::open(&db_path) {
            Ok(db) => {
                drop(db);
                (true, "ok".to_string())
            }
            Err(err) => (false, err.to_string().replace('"', "'")),
        };
        // 先关闭再清理（Windows 下打开的文件无法删除）。
        for suffix in ["", "-wal", "-shm"] {
            let mut p = db_path.clone().into_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(p);
        }
        println!(
            r#"{{"ok":{ok},"product":"Shellora","version":"{}","db":"{detail}"}}"#,
            env!("CARGO_PKG_VERSION")
        );
        return Some(if ok { 0 } else { 1 });
    }
    None
}
