//! SQLite 持久层（迁移 v1：session / connection / credential_ref / known_host）。
//!
//! 说明：v1 只建 M1 需要的 4 张表，因此 `connection.proxy_hop_id` 与
//! `session.terminal_profile_id` 暂为普通 TEXT（v2 引入 proxy_hop / terminal_profile
//! 时再通过重建表补上外键），其余约束与 `docs/ARCHITECTURE_AND_MILESTONES.md` §2.3 一致。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("数据库错误: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("文件错误: {0}")]
    Io(#[from] std::io::Error),
}

pub type DbResult<T> = Result<T, DbError>;

pub const SCHEMA_VERSION: i64 = 2;

const MIGRATION_V1: &str = r#"
CREATE TABLE credential_ref (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('password','passphrase','key_file','agent_identity')),
  backend        TEXT NOT NULL CHECK (backend IN ('keychain','file','agent')),
  service        TEXT,
  account        TEXT,
  key_file_path  TEXT,
  has_passphrase INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE connection (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  host               TEXT NOT NULL,
  port               INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  username           TEXT NOT NULL,
  auth_kind          TEXT NOT NULL CHECK (auth_kind IN ('password','publickey','agent','keyboard-interactive')),
  credential_ref_id  TEXT REFERENCES credential_ref(id) ON DELETE SET NULL,
  proxy_mode         TEXT NOT NULL DEFAULT 'direct'
                     CHECK (proxy_mode IN ('direct','socks5','http_connect','jump')),
  proxy_hop_id       TEXT,
  keepalive_ms       INTEGER NOT NULL DEFAULT 30000,
  connect_timeout_ms INTEGER NOT NULL DEFAULT 15000,
  compression        INTEGER NOT NULL DEFAULT 0,
  algo_overrides     TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(name)
);

CREATE TABLE session (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  group_id            TEXT,
  terminal_profile_id TEXT,
  color_tag           TEXT,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  last_used_at        INTEGER,
  note                TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE known_host (
  id                 TEXT PRIMARY KEY,
  host               TEXT NOT NULL,
  port               INTEGER NOT NULL,
  key_type           TEXT NOT NULL,
  public_key         BLOB NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  trust              INTEGER NOT NULL DEFAULT 0 CHECK (trust IN (0,1,2)),
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  note               TEXT,
  UNIQUE (host, port, fingerprint_sha256)
);

CREATE INDEX idx_session_connection ON session(connection_id);
CREATE INDEX idx_known_host_lookup ON known_host(host, port);
"#;

/// v2：SFTP 传输任务（`.part` 文件 + 续传偏移）。偏移按连续完成的字节数存储。
const MIGRATION_V2: &str = r#"
CREATE TABLE transfer_job (
  id            TEXT PRIMARY KEY,
  direction     TEXT NOT NULL CHECK (direction IN ('upload','download')),
  tab_id        TEXT,
  remote_path   TEXT NOT NULL,
  local_path    TEXT NOT NULL,
  total_bytes   INTEGER NOT NULL DEFAULT 0,
  offset_bytes  INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'running'
                CHECK (state IN ('running','paused','done','failed')),
  error_code    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_transfer_job_key ON transfer_job(direction, remote_path, local_path);
CREATE INDEX idx_transfer_job_state ON transfer_job(state);
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRow {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: String,
    pub credential_ref_id: Option<String>,
    pub proxy_mode: String,
    pub keepalive_ms: i64,
    pub connect_timeout_ms: i64,
    pub compression: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewConnection {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: String,
    pub credential_ref_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub terminal_profile_id: Option<String>,
    pub color_tag: Option<String>,
    pub sort_order: i64,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostRow {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    /// 服务端公钥原始字节（OpenSSH 公钥 blob），用于精确比对。
    pub public_key: Vec<u8>,
    pub fingerprint_sha256: String,
    pub trust: i64,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJobRow {
    pub id: String,
    pub direction: String,
    pub tab_id: Option<String>,
    pub remote_path: String,
    pub local_path: String,
    pub total_bytes: i64,
    pub offset_bytes: i64,
    pub state: String,
    pub error_code: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 连接被 Arc 包裹，使传输队列等后台任务可以持有 `Database` 的克隆。
#[derive(Clone)]
pub struct Database {
    conn: std::sync::Arc<Mutex<Connection>>,
}

impl Database {
    /// 打开/创建数据库：WAL + 外键 + 迁移 + 迁移前自动备份。
    pub fn open(path: &Path) -> DbResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        let existing: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if existing > 0 && existing < SCHEMA_VERSION {
            let backup = path.with_extension(format!("v{existing}.bak"));
            std::fs::copy(path, backup)?;
        }
        Self::setup(conn)
    }

    pub fn open_memory() -> DbResult<Self> {
        Self::setup(Connection::open_in_memory()?)
    }

    fn setup(conn: Connection) -> DbResult<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let mut version = version;
        let upgraded = version < SCHEMA_VERSION;
        if version < 1 {
            conn.execute_batch(MIGRATION_V1)?;
            version = 1;
        }
        if version < 2 {
            conn.execute_batch(MIGRATION_V2)?;
            version = 2;
        }
        if upgraded {
            conn.pragma_update(None, "user_version", version)?;
        }
        Ok(Self {
            conn: std::sync::Arc::new(Mutex::new(conn)),
        })
    }

    /// 清理可重建数据（传输任务/断点）；返回删除行数。
    pub fn clear_cache(&self) -> DbResult<usize> {
        self.with(|conn| Ok(conn.execute("DELETE FROM transfer_job", [])?))
    }

    /// 全清业务数据并保留空 schema，应用重启后即为空库。
    ///
    /// 顺序按外键：session -> connection -> credential_ref，再清 known_host / transfer_job。
    pub fn clear_all_data(&self) -> DbResult<usize> {
        self.with(|conn| {
            let mut removed = 0;
            for sql in [
                "DELETE FROM session",
                "DELETE FROM connection",
                "DELETE FROM credential_ref",
                "DELETE FROM known_host",
                "DELETE FROM transfer_job",
            ] {
                removed += conn.execute(sql, [])?;
            }
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
            Ok(removed)
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> DbResult<T>) -> DbResult<T> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        f(&conn)
    }

    pub fn integrity_ok(&self) -> DbResult<bool> {
        self.with(|conn| {
            let res: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            Ok(res == "ok")
        })
    }

    pub fn schema_version(&self) -> DbResult<i64> {
        self.with(|conn| Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?))
    }

    pub fn insert_connection(&self, new: &NewConnection) -> DbResult<String> {
        let now = now_ms();
        let id = Uuid::now_v7().to_string();
        self.with(|conn| {
            conn.execute(
                "INSERT INTO connection
                 (id,name,host,port,username,auth_kind,credential_ref_id,proxy_mode,
                  keepalive_ms,connect_timeout_ms,compression,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'direct',30000,15000,0,?8,?8)",
                params![
                    id,
                    new.name,
                    new.host,
                    new.port,
                    new.username,
                    new.auth_kind,
                    new.credential_ref_id,
                    now
                ],
            )?;
            Ok(())
        })?;
        Ok(id)
    }

    pub fn list_connections(&self) -> DbResult<Vec<ConnectionRow>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,name,host,port,username,auth_kind,credential_ref_id,proxy_mode,
                        keepalive_ms,connect_timeout_ms,compression,created_at,updated_at
                 FROM connection ORDER BY name",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(ConnectionRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        host: r.get(2)?,
                        port: r.get(3)?,
                        username: r.get(4)?,
                        auth_kind: r.get(5)?,
                        credential_ref_id: r.get(6)?,
                        proxy_mode: r.get(7)?,
                        keepalive_ms: r.get(8)?,
                        connect_timeout_ms: r.get(9)?,
                        compression: r.get::<_, i64>(10)? != 0,
                        created_at: r.get(11)?,
                        updated_at: r.get(12)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn delete_connection(&self, id: &str) -> DbResult<usize> {
        self.with(|conn| Ok(conn.execute("DELETE FROM connection WHERE id = ?1", [id])?))
    }

    pub fn create_session(&self, connection_id: &str, name: &str) -> DbResult<String> {
        let now = now_ms();
        let id = Uuid::now_v7().to_string();
        self.with(|conn| {
            conn.execute(
                "INSERT INTO session
                 (id,connection_id,name,sort_order,created_at,updated_at)
                 VALUES (?1,?2,?3,0,?4,?4)",
                params![id, connection_id, name, now],
            )?;
            Ok(())
        })?;
        Ok(id)
    }

    pub fn list_sessions(&self) -> DbResult<Vec<SessionRow>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,connection_id,name,group_id,terminal_profile_id,color_tag,
                        sort_order,last_used_at,created_at,updated_at
                 FROM session ORDER BY sort_order, name",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(SessionRow {
                        id: r.get(0)?,
                        connection_id: r.get(1)?,
                        name: r.get(2)?,
                        group_id: r.get(3)?,
                        terminal_profile_id: r.get(4)?,
                        color_tag: r.get(5)?,
                        sort_order: r.get(6)?,
                        last_used_at: r.get(7)?,
                        created_at: r.get(8)?,
                        updated_at: r.get(9)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// 首次信任（TOFU）：同 host+port+指纹重复出现只更新 last_seen_at。
    pub fn upsert_known_host(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        public_key: &[u8],
        fingerprint: &str,
    ) -> DbResult<String> {
        let now = now_ms();
        let id = Uuid::now_v7().to_string();
        self.with(|conn| {
            conn.execute(
                "INSERT INTO known_host
                 (id,host,port,key_type,public_key,fingerprint_sha256,trust,first_seen_at,last_seen_at)
                 VALUES (?1,?2,?3,?4,?5,?6,1,?7,?7)
                 ON CONFLICT(host,port,fingerprint_sha256)
                 DO UPDATE SET last_seen_at = excluded.last_seen_at",
                params![id, host, port, key_type, public_key, fingerprint, now],
            )?;
            let found: Option<String> = conn
                .query_row(
                    "SELECT id FROM known_host WHERE host=?1 AND port=?2 AND fingerprint_sha256=?3",
                    params![host, port, fingerprint],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(found.unwrap_or(id))
        })
    }

    pub fn find_known_host(&self, host: &str, port: u16) -> DbResult<Option<KnownHostRow>> {
        self.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id,host,port,key_type,public_key,fingerprint_sha256,trust,
                            first_seen_at,last_seen_at
                     FROM known_host WHERE host=?1 AND port=?2 ORDER BY last_seen_at DESC LIMIT 1",
                    params![host, port],
                    known_host_row,
                )
                .optional()?)
        })
    }

    /// 列出某个主机的全部信任记录（同一 host+port 可能存在多种 key type）。
    pub fn list_known_hosts(&self, host: &str, port: u16) -> DbResult<Vec<KnownHostRow>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,host,port,key_type,public_key,fingerprint_sha256,trust,
                        first_seen_at,last_seen_at
                 FROM known_host WHERE host=?1 AND port=?2 ORDER BY last_seen_at DESC",
            )?;
            let rows = stmt
                .query_map(params![host, port], known_host_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// 列出全部信任记录（前端“已信任主机”管理用）。
    pub fn list_all_known_hosts(&self) -> DbResult<Vec<KnownHostRow>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,host,port,key_type,public_key,fingerprint_sha256,trust,
                        first_seen_at,last_seen_at
                 FROM known_host ORDER BY host, port, last_seen_at DESC",
            )?;
            let rows = stmt
                .query_map([], known_host_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// 删除一条信任记录。指纹变更后只能由用户手动删除再重连，绝不自动覆盖。
    pub fn delete_known_host(&self, id: &str) -> DbResult<usize> {
        self.with(|conn| Ok(conn.execute("DELETE FROM known_host WHERE id=?1", params![id])?))
    }

    /// 指纹匹配后刷新最近使用时间。
    pub fn touch_known_host(&self, id: &str) -> DbResult<()> {
        self.with(|conn| {
            conn.execute(
                "UPDATE known_host SET last_seen_at=?1 WHERE id=?2",
                params![now_ms(), id],
            )?;
            Ok(())
        })
    }

    /// D5：只读校验，绝不写 known_hosts 文件；数据库里的信任记录由 TOFU 首次写入。
    pub fn insert_credential_ref(
        &self,
        kind: &str,
        backend: &str,
        service: Option<&str>,
        account: Option<&str>,
    ) -> DbResult<String> {
        let now = now_ms();
        let id = Uuid::now_v7().to_string();
        self.with(|conn| {
            conn.execute(
                "INSERT INTO credential_ref
                 (id,kind,backend,service,account,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?6)",
                params![id, kind, backend, service, account, now],
            )?;
            Ok(())
        })?;
        Ok(id)
    }

    /// 按 (方向, 远端, 本地) 查找传输任务，用于断点续传。
    pub fn find_transfer_job(
        &self,
        direction: &str,
        remote_path: &str,
        local_path: &str,
    ) -> DbResult<Option<TransferJobRow>> {
        self.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id,direction,tab_id,remote_path,local_path,total_bytes,
                            offset_bytes,state,error_code,created_at,updated_at
                     FROM transfer_job WHERE direction=?1 AND remote_path=?2 AND local_path=?3",
                    params![direction, remote_path, local_path],
                    transfer_job_row,
                )
                .optional()?)
        })
    }

    pub fn get_transfer_job(&self, id: &str) -> DbResult<Option<TransferJobRow>> {
        self.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id,direction,tab_id,remote_path,local_path,total_bytes,
                            offset_bytes,state,error_code,created_at,updated_at
                     FROM transfer_job WHERE id=?1",
                    [id],
                    transfer_job_row,
                )
                .optional()?)
        })
    }

    /// 新建或复用同一 (方向, 远端, 本地) 的任务；复用时不重置已有续传偏移。
    pub fn upsert_transfer_job(
        &self,
        direction: &str,
        tab_id: Option<&str>,
        remote_path: &str,
        local_path: &str,
        total_bytes: i64,
    ) -> DbResult<String> {
        let now = now_ms();
        if let Some(row) = self.find_transfer_job(direction, remote_path, local_path)? {
            self.with(|conn| {
                conn.execute(
                    "UPDATE transfer_job
                     SET tab_id=?2,total_bytes=?3,state='running',error_code=NULL,updated_at=?4
                     WHERE id=?1",
                    params![row.id, tab_id, total_bytes, now],
                )?;
                Ok(())
            })?;
            return Ok(row.id);
        }
        let id = Uuid::now_v7().to_string();
        self.with(|conn| {
            conn.execute(
                "INSERT INTO transfer_job
                 (id,direction,tab_id,remote_path,local_path,total_bytes,offset_bytes,
                  state,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,0,'running',?7,?7)",
                params![id, direction, tab_id, remote_path, local_path, total_bytes, now],
            )?;
            Ok(())
        })?;
        Ok(id)
    }

    pub fn save_transfer_offset(&self, id: &str, offset_bytes: i64) -> DbResult<()> {
        self.with(|conn| {
            conn.execute(
                "UPDATE transfer_job SET offset_bytes=?2,updated_at=?3 WHERE id=?1",
                params![id, offset_bytes, now_ms()],
            )?;
            Ok(())
        })
    }

    pub fn finish_transfer_job(
        &self,
        id: &str,
        state: &str,
        offset_bytes: i64,
        error_code: Option<&str>,
    ) -> DbResult<()> {
        self.with(|conn| {
            conn.execute(
                "UPDATE transfer_job
                 SET state=?2,offset_bytes=?3,error_code=?4,updated_at=?5
                 WHERE id=?1",
                params![id, state, offset_bytes, error_code, now_ms()],
            )?;
            Ok(())
        })
    }
}

fn known_host_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<KnownHostRow> {
    Ok(KnownHostRow {
        id: r.get(0)?,
        host: r.get(1)?,
        port: r.get(2)?,
        key_type: r.get(3)?,
        public_key: r.get(4)?,
        fingerprint_sha256: r.get(5)?,
        trust: r.get(6)?,
        first_seen_at: r.get(7)?,
        last_seen_at: r.get(8)?,
    })
}

fn transfer_job_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TransferJobRow> {
    Ok(TransferJobRow {
        id: r.get(0)?,
        direction: r.get(1)?,
        tab_id: r.get(2)?,
        remote_path: r.get(3)?,
        local_path: r.get(4)?,
        total_bytes: r.get(5)?,
        offset_bytes: r.get(6)?,
        state: r.get(7)?,
        error_code: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(db: &Database) -> String {
        let id = db
            .insert_connection(&NewConnection {
                name: "smoke".into(),
                host: "127.0.0.1".into(),
                port: 22,
                username: "alice".into(),
                auth_kind: "password".into(),
                credential_ref_id: None,
            })
            .expect("insert connection");
        db.create_session(&id, "main").expect("create session");
        id
    }

    #[test]
    fn clear_cache_keeps_connections() {
        let db = Database::open_memory().expect("open");
        seed(&db);
        db.clear_cache().expect("clear cache");
        assert_eq!(db.list_connections().expect("list").len(), 1);
        assert_eq!(db.list_sessions().expect("sessions").len(), 1);
    }

    #[test]
    fn clear_all_data_leaves_empty_schema() {
        let db = Database::open_memory().expect("open");
        seed(&db);
        let removed = db.clear_all_data().expect("clear all");
        assert!(removed >= 2, "应删除连接与会话：{removed}");
        assert!(db.list_connections().expect("list").is_empty());
        assert!(db.list_sessions().expect("sessions").is_empty());
        // schema 仍在：同一个库还能继续写入。
        seed(&db);
        assert_eq!(db.list_connections().expect("list").len(), 1);
    }
}
