//! M1 持久层验收：迁移 v1、CRUD、唯一约束、级联删除、TOFU 去重、文件重开。

use ssh_terminal_lib::db::{Database, NewConnection, SCHEMA_VERSION};

fn temp_db_path() -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("ssht-m1-{nanos}.db"))
}

fn new_conn(name: &str, host: &str, port: u16) -> NewConnection {
    NewConnection {
        name: name.into(),
        host: host.into(),
        port,
        username: "alice".into(),
        auth_kind: "password".into(),
        credential_ref_id: None,
    }
}

#[test]
fn migration_sets_version_and_integrity() {
    let db = Database::open_memory().expect("open memory db");
    assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
    assert!(db.integrity_ok().unwrap());
}

#[test]
fn file_db_reopen_is_idempotent() {
    let path = temp_db_path();
    {
        let db = Database::open(&path).expect("open file db");
        db.insert_connection(&new_conn("prod", "10.0.0.1", 22))
            .expect("insert");
        assert!(db.integrity_ok().unwrap());
    }
    {
        let db = Database::open(&path).expect("reopen file db");
        assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(db.list_connections().unwrap().len(), 1, "重开不应重复迁移或丢数据");
    }
    std::fs::remove_file(&path).ok();
    std::fs::remove_file(path.with_extension("db-wal")).ok();
}

#[test]
fn connection_unique_name_and_crud() {
    let db = Database::open_memory().unwrap();
    let id = db.insert_connection(&new_conn("dev", "127.0.0.1", 2222)).unwrap();
    assert_eq!(db.list_connections().unwrap().len(), 1);

    let dup = db.insert_connection(&new_conn("dev", "127.0.0.2", 22));
    assert!(dup.is_err(), "name 唯一约束必须生效");

    assert_eq!(db.delete_connection(&id).unwrap(), 1);
    assert!(db.list_connections().unwrap().is_empty());
}

#[test]
fn session_cascades_with_connection() {
    let db = Database::open_memory().unwrap();
    let conn_id = db.insert_connection(&new_conn("box", "127.0.0.1", 2222)).unwrap();
    let s1 = db.create_session(&conn_id, "box-1").unwrap();
    let s2 = db.create_session(&conn_id, "box-2").unwrap();
    assert_eq!(db.list_sessions().unwrap().len(), 2);

    db.delete_connection(&conn_id).unwrap();
    let sessions = db.list_sessions().unwrap();
    assert!(sessions.is_empty(), "删除连接应级联删除会话");
    assert!(!sessions.iter().any(|s| s.id == s1 || s.id == s2));
}

#[test]
fn known_host_upsert_is_deduplicated() {
    let db = Database::open_memory().unwrap();
    let fp = "SHA256:fixture";
    let first = db
        .upsert_known_host("127.0.0.1", 2222, "ssh-ed25519", b"key", fp)
        .unwrap();
    let second = db
        .upsert_known_host("127.0.0.1", 2222, "ssh-ed25519", b"key", fp)
        .unwrap();
    assert_eq!(first, second, "同 host+port+指纹 只保留一条（首次信任后仅更新 last_seen_at）");
    assert_eq!(db.find_known_host("127.0.0.1", 2222).unwrap().unwrap().trust, 1);
    assert!(db.find_known_host("127.0.0.1", 22).unwrap().is_none());
}

#[test]
fn credential_ref_inserts() {
    let db = Database::open_memory().unwrap();
    let id = db
        .insert_credential_ref("password", "keychain", Some("com.example.sshtool"), Some("alice"))
        .unwrap();
    assert!(!id.is_empty());
    // 非法 backend 必须被 CHECK 拒绝。
    assert!(db.insert_credential_ref("password", "plaintext", None, None).is_err());
}

#[test]
fn transfer_job_upsert_keeps_resume_offset() {
    let db = Database::open_memory().unwrap();
    let id = db
        .upsert_transfer_job("download", Some("tab-1"), "/remote.bin", "local.bin", 1024)
        .unwrap();
    db.save_transfer_offset(&id, 512).unwrap();

    // 同一 (方向, 远端, 本地) 复用任务，不能把续传偏移重置为 0。
    let again = db
        .upsert_transfer_job("download", Some("tab-1"), "/remote.bin", "local.bin", 1024)
        .unwrap();
    assert_eq!(again, id);
    assert_eq!(db.get_transfer_job(&id).unwrap().unwrap().offset_bytes, 512);

    db.finish_transfer_job(&id, "done", 1024, None).unwrap();
    let row = db.get_transfer_job(&id).unwrap().unwrap();
    assert_eq!(row.state, "done");
    assert_eq!(row.offset_bytes, 1024);
}
