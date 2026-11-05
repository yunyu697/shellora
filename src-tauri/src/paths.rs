//! 数据目录解析：新品牌目录优先，旧品牌目录做一次性迁移。

use std::path::{Path, PathBuf};

pub const DB_FILE: &str = "shellora.db";

// 以下常量只用于迁移 v1.0.0（旧品牌）留下的数据，属于唯一的保留引用。
const LEGACY_DIR_NAME: &str = "com.sshtool.desktop";
const LEGACY_DB_FILE: &str = "sshtool.db";

/// 返回数据库文件全路径。
///
/// 规则：
/// 1. 新目录已有数据库 → 直接用新目录；
/// 2. 新目录没有、旧目录有 → 复制旧库（含 -wal/-shm）到新目录，成功后用新目录；
/// 3. 复制失败 → 回退读旧目录里的旧库，保证会话不丢；
/// 4. 两者都没有 → 用新目录（首次启动会建空库）。
pub fn resolve_db_file(new_dir: &Path) -> PathBuf {
    let new_db = new_dir.join(DB_FILE);
    if new_db.exists() {
        return new_db;
    }
    let Some(parent) = new_dir.parent() else {
        return new_db;
    };
    let legacy_db = parent.join(LEGACY_DIR_NAME).join(LEGACY_DB_FILE);
    if !legacy_db.exists() {
        return new_db;
    }
    match migrate(&legacy_db, &new_db) {
        Ok(()) => {
            tracing::info!(target: "app", from = %legacy_db.display(), to = %new_db.display(), "已迁移旧版数据目录");
            new_db
        }
        Err(err) => {
            tracing::warn!(target: "app", %err, path = %legacy_db.display(), "迁移失败，回退读旧目录");
            legacy_db
        }
    }
}

fn migrate(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(from, to)?;
    for suffix in ["-wal", "-shm"] {
        let src = suffixed(from, suffix);
        if src.exists() {
            std::fs::copy(&src, suffixed(to, suffix))?;
        }
    }
    Ok(())
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut p = path.as_os_str().to_os_string();
    p.push(suffix);
    PathBuf::from(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shellora-paths-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn empty_install_uses_new_dir() {
        let dir = root("empty");
        let new_dir = dir.join("com.shellora.desktop");
        let db = resolve_db_file(&new_dir);
        assert_eq!(db, new_dir.join(DB_FILE));
        assert!(!db.exists(), "首次启动前不应凭空生成数据库文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_legacy_database() {
        let dir = root("mig");
        let new_dir = dir.join("com.shellora.desktop");
        let legacy_dir = dir.join(LEGACY_DIR_NAME);
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let legacy_db = legacy_dir.join(LEGACY_DB_FILE);
        std::fs::write(&legacy_db, b"legacy-session-data").unwrap();
        std::fs::write(suffixed(&legacy_db, "-wal"), b"wal").unwrap();

        let db = resolve_db_file(&new_dir);
        assert_eq!(db, new_dir.join(DB_FILE));
        assert_eq!(std::fs::read(&db).unwrap(), b"legacy-session-data");
        assert_eq!(std::fs::read(suffixed(&db, "-wal")).unwrap(), b"wal");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn falls_back_to_legacy_when_migration_fails() {
        let dir = root("fallback");
        let legacy_dir = dir.join(LEGACY_DIR_NAME);
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let legacy_db = legacy_dir.join(LEGACY_DB_FILE);
        std::fs::write(&legacy_db, b"keep-me").unwrap();
        // 新目录位置被一个文件占用，create_dir_all 必然失败。
        let blocked = dir.join("com.shellora.desktop");
        std::fs::write(&blocked, b"x").unwrap();

        let db = resolve_db_file(&blocked);
        assert_eq!(db, legacy_db, "迁移失败时应回退读旧目录");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
