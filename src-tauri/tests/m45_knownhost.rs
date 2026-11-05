//! M4.5 无头验收：host key TOFU / known_hosts 校验。
//!
//! 覆盖：未知主机落库前拦截、确认后落库、指纹匹配放行、指纹变更阻断且不覆盖旧
//! 记录、删除记录后可重新信任、跳板与目标逐跳校验、系统 known_hosts（含 hashed
//! hostname 条目）、known_hosts 解析失败不阻断主流程。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use ssh_key::PublicKey;

use ssh_terminal_lib::db::Database;
use ssh_terminal_lib::ipc::dto::{ConnectionInput, JumpInput};
use ssh_terminal_lib::knownhost;
use ssh_terminal_lib::ssh;

const USER: &str = "alice";
const PASS: &str = "secret";

/// 同文件内多个用例都要拉起/关闭夹具，串行更稳定。
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Fixture {
    child: Child,
    port: u16,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
async fn start_fixture(port: u16, key_path: &Path) -> Fixture {
    let root = std::env::temp_dir().join(format!("sshtool-m45-{port}"));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create fixture root");

    let exe = env!("CARGO_BIN_EXE_fixture_sshd");
    let child = Command::new(exe)
        .env("FIXTURE_PORT", port.to_string())
        .env("FIXTURE_USER", USER)
        .env("FIXTURE_PASS", PASS)
        .env("FIXTURE_SFTP_ROOT", root.to_string_lossy().to_string())
        .env("FIXTURE_HOST_KEY", key_path.to_string_lossy().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn fixture_sshd");

    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Fixture { child, port };
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("fixture_sshd did not start on port {port}");
}

/// 生成（或读取）固定 host key，并返回其公钥；夹具会用同一路径的私钥。
fn host_key(tag: &str) -> (PathBuf, PublicKey) {
    let path = std::env::temp_dir().join(format!("sshtool-m45-hostkey-{tag}"));
    if !path.exists() {
        let mut rng = rand_core::OsRng;
        let mut key = russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519)
            .expect("generate host key");
        key.set_comment("m45-fixture");
        std::fs::write(
            &path,
            key.to_openssh(ssh_key::LineEnding::LF)
                .expect("encode host key")
                .as_bytes(),
        )
        .expect("write host key");
    }
    let text = std::fs::read_to_string(&path).expect("read host key");
    let key = russh::keys::decode_secret_key(&text, None).expect("decode host key");
    (path, key.public_key().clone())
}

fn overwrite_host_key(tag: &str) -> (PathBuf, PublicKey) {
    let path = std::env::temp_dir().join(format!("sshtool-m45-hostkey-{tag}"));
    let _ = std::fs::remove_file(&path);
    host_key(tag)
}

fn input(port: u16) -> ConnectionInput {
    ConnectionInput {
        host: "127.0.0.1".into(),
        port,
        username: USER.into(),
        password: PASS.into(),
        // 用例不依赖本机 ~/.ssh/known_hosts，显式关闭避免环境污染。
        use_system_known_hosts: false,
        ..ConnectionInput::default()
    }
}

fn jump(port: u16) -> JumpInput {
    JumpInput {
        host: "127.0.0.1".into(),
        port,
        username: USER.into(),
        password: PASS.into(),
        private_key: None,
        agent: None,
    }
}

fn blob(pubkey: &PublicKey) -> Vec<u8> {
    pubkey.to_bytes().expect("public key blob")
}

fn sha256(pubkey: &PublicKey) -> String {
    knownhost::fingerprints(pubkey).0
}

/// 把一套 host key 预先写入信任库，模拟“此前已确认”。
fn seed(db: &Database, port: u16, pubkey: &PublicKey) {
    let (fp, _) = knownhost::fingerprints(pubkey);
    db.upsert_known_host("127.0.0.1", port, pubkey.algorithm().as_str(), &blob(pubkey), &fp)
        .expect("seed known host");
}

#[tokio::test]
async fn m45_unknown_host_blocked_until_confirmed_then_persisted() {
    let _guard = SERIAL.lock().await;
    let (key_path, pubkey) = host_key("unknown");
    let fixture = start_fixture(2501, &key_path).await;
    let db = Database::open_memory().expect("db");

    let mut input = input(fixture.port);
    let err = ssh::probe(&input, Some(&db))
        .await
        .expect_err("未知主机在确认前必须阻断");
    assert_eq!(err.code, "HOSTKEY_UNKNOWN", "{err:?}");
    let details = err.details.as_ref().expect("应携带结构化指纹");
    assert_eq!(details["host"], "127.0.0.1");
    assert_eq!(details["port"], fixture.port);
    assert_eq!(details["keyType"], pubkey.algorithm().as_str());
    let fp = details["fingerprintSha256"].as_str().expect("sha256");
    assert_eq!(fp, sha256(&pubkey), "SHA256 指纹应带前缀且与夹具一致");
    let md5 = details["fingerprintMd5"].as_str().expect("md5");
    assert!(md5.starts_with("MD5:"), "MD5 指纹应带前缀: {md5}");
    assert!(err.message.contains("MD5:"), "提示中应同时展示两种指纹: {err:?}");

    assert!(
        db.list_known_hosts("127.0.0.1", fixture.port)
            .expect("list")
            .is_empty(),
        "用户确认前不得落库"
    );

    // 用户确认后：TOFU 落库并放行。
    input.trust_new_host_keys = true;
    ssh::probe(&input, Some(&db)).await.expect("确认后应放行");
    let rows = db
        .list_known_hosts("127.0.0.1", fixture.port)
        .expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].fingerprint_sha256, fp);
    assert_eq!(rows[0].key_type, pubkey.algorithm().as_str());
    assert_eq!(rows[0].public_key, blob(&pubkey));
}

#[tokio::test]
async fn m45_matching_fingerprint_is_allowed_without_prompt() {
    let _guard = SERIAL.lock().await;
    let (key_path, pubkey) = host_key("match");
    let fixture = start_fixture(2502, &key_path).await;
    let db = Database::open_memory().expect("db");
    seed(&db, fixture.port, &pubkey);

    let input = input(fixture.port);
    assert!(
        !input.trust_new_host_keys,
        "匹配路径不应依赖确认开关"
    );
    ssh::probe(&input, Some(&db)).await.expect("指纹匹配应直接放行");
    let rows = db
        .list_known_hosts("127.0.0.1", fixture.port)
        .expect("list");
    assert_eq!(rows.len(), 1, "匹配不应产生重复记录");
    assert!(rows[0].last_seen_at > 0);
}

#[tokio::test]
async fn m45_changed_fingerprint_blocks_and_keeps_old_record() {
    let _guard = SERIAL.lock().await;
    let (key_a, pub_a) = host_key("changed-a");
    let fixture = start_fixture(2503, &key_a).await;
    let db = Database::open_memory().expect("db");

    let mut input = input(fixture.port);
    input.trust_new_host_keys = true;
    ssh::probe(&input, Some(&db)).await.expect("首次信任");
    drop(fixture);

    // 同一端口换一把 host key：模拟中间人/主机重装。
    let (key_b, pub_b) = overwrite_host_key("changed-b");
    let fixture = start_fixture(2503, &key_b).await;
    assert_ne!(sha256(&pub_a), sha256(&pub_b));

    input.trust_new_host_keys = false;
    let err = ssh::probe(&input, Some(&db))
        .await
        .expect_err("指纹变更必须阻断");
    assert_eq!(err.code, "HOSTKEY_CHANGED", "{err:?}");
    assert!(err.message.contains("中间人"), "应提示中间人风险: {err:?}");
    assert!(err.message.contains("手动删除"), "应指引用户删除记录: {err:?}");
    let details = err.details.as_ref().expect("details");
    assert_eq!(details["fingerprintSha256"], sha256(&pub_b));
    assert_eq!(details["host"], "127.0.0.1");

    let rows = db
        .list_known_hosts("127.0.0.1", fixture.port)
        .expect("list");
    assert_eq!(rows.len(), 1, "变更不得插入新记录");
    assert_eq!(rows[0].fingerprint_sha256, sha256(&pub_a), "旧记录不得被覆盖");
    assert_eq!(rows[0].public_key, blob(&pub_a));
}

#[tokio::test]
async fn m45_delete_record_then_reconnect_retrusts() {
    let _guard = SERIAL.lock().await;
    let (key_a, pub_a) = host_key("delete-a");
    let fixture = start_fixture(2504, &key_a).await;
    let db = Database::open_memory().expect("db");
    let mut input = input(fixture.port);
    input.trust_new_host_keys = true;
    ssh::probe(&input, Some(&db)).await.expect("首次信任");
    drop(fixture);

    let (key_b, pub_b) = overwrite_host_key("delete-b");
    let fixture = start_fixture(2504, &key_b).await;
    input.trust_new_host_keys = false;
    let err = ssh::probe(&input, Some(&db))
        .await
        .expect_err("变更先阻断");
    assert_eq!(err.code, "HOSTKEY_CHANGED");

    let rows = db
        .list_known_hosts("127.0.0.1", fixture.port)
        .expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].fingerprint_sha256, sha256(&pub_a));
    db.delete_known_host(&rows[0].id).expect("delete");
    assert!(db
        .list_known_hosts("127.0.0.1", fixture.port)
        .expect("list")
        .is_empty());

    // 删除后回到“未知主机”，重新确认即可信任新密钥。
    let err = ssh::probe(&input, Some(&db))
        .await
        .expect_err("删除后应回到未知主机");
    assert_eq!(err.code, "HOSTKEY_UNKNOWN");
    input.trust_new_host_keys = true;
    ssh::probe(&input, Some(&db)).await.expect("重新信任后放行");
    let rows = db
        .list_known_hosts("127.0.0.1", fixture.port)
        .expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].fingerprint_sha256, sha256(&pub_b));
}

#[tokio::test]
async fn m45_each_hop_is_verified_independently() {
    let _guard = SERIAL.lock().await;
    let (jump_key, jump_pub) = host_key("hop-jump");
    let (target_key, target_pub) = host_key("hop-target");
    let _jump = start_fixture(2511, &jump_key).await;
    let target = start_fixture(2512, &target_key).await;
    let db = Database::open_memory().expect("db");

    let mut input = input(target.port);
    input.jumps = vec![jump(2511)];

    // 第一跳与目标都未知：先在第一跳被拦下。
    let err = ssh::probe(&input, Some(&db))
        .await
        .expect_err("第一跳未知应阻断");
    assert_eq!(err.code, "HOSTKEY_UNKNOWN");
    assert_eq!(err.details.as_ref().unwrap()["port"], 2511);

    // 只信任第一跳：目标仍未知，必须再次被拦。
    seed(&db, 2511, &jump_pub);
    let err = ssh::probe(&input, Some(&db))
        .await
        .expect_err("目标未知应阻断");
    assert_eq!(err.code, "HOSTKEY_UNKNOWN");
    assert_eq!(err.details.as_ref().unwrap()["port"], target.port);
    assert_eq!(
        err.details.as_ref().unwrap()["fingerprintSha256"],
        sha256(&target_pub)
    );

    // 两跳都已信任：整条链放行。
    seed(&db, target.port, &target_pub);
    ssh::probe(&input, Some(&db)).await.expect("逐跳校验通过后放行");
}

/// 生成 OpenSSH hashed hostname 字段：`|1|base64(salt)|base64(HMAC-SHA1(salt, host))`。
fn hashed_host(host: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;

    let salt = [0x11u8, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb];
    let mut mac = Hmac::<Sha1>::new_from_slice(&salt).expect("hmac");
    mac.update(host.as_bytes());
    let hash = mac.finalize().into_bytes();
    format!(
        "|1|{}|{}",
        data_encoding::BASE64.encode(&salt),
        data_encoding::BASE64.encode(&hash)
    )
}

fn write_known_hosts(name: &str, lines: &[String]) -> PathBuf {
    let path = std::env::temp_dir().join(format!("sshtool-m45-knownhosts-{name}"));
    std::fs::write(&path, lines.join("\n") + "\n").expect("write known_hosts");
    path
}

#[tokio::test]
async fn m45_system_known_hosts_hashed_entry_is_trusted() {
    let _guard = SERIAL.lock().await;
    let (key_path, pubkey) = host_key("sysfile");
    let fixture = start_fixture(2521, &key_path).await;
    let db = Database::open_memory().expect("db");

    // 非默认端口在 known_hosts 中以 `[host]:port` 形式出现（hashed 亦然）。
    let host_port = format!("[127.0.0.1]:{}", fixture.port);
    let path = write_known_hosts(
        "hashed",
        &[format!(
            "{} {}",
            hashed_host(&host_port),
            pubkey.to_openssh().expect("public key openssh")
        )],
    );

    let mut input = input(fixture.port);
    input.known_hosts_file = Some(path.to_string_lossy().to_string());
    input.use_system_known_hosts = true;
    assert!(!input.trust_new_host_keys, "仅靠 known_hosts 就应放行");
    ssh::probe(&input, Some(&db))
        .await
        .expect("hashed 条目应被解析并信任");
    assert!(
        db.list_known_hosts("127.0.0.1", fixture.port)
            .expect("list")
            .is_empty(),
        "系统 known_hosts 只读参考，不应回写数据库"
    );

    // 同一 host 条目但公钥不同：视为指纹变更，阻断。
    let (_, other_pub) = host_key("sysfile-other");
    let path = write_known_hosts(
        "hashed-mismatch",
        &[format!(
            "{} {}",
            hashed_host(&host_port),
            other_pub.to_openssh().expect("openssh")
        )],
    );
    input.known_hosts_file = Some(path.to_string_lossy().to_string());
    let err = ssh::probe(&input, Some(&db))
        .await
        .expect_err("known_hosts 中的密钥不一致应阻断");
    assert_eq!(err.code, "HOSTKEY_CHANGED", "{err:?}");
}

#[tokio::test]
async fn m45_known_hosts_parse_error_is_warning_only() {
    let _guard = SERIAL.lock().await;
    let (key_path, _pubkey) = host_key("badfile");
    let fixture = start_fixture(2522, &key_path).await;
    let db = Database::open_memory().expect("db");

    let path = write_known_hosts(
        "malformed",
        &[
            "this line is not a valid known_hosts entry".to_string(),
            "127.0.0.1 ssh-ed25519 !!!not-base64".to_string(),
        ],
    );
    let mut input = input(fixture.port);
    input.known_hosts_file = Some(path.to_string_lossy().to_string());
    input.use_system_known_hosts = true;

    // 解析失败不能变成 INTERNAL，仍按“未知主机”要求用户确认。
    let err = ssh::probe(&input, Some(&db))
        .await
        .expect_err("解析失败应按未知主机处理");
    assert_eq!(err.code, "HOSTKEY_UNKNOWN", "{err:?}");

    // 确认后主流程不受影响。
    input.trust_new_host_keys = true;
    ssh::probe(&input, Some(&db)).await.expect("确认后应放行");
}
